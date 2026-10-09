import { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import type { Job } from "@invai/contracts";
import { ORPCError } from "@orpc/server";
import {
  and,
  eq,
  getTableColumns,
  inArray,
  is,
  isNotNull,
  isNull,
  lt,
  ne,
  notLike,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { getTableConfig, type PgColumn, PgTable } from "drizzle-orm/pg-core";
import { systemContext, type TenantContext } from "../../api/context";
import { type Tx, withSystem, withTenant } from "../../db/client";
import * as schema from "../../db/schema";
import {
  addressVerifications,
  auditLog,
  buyerPii,
  channelConnections,
  companies,
  files,
  floorRequests,
  importRuns,
  invitations,
  jobs,
  listings,
  marketPriceSnapshots,
  members,
  orderItems,
  orders,
  PRIVACY_REQUEST_DUE_MS,
  type PrivacyCounts,
  privacyRequests,
  sessions,
  shipments,
} from "../../db/schema";
import type { PrivacyWebhookRequest } from "../../integrations/channels/types";
import { audit, systemActor } from "../../lib/audit";
import { notFound } from "../../lib/errors";
import { errorData, logger } from "../../lib/log";
import { bucket, deleteObject, deletePrefix, getObject, listObjects, s3 } from "../../lib/s3";
import { createJobRow, toJob, updateJobRow } from "../production/service";
import { createZip, ZipLimitError } from "./zip";

const log = logger("privacy");

/*
 * Channel privacy requests (Shopify compliance webhooks, B-06; playbook
 * `privacy-request-handling`). InvAI is the shop's processor for buyer data.
 * - customers/redact: that customer's orders from that store lose their buyer PII before the
 *   webhook is answered: `buyer_pii` rows deleted, buyer note and buyer reference cleared,
 *   personalization answers cleared, the encrypted raw payload deleted from storage. Non-personal
 *   order facts (ids, SKUs, amounts, dates, tracking) stay for the shop's accounting.
 * - shop/redact (48 h after uninstall): the same for every order from that store.
 * - customers/data_request: an open request for the owner to answer within 30 days.
 * Every request is recorded in `privacy_requests` per company, without PII. Idempotent: a
 * redelivery redacts nothing new and records nothing twice.
 * https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance
 */

export type PrivacyHandled = {
  handled: boolean;
  reason?: string;
  companyIds: string[];
  counts: PrivacyCounts;
};

const zero = (): PrivacyCounts => ({
  orders: 0,
  buyerPii: 0,
  rawPayloads: 0,
  personalizedItems: 0,
});

function add(a: PrivacyCounts, b: PrivacyCounts): PrivacyCounts {
  return {
    orders: a.orders + b.orders,
    buyerPii: a.buyerPii + b.buyerPii,
    rawPayloads: a.rawPayloads + b.rawPayloads,
    personalizedItems: a.personalizedItems + b.personalizedItems,
  };
}

/** The orders a request covers in one company: only orders imported from that store's connections. */
async function targetOrders(tx: Tx, connectionIds: string[], orderIds: string[] | "all") {
  if (orderIds !== "all" && orderIds.length === 0) return [];
  return tx
    .select({ id: orders.id, rawPayloadKey: orders.rawPayloadKey })
    .from(orders)
    .where(
      and(
        inArray(orders.connectionId, connectionIds),
        orderIds === "all" ? undefined : inArray(orders.channelOrderId, orderIds),
      ),
    );
}

/** Remove buyer PII from these orders (inside the tenant transaction). */
async function redactOrders(tx: Tx, ids: string[]): Promise<Omit<PrivacyCounts, "rawPayloads">> {
  if (ids.length === 0) return { orders: 0, buyerPii: 0, personalizedItems: 0 };
  const pii = await tx
    .delete(buyerPii)
    .where(inArray(buyerPii.orderId, ids))
    .returning({ id: buyerPii.id });
  await tx
    .update(orders)
    .set({ buyerNote: null, buyerRef: null, rawPayloadKey: null })
    .where(inArray(orders.id, ids));
  const items = await tx
    .select({ id: orderItems.id, personalization: orderItems.personalization })
    .from(orderItems)
    .where(inArray(orderItems.orderId, ids));
  let personalizedItems = 0;
  for (const item of items) {
    const answers = item.personalization ?? [];
    if (!answers.some((p) => p.answer !== null || p.fileUrl !== null)) continue;
    await tx
      .update(orderItems)
      .set({ personalization: answers.map((p) => ({ ...p, answer: null, fileUrl: null })) })
      .where(eq(orderItems.id, item.id));
    personalizedItems++;
  }
  return { orders: ids.length, buyerPii: pii.length, personalizedItems };
}

/**
 * Handle one verified compliance delivery. Routes by the shop domain from the signed body to
 * every company that has (or had) that store connected; a store we never connected is logged and
 * acknowledged. Throws on a storage or database failure so the delivery is retried.
 */
export async function handlePrivacyRequest(input: {
  channel: "shopify";
  shopDomain: string;
  deliveryId: string;
  request: PrivacyWebhookRequest;
}): Promise<PrivacyHandled> {
  const { channel, shopDomain, deliveryId, request } = input;
  const conns = await withSystem((tx) =>
    tx
      .select({ id: channelConnections.id, companyId: channelConnections.companyId })
      .from(channelConnections)
      .where(
        and(
          eq(channelConnections.channel, channel),
          eq(channelConnections.externalShopId, shopDomain),
          // Disconnected stores count: shop/redact arrives 48 h after uninstall.
          ne(channelConnections.status, "pending"),
        ),
      ),
  );
  if (conns.length === 0) {
    log.info("privacy request for a store we never connected", { topic: request.topic });
    return {
      handled: false,
      reason: "no connection for this store",
      companyIds: [],
      counts: zero(),
    };
  }
  const byCompany = new Map<string, string[]>();
  for (const c of conns) byCompany.set(c.companyId, [...(byCompany.get(c.companyId) ?? []), c.id]);

  let total = zero();
  const receivedAt = new Date();
  for (const [companyId, connectionIds] of byCompany) {
    const redact = request.topic !== "customers/data_request";
    let counts = zero();
    if (redact) {
      const scope = request.topic === "shop/redact" ? "all" : request.channelOrderIds;
      const found = await withTenant(companyId, (tx) => targetOrders(tx, connectionIds, scope));
      // Storage first: if a delete fails the webhook is retried while the keys are still known.
      const keys = found.map((o) => o.rawPayloadKey).filter((k): k is string => !!k);
      for (const key of keys) await deleteObject(key);
      counts = await withTenant(companyId, async (tx) => {
        const res = await redactOrders(
          tx,
          found.map((o) => o.id),
        );
        const c = { ...res, rawPayloads: keys.length };
        await audit(tx, {
          companyId,
          actor: systemContext(companyId).actor,
          action: "privacy.redacted",
          entityType: "channel_connection",
          entityId: connectionIds[0] ?? null,
          summary: `Shopify ${request.topic}: buyer data removed from ${c.orders} order(s)`,
          data: { deliveryId, ...c },
        });
        return c;
      });
    } else {
      await withTenant(companyId, (tx) =>
        audit(tx, {
          companyId,
          actor: systemContext(companyId).actor,
          action: "privacy.requested",
          entityType: "channel_connection",
          entityId: connectionIds[0] ?? null,
          summary: `Shopify customer data request for ${request.channelOrderIds.length} order(s); answer the store owner within 30 days`,
          data: { deliveryId, channelRequestId: request.channelRequestId },
        }),
      );
      log.warn("privacy data request received; the owner must answer it", {
        companyId,
        channelRequestId: request.channelRequestId,
      });
    }
    await withSystem((tx) =>
      tx
        .insert(privacyRequests)
        .values({
          companyId,
          connectionId: connectionIds[0] ?? null,
          channel,
          topic: request.topic,
          deliveryId,
          externalShopId: shopDomain,
          channelCustomerId: request.channelCustomerId,
          channelRequestId: request.channelRequestId,
          channelOrderIds: request.channelOrderIds,
          status: redact ? "completed" : "open",
          receivedAt,
          dueAt: new Date(receivedAt.getTime() + PRIVACY_REQUEST_DUE_MS),
          completedAt: redact ? new Date() : null,
          counts,
        })
        .onConflictDoNothing(),
    );
    total = add(total, counts);
  }
  log.info("privacy request handled", {
    topic: request.topic,
    companies: byCompany.size,
    ...total,
  });
  return { handled: true, companyIds: [...byCompany.keys()], counts: total };
}

/** Open requests older than 20 days (10 days before Shopify's 30-day deadline): warned daily. */
export const PRIVACY_WARN_AFTER_MS = 20 * 86400_000;

export async function warnOverduePrivacyRequests(now = new Date()) {
  const late = await withSystem((tx) =>
    tx
      .select({
        id: privacyRequests.id,
        companyId: privacyRequests.companyId,
        topic: privacyRequests.topic,
        dueAt: privacyRequests.dueAt,
      })
      .from(privacyRequests)
      .where(
        and(
          eq(privacyRequests.status, "open"),
          lt(privacyRequests.receivedAt, new Date(now.getTime() - PRIVACY_WARN_AFTER_MS)),
        ),
      ),
  );
  for (const r of late)
    log.error("privacy request still open after 20 days", {
      requestId: r.id,
      companyId: r.companyId,
      topic: r.topic,
      dueAt: r.dueAt.toISOString(),
    });
  return { overdue: late.length };
}

/* ==========================================================================================
 * Whole-company export, deletion and retention (B-23, wave 12 T-12-4). Owner only
 * (`org.export`, `org.delete`). No KMS: exports and purges run against the one bucket in
 * `lib/s3.ts` (MinIO locally).
 * ======================================================================================== */

/** The hard purge runs this long after the owner's deletion request (cancellable until then). */
export const HARD_PURGE_DELAY_MS = 30 * 86400_000;
/** Buyer PII on orders placed more than 18 calendar months ago is redacted by the daily sweep. */
export const BUYER_PII_RETENTION_MONTHS = 18;
/** `floor_requests` (idempotent floor command replies) are kept 30 days. */
export const FLOOR_REQUEST_RETENTION_MS = 30 * 86400_000;

/** The export zip's key: derived from its file id (= the job id), so a retry overwrites it. */
export const exportKey = (companyId: string, fileId: string) =>
  `${companyId}/tenant-export/${fileId}.zip`;

/**
 * Secrets never leave in an export: channel and supplier credentials, invite and station token
 * material, PIN hashes. Everything else in a company table is the company's own data.
 */
export const EXPORT_EXCLUDED_COLUMNS = new Set([
  "credentials",
  "apiKey",
  "inviteToken",
  "tokenHash",
  "pinHash",
  "secret",
]);
/** Stored objects not exported: encrypted raw channel payloads (the orders tables carry them). */
const EXPORT_SKIPPED_PREFIXES = ["raw/", "tenant-export/"];

type TenantTable = { name: string; table: PgTable; companyId: PgColumn; id: PgColumn | null };

let tenantTableCache: TenantTable[] | null = null;

/**
 * Every table with a `company_id`, children before parents (by foreign key), so a purge deletes
 * in an order no foreign key refuses. Built once from the Drizzle schema, so a new tenant table is
 * exported and purged without touching this module.
 */
export function tenantTables(): TenantTable[] {
  if (tenantTableCache) return tenantTableCache;
  const all = new Map<PgTable, TenantTable>();
  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) continue;
    const cols = getTableColumns(value) as Record<string, PgColumn>;
    if (!cols.companyId) continue;
    all.set(value, {
      name: getTableConfig(value).name,
      table: value,
      companyId: cols.companyId,
      id: cols.id ?? null,
    });
  }
  // parents(t) = tenant tables t references; a table is deleted once no remaining table points at it.
  const parents = new Map<PgTable, Set<PgTable>>();
  for (const t of all.keys()) {
    const refs = new Set<PgTable>();
    for (const fk of getTableConfig(t).foreignKeys) {
      const target = fk.reference().foreignTable;
      if (target !== t && all.has(target)) refs.add(target);
    }
    parents.set(t, refs);
  }
  const ordered: TenantTable[] = [];
  const left = new Set(all.keys());
  while (left.size) {
    const referenced = new Set<PgTable>();
    for (const t of left) for (const p of parents.get(t) ?? []) if (left.has(p)) referenced.add(p);
    let ready = [...left].filter((t) => !referenced.has(t));
    if (ready.length === 0) ready = [...left]; // a cycle: cascades or deferrable keys resolve it
    for (const t of ready) {
      ordered.push(all.get(t) as TenantTable);
      left.delete(t);
    }
  }
  tenantTableCache = ordered;
  return ordered;
}

/* ---- Export ------------------------------------------------------------------------------ */

function exportInProgress(jobId: string, startedAt: Date) {
  return new ORPCError("EXPORT_IN_PROGRESS", {
    status: 409,
    message: "An export is already running",
    data: { jobId, startedAt: startedAt.toISOString() },
  });
}

/**
 * Create the `tenant_export` job row (the caller enqueues after commit). One export at a time per
 * company: a transaction-scoped advisory lock serializes two concurrent triggers, so the second
 * sees the first's row and gets `EXPORT_IN_PROGRESS`.
 */
export async function requestExport(tx: Tx, ctx: TenantContext): Promise<Job> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`tenant_export:${ctx.companyId}`}, 0))`,
  );
  const [running] = await tx
    .select({ id: jobs.id, createdAt: jobs.createdAt })
    .from(jobs)
    .where(
      and(
        eq(jobs.companyId, ctx.companyId),
        eq(jobs.kind, "tenant_export"),
        inArray(jobs.status, ["queued", "running"]),
      ),
    )
    .limit(1);
  if (running) throw exportInProgress(running.id, running.createdAt);
  const row = await createJobRow(tx, ctx, "tenant_export", {});
  await audit(tx, {
    companyId: ctx.companyId,
    actor: ctx.actor,
    action: "tenant.export_requested",
    entityType: "job",
    entityId: row.id,
    summary: "Full company data export requested",
  });
  return toJob(row);
}

export async function exportStatus(tx: Tx, jobId: string): Promise<Job> {
  const [row] = await tx
    .select()
    .from(jobs)
    .where(and(eq(jobs.id, jobId), eq(jobs.kind, "tenant_export")))
    .limit(1);
  if (!row) throw notFound("job", jobId);
  return toJob(row);
}

/** Mark an export failed (enqueue failed, or a permanent failure in the job). */
export async function failExport(companyId: string, jobId: string, error: string) {
  await updateJobRow(companyId, jobId, { status: "failed", error, message: "Export failed" });
}

/** One CSV cell (RFC 4180). Text that a spreadsheet would run as a formula gets a leading `'`. */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s: string;
  if (v instanceof Date) s = v.toISOString();
  else if (typeof v === "object") s = JSON.stringify(v);
  else if (typeof v === "string") s = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  else s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const EXPORT_PAGE = 5_000;
const TEXT_EXT = /\.(csv|json|txt|svg|xml|html?)$/i;

/** Every row of one company table (tenant transaction, explicit company filter), secrets dropped. */
async function exportRows(companyId: string, t: TenantTable) {
  const keys = Object.keys(getTableColumns(t.table)).filter((k) => !EXPORT_EXCLUDED_COLUMNS.has(k));
  const rows: Record<string, unknown>[] = [];
  for (let offset = 0; ; offset += EXPORT_PAGE) {
    const page = await withTenant(companyId, (tx) =>
      tx
        .select()
        .from(t.table)
        .where(eq(t.companyId, companyId))
        .orderBy(t.id ?? t.companyId)
        .limit(EXPORT_PAGE)
        .offset(offset),
    );
    for (const r of page as Record<string, unknown>[])
      rows.push(Object.fromEntries(keys.map((k) => [k, r[k] ?? null])));
    if (page.length < EXPORT_PAGE) break;
  }
  return { keys, rows };
}

/**
 * Build the export zip for one `tenant_export` job: `tables/<table>.json` and `.csv` for every
 * company table, `files/<key>` for every stored object, `manifest.json` with the counts. Written to
 * a temp file, uploaded, recorded as a `files` row whose id is the job id, and put in
 * `jobs.resultIds`. Idempotent: a finished job is skipped, a retry overwrites the same key and row.
 */
export async function runTenantExport(companyId: string, jobId: string) {
  const [row] = await withTenant(companyId, (tx) =>
    tx
      .select()
      .from(jobs)
      .where(and(eq(jobs.id, jobId), eq(jobs.kind, "tenant_export")))
      .limit(1),
  );
  if (!row) return { skipped: "missing job row" };
  if (row.status === "done" || row.status === "failed") return { skipped: row.status };
  await updateJobRow(companyId, jobId, {
    status: "running",
    progress: 0,
    message: "Exporting tables",
  });

  const dir = await mkdtemp(join(tmpdir(), "invai-export-"));
  const path = join(dir, "export.zip");
  const zip = await createZip(path);
  try {
    const tables = tenantTables();
    const counts: Record<string, number> = {};
    for (const [i, t] of tables.entries()) {
      const { keys, rows } = await exportRows(companyId, t);
      counts[t.name] = rows.length;
      await zip.add(`tables/${t.name}.json`, Buffer.from(JSON.stringify(rows, null, 1)));
      const csv = [keys.join(","), ...rows.map((r) => keys.map((k) => csvCell(r[k])).join(","))];
      await zip.add(`tables/${t.name}.csv`, Buffer.from(`${csv.join("\r\n")}\r\n`));
      if (i % 10 === 9)
        await updateJobRow(companyId, jobId, { progress: (0.5 * (i + 1)) / tables.length });
    }
    const prefix = `${companyId}/`;
    const objects = (await listObjects(prefix)).filter(
      (o) => !EXPORT_SKIPPED_PREFIXES.some((p) => o.key.startsWith(prefix + p)),
    );
    await updateJobRow(companyId, jobId, { progress: 0.5, message: "Exporting files" });
    for (const [i, o] of objects.entries()) {
      const rel = o.key.slice(prefix.length);
      await zip.add(`files/${rel}`, await getObject(o.key), TEXT_EXT.test(rel));
      if (i % 25 === 24)
        await updateJobRow(companyId, jobId, { progress: 0.5 + (0.45 * (i + 1)) / objects.length });
    }
    await zip.add(
      "manifest.json",
      Buffer.from(
        JSON.stringify(
          {
            companyId,
            exportedAt: new Date().toISOString(),
            tables: counts,
            files: objects.length,
            excludedColumns: [...EXPORT_EXCLUDED_COLUMNS],
            notes:
              "One JSON and one CSV file per table (same rows). CSV text starting with = + - @ is prefixed with ' so spreadsheets do not run it. Secrets are not exported.",
          },
          null,
          2,
        ),
      ),
    );
    const size = await zip.finish();
    const key = exportKey(companyId, jobId);
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: createReadStream(path),
        ContentLength: size,
        ContentType: "application/zip",
      }),
    );
    await withTenant(companyId, (tx) =>
      tx
        .insert(files)
        .values({
          id: jobId,
          companyId,
          key,
          kind: "export",
          filename: `invai-export-${new Date().toISOString().slice(0, 10)}.zip`,
          contentType: "application/zip",
          sizeBytes: size,
          status: "ready",
          uploadedBy: row.createdBy,
        })
        .onConflictDoUpdate({ target: files.id, set: { sizeBytes: size, status: "ready" } }),
    );
    await updateJobRow(companyId, jobId, {
      status: "done",
      progress: 1,
      resultIds: [jobId],
      message: `Exported ${tables.length} tables and ${objects.length} files`,
    });
    log.info("tenant export done", { companyId, jobId, bytes: size, files: objects.length });
    return { fileId: jobId, bytes: size, tables: tables.length, files: objects.length };
  } catch (err) {
    await zip.abort();
    if (err instanceof ZipLimitError) {
      await failExport(companyId, jobId, err.message);
      return { failed: err.message };
    }
    throw err;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/* ---- Deletion ---------------------------------------------------------------------------- */

export type DeletionStatus = { status: "active" | "soft_deleted"; scheduledPurgeAt: string | null };

const purgeAt = (deletedAt: Date) => new Date(deletedAt.getTime() + HARD_PURGE_DELAY_MS);

export async function deletionStatus(tx: Tx, companyId: string): Promise<DeletionStatus> {
  const [c] = await tx
    .select({ deletedAt: companies.deletedAt })
    .from(companies)
    .where(eq(companies.id, companyId));
  if (!c) throw notFound("company", companyId);
  return c.deletedAt
    ? { status: "soft_deleted", scheduledPurgeAt: purgeAt(c.deletedAt).toISOString() }
    : { status: "active", scheduledPurgeAt: null };
}

/** Soft delete now; the caller schedules the hard purge (delayed job) after commit. */
export async function requestDeletion(
  tx: Tx,
  ctx: TenantContext,
  now = new Date(),
): Promise<{ scheduledPurgeAt: string }> {
  const [set] = await tx
    .update(companies)
    .set({ deletedAt: now })
    .where(
      and(eq(companies.id, ctx.companyId), isNull(companies.deletedAt), isNull(companies.purgedAt)),
    )
    .returning({ deletedAt: companies.deletedAt });
  if (!set?.deletedAt) {
    const current = await deletionStatus(tx, ctx.companyId);
    throw new ORPCError("DELETION_ALREADY_REQUESTED", {
      status: 409,
      message: "Deletion is already scheduled",
      data: { scheduledPurgeAt: current.scheduledPurgeAt ?? now.toISOString() },
    });
  }
  const scheduledPurgeAt = purgeAt(set.deletedAt).toISOString();
  await audit(tx, {
    companyId: ctx.companyId,
    actor: ctx.actor,
    action: "tenant.delete_requested",
    entityType: "company",
    entityId: ctx.companyId,
    summary: `Company deletion requested; everything is purged at ${scheduledPurgeAt} unless cancelled`,
    data: { scheduledPurgeAt },
  });
  return { scheduledPurgeAt };
}

/** Clear the soft delete while the purge hasn't run; the caller unschedules the job after commit. */
export async function cancelDeletion(tx: Tx, ctx: TenantContext): Promise<{ ok: true }> {
  const [row] = await tx
    .update(companies)
    .set({ deletedAt: null })
    .where(
      and(
        eq(companies.id, ctx.companyId),
        isNotNull(companies.deletedAt),
        isNull(companies.purgedAt),
      ),
    )
    .returning({ id: companies.id });
  if (!row)
    throw new ORPCError("NO_DELETION_PENDING", { status: 404, message: "No deletion is pending" });
  await audit(tx, {
    companyId: ctx.companyId,
    actor: ctx.actor,
    action: "tenant.delete_cancelled",
    entityType: "company",
    entityId: ctx.companyId,
    summary: "Company deletion cancelled",
  });
  return { ok: true };
}

export type PurgeResult =
  | { purged: false; reason: "missing" | "not_requested" | "not_due" }
  | { purged: true; alreadyPurged: boolean; rows: number; objects: number };

/**
 * The hard purge (cross-tenant job, owner connection, one company). Runs only when the company is
 * soft-deleted and 30 days have passed; a cancelled or not-yet-due request is a no-op, not an
 * error. In one transaction it deletes every row of every company table (the audit log keeps only
 * the `tenant.*` lifecycle rows), removes members and invitations, and leaves the company row as an
 * anonymized tombstone with `purgedAt`; then it deletes every stored object under the company's
 * prefix. Idempotent: a second run finds the tombstone and only repeats the storage sweep.
 * Other companies' rows are never touched: every statement filters on this company id.
 */
export async function hardPurgeCompany(companyId: string, now = new Date()): Promise<PurgeResult> {
  // withSystem: the purge job deletes from append-only tables (audit_log, transitions, ledger).
  const db = await withSystem(async (tx) => {
    const [c] = await tx
      .select({ deletedAt: companies.deletedAt, purgedAt: companies.purgedAt })
      .from(companies)
      .where(eq(companies.id, companyId))
      .for("update");
    if (!c) return { state: "missing" as const };
    if (c.purgedAt) return { state: "already" as const, rows: 0 };
    if (!c.deletedAt) return { state: "not_requested" as const };
    // One minute of slack for clock skew between the API that scheduled it and this worker.
    if (purgeAt(c.deletedAt).getTime() > now.getTime() + 60_000)
      return { state: "not_due" as const };
    let rows = 0;
    const counts: Record<string, number> = {};
    // Lets the append-only stock ledger trigger accept this company's DELETEs (migration 0026).
    await tx.execute(sql`select set_config('app.purge_company_id', ${companyId}, true)`);
    for (const t of tenantTables()) {
      const where: SQL | undefined =
        t.table === auditLog
          ? and(eq(auditLog.companyId, companyId), notLike(auditLog.action, "tenant.%"))
          : eq(t.companyId, companyId);
      const res = await tx.delete(t.table).where(where);
      const n = (res as unknown as { rowCount?: number | null }).rowCount ?? 0;
      if (n) counts[t.name] = n;
      rows += n;
    }
    await tx.delete(invitations).where(eq(invitations.organizationId, companyId));
    await tx.delete(members).where(eq(members.organizationId, companyId));
    await tx
      .update(sessions)
      .set({ activeOrganizationId: null })
      .where(eq(sessions.activeOrganizationId, companyId));
    await tx
      .update(companies)
      .set({
        name: "Deleted company",
        slug: `deleted-${companyId}`,
        logo: null,
        metadata: null,
        demoOwnerUserId: null,
        settings: {},
        purgedAt: now,
      })
      .where(eq(companies.id, companyId));
    await audit(tx, {
      companyId,
      actor: systemActor,
      action: "tenant.purged",
      entityType: "company",
      entityId: companyId,
      summary: `Company data purged: ${rows} rows`,
      data: { rows, tables: counts },
    });
    return { state: "purged" as const, rows };
  });
  if (db.state === "missing" || db.state === "not_requested" || db.state === "not_due")
    return { purged: false, reason: db.state };
  // Storage after the commit (no side effect inside a transaction); safe to repeat.
  const objects = await deletePrefix(`${companyId}/`);
  log.info("tenant hard purge", {
    companyId,
    rows: db.rows,
    objects,
    again: db.state === "already",
  });
  return { purged: true, alreadyPurged: db.state === "already", rows: db.rows, objects };
}

/** Soft-deleted companies whose purge is due but never ran (a lost delayed job): the sweep's backstop. */
export async function overduePurges(now = new Date()): Promise<string[]> {
  // withSystem: cross-tenant sweep, reads company ids only.
  const rows = await withSystem((tx) =>
    tx
      .select({ id: companies.id })
      .from(companies)
      .where(
        and(
          isNull(companies.purgedAt),
          lt(companies.deletedAt, new Date(now.getTime() - HARD_PURGE_DELAY_MS)),
        ),
      ),
  );
  return rows.map((r) => r.id);
}

/* ---- Retention sweeps -------------------------------------------------------------------- */

export function buyerPiiCutoff(now = new Date()): Date {
  const d = new Date(now);
  d.setUTCMonth(d.getUTCMonth() - BUYER_PII_RETENTION_MONTHS);
  return d;
}

/** Orders that still hold buyer PII of any kind. */
const holdsPii = or(
  isNotNull(orders.buyerNote),
  isNotNull(orders.buyerRef),
  isNotNull(orders.rawPayloadKey),
  sql`exists (select 1 from buyer_pii b where b.order_id = ${orders.id})`,
  sql`exists (select 1 from order_items i where i.order_id = ${orders.id}
    and jsonb_path_exists(i.personalization, '$[*] ? (@.answer != null || @.fileUrl != null)'))`,
);

const REDACT_BATCH = 500;

/**
 * Daily: buyer PII on orders placed more than 18 months ago is removed, independent of any export
 * or deletion (processor retention limit). Same redaction as a Shopify customers/redact: the
 * `buyer_pii` row, buyer note and reference, personalization answers and the raw payload go;
 * order facts (ids, SKUs, amounts, dates, item counts) stay. Company ids are read as system, the
 * work runs per company inside `withTenant`. Idempotent: a redacted order no longer matches.
 */
export async function redactStaleBuyerPii(now = new Date()) {
  const cutoff = buyerPiiCutoff(now);
  const stale = and(lt(orders.placedAt, cutoff), holdsPii);
  // withSystem: cross-tenant sweep, reads company ids only; the redaction runs in withTenant.
  const companyIds = await withSystem((tx) =>
    tx.selectDistinct({ companyId: orders.companyId }).from(orders).where(stale),
  );
  let total = 0;
  for (const { companyId } of companyIds) {
    for (;;) {
      const batch = await withTenant(companyId, (tx) =>
        tx
          .select({ id: orders.id, rawPayloadKey: orders.rawPayloadKey })
          .from(orders)
          .where(and(eq(orders.companyId, companyId), stale))
          .limit(REDACT_BATCH),
      );
      if (batch.length === 0) break;
      const keys = batch.map((o) => o.rawPayloadKey).filter((k): k is string => !!k);
      for (const key of keys) await deleteObject(key);
      await withTenant(companyId, async (tx) => {
        const res = await redactOrders(
          tx,
          batch.map((o) => o.id),
        );
        await audit(tx, {
          companyId,
          actor: systemActor,
          action: "privacy.redacted",
          entityType: "company",
          entityId: companyId,
          summary: `Retention: buyer data removed from ${res.orders} order(s) older than ${BUYER_PII_RETENTION_MONTHS} months`,
          data: { ...res, rawPayloads: keys.length, cutoff: cutoff.toISOString() },
        });
      });
      total += batch.length;
      if (batch.length < REDACT_BATCH) break;
    }
  }
  return { companies: companyIds.length, orders: total };
}

/** Daily: delete `floor_requests` older than 30 days (per company, inside `withTenant`). */
export async function purgeOldFloorRequests(now = new Date()) {
  const before = new Date(now.getTime() - FLOOR_REQUEST_RETENTION_MS);
  // withSystem: cross-tenant sweep, reads company ids only; the delete runs in withTenant.
  const companyIds = await withSystem((tx) =>
    tx
      .selectDistinct({ companyId: floorRequests.companyId })
      .from(floorRequests)
      .where(lt(floorRequests.createdAt, before)),
  );
  let deleted = 0;
  for (const { companyId } of companyIds) {
    const rows = await withTenant(companyId, (tx) =>
      tx
        .delete(floorRequests)
        .where(and(eq(floorRequests.companyId, companyId), lt(floorRequests.createdAt, before)))
        .returning({ id: floorRequests.id }),
    );
    deleted += rows.length;
  }
  return { companies: companyIds.length, deleted };
}

/* ---- Amazon non-PII retention (decision 0026, B-187) ------------------------------------- */

/** Order statuses the Amazon sweep may touch; open orders of any age are never swept. */
export const AMAZON_SWEEP_STATUSES = ["shipped", "delivered", "cancelled"] as const;
const AMAZON_MARKET_SOURCES = ["amazon_pricing", "amazon_brand_analytics"] as const;
const AMAZON_BATCH = 500;

/** Rows changed per table (a column set to null or its placeholder, or the row deleted). */
export type AmazonRowsCleared = {
  orders: number;
  order_items: number;
  shipments: number;
  address_verifications: number;
  import_runs: number;
  listings: number;
  market_price_snapshots: number;
};

export type AmazonRetentionResult = {
  companies: number;
  failedCompanies: number;
  orders: number;
  rowsCleared: AmazonRowsCleared;
};

const noRows = (): AmazonRowsCleared => ({
  orders: 0,
  order_items: 0,
  shipments: 0,
  address_verifications: 0,
  import_runs: 0,
  listings: 0,
  market_price_snapshots: 0,
});

function addRows(into: AmazonRowsCleared, from: AmazonRowsCleared) {
  for (const k of Object.keys(into) as (keyof AmazonRowsCleared)[]) into[k] += from[k];
}

/** Sales channel `amazon`, or last imported from an Amazon-format CSV on a generic connection. */
const isAmazonOrder = or(
  eq(orders.channel, "amazon"),
  sql`exists (select 1 from import_runs r where r.id = ${orders.importRunId} and r.format = 'amazon')`,
);

/** Orders that still hold a "drop" value (decision 0026): a swept order no longer matches. */
const holdsAmazonDropData = or(
  isNotNull(orders.shippingMethod),
  sql`exists (select 1 from order_items i where i.company_id = ${orders.companyId}
    and i.order_id = ${orders.id} and i.channel_listing_id is not null)`,
  sql`exists (select 1 from shipments s where s.company_id = ${orders.companyId}
    and s.order_id = ${orders.id} and s.tracking_push_error is not null)`,
  sql`exists (select 1 from address_verifications v where v.company_id = ${orders.companyId}
    and v.order_id = ${orders.id})`,
);

/** What the sweep selects, per table; each predicate excludes rows already swept. */
function amazonStale(cutoff: Date) {
  return {
    orders: and(
      isAmazonOrder,
      lt(orders.placedAt, cutoff),
      inArray(orders.status, [...AMAZON_SWEEP_STATUSES]),
      holdsAmazonDropData,
    ),
    importRuns: and(
      lt(importRuns.startedAt, cutoff),
      inArray(importRuns.status, ["completed", "failed"]),
      or(
        eq(importRuns.format, "amazon"),
        sql`exists (select 1 from channel_connections c where c.id = ${importRuns.connectionId}
          and c.channel = 'amazon')`,
      ),
      or(ne(importRuns.fileKey, ""), sql`${importRuns.errors} <> '[]'::jsonb`),
    ),
    listings: and(
      eq(listings.channel, "amazon"),
      lt(sql`coalesce(${listings.lastSyncedAt}, ${listings.updatedAt})`, cutoff),
      sql`${listings.raw} <> '{}'::jsonb`,
    ),
    snapshots: and(
      inArray(marketPriceSnapshots.source, [...AMAZON_MARKET_SOURCES]),
      lt(marketPriceSnapshots.asOf, cutoff),
    ),
  };
}
type AmazonStale = ReturnType<typeof amazonStale>;

const countAll = sql<number>`count(*)::int`;

/** Dry run: what one company's sweep would change. Reads only. */
async function countAmazonDrop(tx: Tx, companyId: string, w: AmazonStale) {
  const swept = and(eq(orders.companyId, companyId), w.orders);
  const sweptIds = tx.select({ id: orders.id }).from(orders).where(swept);
  const count = async (q: Promise<{ n: number }[]>) => Number((await q)[0]?.n ?? 0);
  const rows: AmazonRowsCleared = {
    orders: await count(
      tx
        .select({ n: countAll })
        .from(orders)
        .where(and(swept, isNotNull(orders.shippingMethod))),
    ),
    order_items: await count(
      tx
        .select({ n: countAll })
        .from(orderItems)
        .where(
          and(
            eq(orderItems.companyId, companyId),
            inArray(orderItems.orderId, sweptIds),
            isNotNull(orderItems.channelListingId),
          ),
        ),
    ),
    shipments: await count(
      tx
        .select({ n: countAll })
        .from(shipments)
        .where(
          and(
            eq(shipments.companyId, companyId),
            inArray(shipments.orderId, sweptIds),
            isNotNull(shipments.trackingPushError),
          ),
        ),
    ),
    address_verifications: await count(
      tx
        .select({ n: countAll })
        .from(addressVerifications)
        .where(
          and(
            eq(addressVerifications.companyId, companyId),
            inArray(addressVerifications.orderId, sweptIds),
          ),
        ),
    ),
    import_runs: await count(
      tx
        .select({ n: countAll })
        .from(importRuns)
        .where(and(eq(importRuns.companyId, companyId), w.importRuns)),
    ),
    listings: await count(
      tx
        .select({ n: countAll })
        .from(listings)
        .where(and(eq(listings.companyId, companyId), w.listings)),
    ),
    market_price_snapshots: await count(
      tx
        .select({ n: countAll })
        .from(marketPriceSnapshots)
        .where(and(eq(marketPriceSnapshots.companyId, companyId), w.snapshots)),
    ),
  };
  const orderCount = await count(tx.select({ n: countAll }).from(orders).where(swept));
  return { orders: orderCount, rows };
}

/**
 * One transaction of the sweep for one company: at most AMAZON_BATCH orders (row-locked), and as
 * many import runs, listings and price snapshots. Keep columns and `updated_at` are never written.
 */
async function sweepAmazonBatch(tx: Tx, companyId: string, w: AmazonStale) {
  const rows = noRows();
  const ids = (
    await tx
      .select({ id: orders.id })
      .from(orders)
      .where(and(eq(orders.companyId, companyId), w.orders))
      .orderBy(orders.id)
      .limit(AMAZON_BATCH)
      .for("update")
  ).map((r) => r.id);
  if (ids.length) {
    rows.orders = (
      await tx
        .update(orders)
        .set({ shippingMethod: null, updatedAt: sql`${orders.updatedAt}` })
        .where(and(inArray(orders.id, ids), isNotNull(orders.shippingMethod)))
        .returning({ id: orders.id })
    ).length;
    rows.order_items = (
      await tx
        .update(orderItems)
        .set({ channelListingId: null, updatedAt: sql`${orderItems.updatedAt}` })
        .where(
          and(
            eq(orderItems.companyId, companyId),
            inArray(orderItems.orderId, ids),
            isNotNull(orderItems.channelListingId),
          ),
        )
        .returning({ id: orderItems.id })
    ).length;
    rows.shipments = (
      await tx
        .update(shipments)
        .set({ trackingPushError: null, updatedAt: sql`${shipments.updatedAt}` })
        .where(
          and(
            eq(shipments.companyId, companyId),
            inArray(shipments.orderId, ids),
            isNotNull(shipments.trackingPushError),
          ),
        )
        .returning({ id: shipments.id })
    ).length;
    rows.address_verifications = (
      await tx
        .delete(addressVerifications)
        .where(
          and(
            eq(addressVerifications.companyId, companyId),
            inArray(addressVerifications.orderId, ids),
          ),
        )
        .returning({ id: addressVerifications.id })
    ).length;
  }
  const runIds = (
    await tx
      .select({ id: importRuns.id })
      .from(importRuns)
      .where(and(eq(importRuns.companyId, companyId), w.importRuns))
      .limit(AMAZON_BATCH)
      .for("update")
  ).map((r) => r.id);
  if (runIds.length)
    rows.import_runs = (
      await tx
        .update(importRuns)
        .set({ errors: [], fileKey: "", updatedAt: sql`${importRuns.updatedAt}` })
        .where(inArray(importRuns.id, runIds))
        .returning({ id: importRuns.id })
    ).length;
  const listingIds = (
    await tx
      .select({ id: listings.id })
      .from(listings)
      .where(and(eq(listings.companyId, companyId), w.listings))
      .limit(AMAZON_BATCH)
      .for("update")
  ).map((r) => r.id);
  if (listingIds.length)
    rows.listings = (
      await tx
        .update(listings)
        .set({ raw: {}, updatedAt: sql`${listings.updatedAt}` })
        .where(inArray(listings.id, listingIds))
        .returning({ id: listings.id })
    ).length;
  rows.market_price_snapshots = (
    await tx
      .delete(marketPriceSnapshots)
      .where(
        inArray(
          marketPriceSnapshots.id,
          tx
            .select({ id: marketPriceSnapshots.id })
            .from(marketPriceSnapshots)
            .where(and(eq(marketPriceSnapshots.companyId, companyId), w.snapshots))
            .limit(AMAZON_BATCH),
        ),
      )
      .returning({ id: marketPriceSnapshots.id })
  ).length;
  const more =
    ids.length === AMAZON_BATCH ||
    runIds.length === AMAZON_BATCH ||
    listingIds.length === AMAZON_BATCH ||
    rows.market_price_snapshots === AMAZON_BATCH;
  const changed = Object.values(rows).reduce((a, b) => a + b, 0);
  if (changed > 0)
    await audit(tx, {
      companyId,
      actor: systemActor,
      action: "privacy.amazon_retention",
      entityType: "company",
      entityId: companyId,
      summary: `Retention: Amazon data older than ${BUYER_PII_RETENTION_MONTHS} months cleared from ${ids.length} order(s)`,
      data: { orders: ids.length, rows },
    });
  return { orders: ids.length, rows, more, changed };
}

/**
 * Daily, after `redactStaleBuyerPii`: Amazon non-PII data older than 18 months (Amazon DPP,
 * decision 0026). Only orders placed before the cutoff and shipped, delivered or cancelled; open
 * orders and other channels are never touched, and no order, item or shipment row is deleted.
 * Money, dates, order numbers and line codes stay for the shop's books. Company ids are read as
 * system; the work runs per company inside `withTenant`; a failing company is logged and skipped.
 * `dryRun` returns the same counts and writes nothing.
 */
export async function sweepStaleAmazonData(
  now = new Date(),
  opts: { dryRun?: boolean } = {},
): Promise<AmazonRetentionResult> {
  const dryRun = opts.dryRun === true;
  const cutoff = buyerPiiCutoff(now);
  const w = amazonStale(cutoff);
  // withSystem: cross-tenant sweep, reads company ids only; every change runs in withTenant.
  const companyIds = await withSystem(async (tx) => {
    const lists = [
      await tx.selectDistinct({ id: orders.companyId }).from(orders).where(w.orders),
      await tx.selectDistinct({ id: importRuns.companyId }).from(importRuns).where(w.importRuns),
      await tx.selectDistinct({ id: listings.companyId }).from(listings).where(w.listings),
      await tx
        .selectDistinct({ id: marketPriceSnapshots.companyId })
        .from(marketPriceSnapshots)
        .where(w.snapshots),
    ];
    return [...new Set(lists.flat().map((r) => r.id))];
  });
  const rowsCleared = noRows();
  let orderTotal = 0;
  let failed = 0;
  for (const companyId of companyIds) {
    try {
      if (dryRun) {
        const c = await withTenant(companyId, (tx) => countAmazonDrop(tx, companyId, w));
        orderTotal += c.orders;
        addRows(rowsCleared, c.rows);
        continue;
      }
      for (;;) {
        const b = await withTenant(companyId, (tx) => sweepAmazonBatch(tx, companyId, w));
        orderTotal += b.orders;
        addRows(rowsCleared, b.rows);
        if (!b.more) break;
        // A full batch that changed nothing would select the same rows forever.
        if (b.changed === 0) throw new Error("Amazon retention batch changed nothing");
      }
    } catch (err) {
      failed++;
      log.error("amazon retention sweep failed for a company", { companyId, ...errorData(err) });
    }
  }
  const result = {
    companies: companyIds.length,
    failedCompanies: failed,
    orders: orderTotal,
    rowsCleared,
  };
  log.info("amazon retention sweep", { dryRun, cutoff: cutoff.toISOString(), ...result });
  return result;
}
