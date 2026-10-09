import type { CsvFormat, ImportReport, NormalizedOrder } from "@invai/contracts";
import { and, eq, inArray, lt } from "drizzle-orm";
import { z } from "zod";
import { systemContext, type TenantContext } from "../../api/context";
import { afterCommit, type Tx, withSystem, withTenant } from "../../db/client";
import {
  channelConnections,
  importRuns,
  jobs,
  orders,
  subscriptions,
  WEBHOOK_DELIVERY_RETENTION_MS,
  webhookDeliveries,
} from "../../db/schema";
import { env } from "../../env";
import {
  channelMocked,
  channelPendingApproval,
  getChannelAdapter,
  webhookAdapter,
  webhookDeliveryId,
} from "../../integrations/channels";
import { parseOrdersCsv } from "../../integrations/channels/csv";
import {
  exchangeShopifyCode,
  finishShopifyInstall,
  verifyOAuthQuery,
} from "../../integrations/channels/shopify";
import type {
  ChannelCredentials,
  FetchedOrder,
  HeaderBag,
  VerifyWebhookOptions,
  WebhookEvent,
} from "../../integrations/channels/types";
import { audit } from "../../lib/audit";
import { decryptJson, encryptField, encryptJson, safeEqual } from "../../lib/crypto";
import { badRequest, conflict, notFound, ORPCError } from "../../lib/errors";
import { errorData, logger } from "../../lib/log";
import { emit } from "../../lib/outbox";
import { defineJob, isFinalAttempt, onEvent, RETRY_BACKOFF } from "../../lib/queues";
import { publish } from "../../lib/realtime";
import { getObject, objectKey, putObject } from "../../lib/s3";
import { assertWithinPlan, effectiveStatus } from "../billing/service";
import { markFileReady } from "../files/service";
import { ingestChannelRefunds } from "../finance/refunds";
import { cancelFromChannel, importNormalizedOrders } from "../orders/import";
import { handlePrivacyRequest } from "../privacy/service";
import { isSampleWorkspace } from "../tenancy/demo-flag";
import {
  type ConnectionRow,
  channelWebhookUri,
  freshChannelConn,
  getConnectionRow,
  listImports,
  markConnection,
  shopifyConnectedElsewhere,
  toChannelConn,
  toImportReport,
} from "./service";

const log = logger("channels.sync");

const MAX_CSV_ROWS = 5_000;

async function checkPlan(tx: Tx, ctx: TenantContext, list: NormalizedOrder[], channel: string) {
  if (list.length === 0) return;
  const ids = list.map((o) => o.channelOrderId);
  const existing = await tx
    .select({ id: orders.channelOrderId })
    .from(orders)
    .where(
      and(
        eq(orders.channel, channel as ConnectionRow["channel"]),
        inArray(orders.channelOrderId, ids),
      ),
    );
  const fresh = new Set(ids).size - existing.length;
  if (fresh > 0) await assertWithinPlan(tx, ctx, "orders", fresh);
}

/* ------------------------------------ CSV import ------------------------------------ */

/**
 * Files with at most this many rows import inside the request (in short chunk transactions) and
 * answer with the finished report; larger ones answer at once with a `queued` report and run
 * as the `channels.importCsv` job (wave 3 architect review: sync-compatible for small files).
 */
export const CSV_INLINE_MAX_ROWS = 300;
/** Orders per chunk transaction: each chunk commits on its own, so no import holds one long lock. */
export const CSV_CHUNK_ORDERS = 100;

type ImportRunRow = typeof importRuns.$inferSelect;
type CsvJobInput = { importRunId: string; cursor: number };

/** The contract report of a run: `pending` shows as `queued`; `jobId` when it runs as a job. */
function csvImportReport(row: ImportRunRow, jobId: string | null): ImportReport {
  const report = toImportReport(row);
  const status =
    row.status === "pending" ? "queued" : row.status === "running" ? "running" : report.status;
  return { ...report, status, jobId };
}

/**
 * channels.importCsv. Validates and parses the file in the request (a wrong format fails at
 * once), checks the plan, records the run, then either imports it right here (small files) or
 * queues the job. The job row shares the run's id, so `jobId === importId` for queued imports.
 */
export async function importCsv(
  ctx: TenantContext,
  input: { id: string; fileKey: string; format: CsvFormat },
): Promise<ImportReport> {
  const start = await withTenant(ctx.companyId, async (tx) => {
    const conn = await getConnectionRow(tx, input.id);
    if (conn.status === "disconnected") throw conflict("This connection is disconnected");
    if (!input.fileKey.startsWith(`${ctx.companyId}/`)) throw notFound("file");
    const parsed = await readCsv(input.fileKey, input.format, conn.channel);
    await checkPlan(tx, ctx, parsed.orders, conn.channel);
    const inline = parsed.rowsTotal <= CSV_INLINE_MAX_ROWS;
    const [run] = await tx
      .insert(importRuns)
      .values({
        companyId: ctx.companyId,
        connectionId: conn.id,
        format: input.format,
        fileKey: input.fileKey,
        status: inline ? "running" : "pending",
        rowsTotal: parsed.rowsTotal,
        createdBy: ctx.userId,
      })
      .returning();
    if (!run) throw new Error("import run insert failed");
    if (!inline) {
      const jobInput: CsvJobInput = { importRunId: run.id, cursor: 0 };
      await tx.insert(jobs).values({
        id: run.id,
        companyId: ctx.companyId,
        kind: "csv_import",
        status: "queued",
        message: `Queued: ${parsed.rowsTotal} rows`,
        input: jobInput,
        createdBy: ctx.userId,
      });
      await emit(tx, ctx.companyId, "channels.import_requested", { importRunId: run.id });
    }
    return { run, inline, parsed };
  });
  if (!start.inline) return csvImportReport(start.run, start.run.id);
  try {
    return await runCsvImport(ctx, start.run.id, start.parsed);
  } catch (err) {
    await failCsvImport(ctx.companyId, start.run.id, err);
    throw err;
  }
}

async function readCsv(fileKey: string, format: CsvFormat, channel: ConnectionRow["channel"]) {
  let text: string;
  try {
    text = (await getObject(fileKey)).toString("utf8");
  } catch {
    throw notFound("file");
  }
  let parsed: ReturnType<typeof parseOrdersCsv>;
  try {
    parsed = parseOrdersCsv(format, text, channel);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ORPCError("CSV_UNREADABLE", {
      status: 422,
      message: "The file is not a CSV in the chosen format",
      data: { detail },
    });
  }
  if (parsed.rowsTotal > MAX_CSV_ROWS)
    throw new ORPCError("CSV_UNREADABLE", {
      status: 422,
      message: "The file is not a CSV in the chosen format",
      data: {
        detail: `${parsed.rowsTotal} rows; split the export into files of ${MAX_CSV_ROWS} rows or fewer`,
      },
    });
  return parsed;
}

async function publishCsvProgress(companyId: string, row: typeof jobs.$inferSelect | undefined) {
  if (!row) return;
  await publish(companyId, "job.progress", {
    jobId: row.id,
    kind: row.kind,
    status: row.status,
    progress: row.progress,
    message: row.message,
    resultIds: row.resultIds,
  });
}

/**
 * Import a recorded run in chunks of CSV_CHUNK_ORDERS orders, each in its own short tenant
 * transaction that also advances the run's counts and (for a job) the cursor, so a crashed or
 * retried job resumes after the last committed chunk and counts every order once. Re-running a
 * finished run returns its report. Personalized artwork is queued by the mapping and rendered
 * by its own job after each chunk commits.
 */
async function runCsvImport(
  ctx: TenantContext,
  runId: string,
  preParsed?: ReturnType<typeof parseOrdersCsv>,
): Promise<ImportReport> {
  const { companyId } = ctx;
  const load = await withTenant(companyId, async (tx) => {
    const [run] = await tx.select().from(importRuns).where(eq(importRuns.id, runId)).limit(1);
    if (!run) throw notFound("import", runId);
    const [job] = await tx.select().from(jobs).where(eq(jobs.id, runId)).limit(1);
    const conn = await getConnectionRow(tx, run.connectionId);
    return { run, job: job ?? null, conn };
  });
  const jobId = load.job?.id ?? null;
  if (load.run.status === "completed" || load.run.status === "failed")
    return csvImportReport(load.run, jobId);
  const { conn } = load;
  const parsed = preParsed ?? (await readCsv(load.run.fileKey, load.run.format, conn.channel));
  const parseErrorRows = new Set(parsed.errors.map((e) => e.row));
  let cursor = (load.job?.input as CsvJobInput | null)?.cursor ?? 0;
  const total = parsed.orders.length;
  const progressOf = (done: number) => (total ? Math.min(0.99, done / total) : 0.99);

  if (cursor === 0) {
    const row = await withTenant(companyId, async (tx) => {
      await tx
        .update(importRuns)
        .set({
          status: "running",
          errors: parsed.errors.slice(0, 500),
          rowsFailed: parseErrorRows.size,
        })
        .where(eq(importRuns.id, runId));
      if (!jobId) return undefined;
      const [j] = await tx
        .update(jobs)
        .set({ status: "running", progress: 0, message: `Importing ${total} orders` })
        .where(eq(jobs.id, jobId))
        .returning();
      return j;
    });
    await publishCsvProgress(companyId, row);
  }

  while (cursor < total) {
    const from = cursor;
    const slice = parsed.orders.slice(from, from + CSV_CHUNK_ORDERS);
    const jobRow = await withTenant(companyId, async (tx) => {
      const [run] = await tx
        .select()
        .from(importRuns)
        .where(eq(importRuns.id, runId))
        .for("update");
      if (!run) throw notFound("import", runId);
      // Marked failed meanwhile (a duplicate run's last attempt, the worker's failure hook): stop.
      if (run.status !== "running") throw new Error(`import ${runId} is ${run.status}; stopping`);
      if (jobId) {
        // Another run of this job got here first (a stalled job picked up twice): stop.
        const [j] = await tx.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
        if (((j?.input as CsvJobInput | null)?.cursor ?? 0) !== from)
          throw new Error(`import ${runId}: chunk at ${from} already applied`);
      }
      const res = await importNormalizedOrders(tx, ctx, conn, slice, {
        source: "csv",
        importRunId: runId,
      });
      // T-7-2: refunds the file lists for this chunk's orders (dated ledger, upserted).
      const sliceIds = new Set(slice.map((o) => o.channelOrderId));
      const sliceRefunds = (parsed.refunds ?? []).filter((r) => sliceIds.has(r.channelOrderId));
      if (sliceRefunds.length)
        await ingestChannelRefunds(tx, companyId, conn.channel, "csv", sliceRefunds);
      const chunkErrors = res.errors.map((e) => ({
        row: parsed.orderRows[from + e.index] ?? 1,
        message: `Order ${e.channelOrderId ?? "?"}: ${e.message}`,
      }));
      const newRows = new Set(chunkErrors.map((e) => e.row).filter((r) => !parseErrorRows.has(r)));
      await tx
        .update(importRuns)
        .set({
          ordersImported: run.ordersImported + res.imported,
          ordersUpdated: run.ordersUpdated + res.updated,
          ordersSkipped: run.ordersSkipped + res.skipped,
          rowsFailed: run.rowsFailed + newRows.size,
          itemsNeedingMapping: run.itemsNeedingMapping + res.itemsNeedingMapping,
          errors: [...run.errors, ...chunkErrors].slice(0, 500),
          orderIds: [...run.orderIds, ...res.orderIds],
        })
        .where(eq(importRuns.id, runId));
      if (!jobId) return undefined;
      const next = from + slice.length;
      const [j] = await tx
        .update(jobs)
        .set({
          input: { importRunId: runId, cursor: next } satisfies CsvJobInput,
          progress: progressOf(next),
          message: `Imported ${next} of ${total} orders`,
        })
        .where(eq(jobs.id, jobId))
        .returning();
      return j;
    });
    cursor = from + slice.length;
    await publishCsvProgress(companyId, jobRow);
  }

  const out = await withTenant(companyId, async (tx) => {
    const [run] = await tx.select().from(importRuns).where(eq(importRuns.id, runId)).for("update");
    if (!run) throw notFound("import", runId);
    if (run.status !== "running") return { done: run, jobRow: undefined, cancelled: 0 };
    // T-7-4: line cancels and holds (TikTok "On hold", buyer cancel requests) after the orders.
    const cancelled =
      parsed.cancelledChannelOrderIds.length ||
      parsed.cancelledLines?.length ||
      parsed.holds?.length
        ? (
            await importNormalizedOrders(tx, ctx, conn, [], {
              source: "csv",
              importRunId: runId,
              cancelledChannelOrderIds: parsed.cancelledChannelOrderIds,
              cancelledLines: parsed.cancelledLines,
              holds: parsed.holds,
            })
          ).cancelled
        : 0;
    const errors = [...run.errors].sort((a, b) => a.row - b.row);
    const [done] = await tx
      .update(importRuns)
      .set({ status: "completed", errors, finishedAt: new Date() })
      .where(eq(importRuns.id, runId))
      .returning();
    if (!done) throw new Error("import run update failed");
    await markConnection(tx, conn.id, { kind: "import" });
    await markFileReady(tx, run.fileKey);
    await audit(tx, {
      companyId,
      actor: ctx.actor,
      action: "channel.import",
      entityType: "channel_connection",
      entityId: conn.id,
      summary: `${run.format} CSV: ${done.ordersImported} new, ${done.ordersUpdated} updated, ${done.ordersSkipped} unchanged, ${done.errors.length} error(s)`,
      data: { importId: runId },
    });
    await emit(tx, companyId, "import.completed", {
      importId: runId,
      connectionId: conn.id,
      orderIds: done.orderIds,
    });
    let jobRow: typeof jobs.$inferSelect | undefined;
    if (jobId)
      [jobRow] = await tx
        .update(jobs)
        .set({
          status: "done",
          progress: 1,
          message: `${done.ordersImported} new, ${done.ordersUpdated} updated, ${done.ordersSkipped} unchanged, ${done.rowsFailed} row(s) failed`,
          finishedAt: new Date(),
        })
        .where(eq(jobs.id, jobId))
        .returning();
    afterCommit(tx, async () => {
      await publish(companyId, "import.completed", {
        importId: runId,
        connectionId: conn.id,
        ordersImported: done.ordersImported,
        rowsFailed: done.errors.length,
      });
      await publish(companyId, "today.changed", { reason: "import" });
    });
    return { done, jobRow, cancelled };
  });
  await publishCsvProgress(companyId, out.jobRow);
  return csvImportReport(out.done, jobId);
}

/** Mark a run (and its job row) failed; chunks already committed stay imported and counted. */
async function failCsvImport(companyId: string, runId: string, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  log.error("csv import failed", { companyId, importId: runId, error: message });
  const jobRow = await withTenant(companyId, async (tx) => {
    const [run] = await tx.select().from(importRuns).where(eq(importRuns.id, runId)).for("update");
    if (!run || run.status === "completed" || run.status === "failed") return undefined;
    await tx
      .update(importRuns)
      .set({
        status: "failed",
        errors: [
          ...run.errors,
          { row: 0, message: "The import stopped before the end; rows after this were not read" },
        ].slice(0, 501),
        finishedAt: new Date(),
      })
      .where(eq(importRuns.id, runId));
    const [j] = await tx
      .update(jobs)
      .set({ status: "failed", progress: 1, error: message, finishedAt: new Date() })
      .where(eq(jobs.id, runId))
      .returning();
    return j;
  });
  await publishCsvProgress(companyId, jobRow);
}

/**
 * The `channels.importCsv` job for files over CSV_INLINE_MAX_ROWS. Bulk work: low priority on
 * the sync queue. Retries resume from the committed cursor; the last attempt marks it failed.
 */
export const importCsvJob = defineJob({
  queue: "sync",
  name: "channels.importCsv",
  input: z.object({ companyId: z.uuid(), importRunId: z.uuid() }),
  jobId: (i) => `import-csv-${i.importRunId}`,
  options: { attempts: 5, backoff: RETRY_BACKOFF, priority: 10 },
  // BullMQ gave up without the handler's last attempt (stalled too often): fail the run too.
  onFinalFailure: ({ companyId, importRunId }, error) =>
    failCsvImport(companyId, importRunId, new Error(error)),
  handler: async ({ companyId, importRunId }, job) => {
    const [run] = await withTenant(companyId, (tx) =>
      tx
        .select({ createdBy: importRuns.createdBy })
        .from(importRuns)
        .where(eq(importRuns.id, importRunId))
        .limit(1),
    );
    const ctx = { ...systemContext(companyId), userId: run?.createdBy ?? null };
    try {
      const report = await runCsvImport(ctx, importRunId);
      return { status: report.status, ordersImported: report.ordersImported };
    } catch (err) {
      if (isFinalAttempt(job)) await failCsvImport(companyId, importRunId, err);
      else
        log.warn("csv import chunk failed, will retry", {
          companyId,
          importRunId,
          ...errorData(err),
        });
      throw err;
    }
  },
});

onEvent("channels.import_requested", importCsvJob, (e) => ({
  companyId: e.companyId,
  importRunId: String(e.payload.importRunId),
}));

/** channels.imports: the connection's runs, with `queued`/`running` and the job id where one exists. */
export async function listCsvImports(
  tx: Tx,
  ctx: TenantContext,
  input: Parameters<typeof listImports>[2],
) {
  const page = await listImports(tx, ctx, input);
  const ids = page.items.map((r) => r.importId);
  if (!ids.length) return page;
  const [runs, jobRows] = await Promise.all([
    tx
      .select({ id: importRuns.id, status: importRuns.status })
      .from(importRuns)
      .where(inArray(importRuns.id, ids)),
    tx.select({ id: jobs.id }).from(jobs).where(inArray(jobs.id, ids)),
  ]);
  const statusOf = new Map(runs.map((r) => [r.id, r.status]));
  const hasJob = new Set(jobRows.map((j) => j.id));
  return {
    ...page,
    items: page.items.map((r): ImportReport => {
      const s = statusOf.get(r.importId);
      return {
        ...r,
        status: s === "pending" ? "queued" : s === "running" ? "running" : r.status,
        jobId: hasJob.has(r.importId) ? r.importId : null,
      };
    }),
  };
}

/* ------------------------------------ API sync ------------------------------------ */

export async function startSync(tx: Tx, ctx: TenantContext, connectionId: string) {
  const conn = await getConnectionRow(tx, connectionId);
  if (conn.mode !== "api")
    throw new ORPCError("NOT_API_CONNECTION", {
      status: 400,
      message: "CSV connections cannot sync",
    });
  if (conn.status === "disconnected" || conn.status === "pending")
    throw conflict(`The connection is ${conn.status}; reconnect it first`);
  const [job] = await tx
    .insert(jobs)
    .values({
      companyId: ctx.companyId,
      kind: "sync",
      status: "queued",
      input: { connectionId },
      createdBy: ctx.userId,
    })
    .returning({ id: jobs.id });
  if (!job) throw new Error("job insert failed");
  afterCommit(tx, async () => {
    const { syncConnectionJob } = await import("./jobs");
    await syncConnectionJob.enqueue({ companyId: ctx.companyId, connectionId, jobId: job.id });
  });
  return { jobId: job.id };
}

async function setJob(
  companyId: string,
  jobId: string | null | undefined,
  patch: Partial<typeof jobs.$inferInsert>,
) {
  if (!jobId) return;
  const [row] = await withTenant(companyId, (tx) =>
    tx.update(jobs).set(patch).where(eq(jobs.id, jobId)).returning(),
  );
  if (row)
    await publish(companyId, "job.progress", {
      jobId,
      kind: row.kind,
      status: row.status,
      progress: row.progress,
      message: row.message,
      resultIds: row.resultIds,
    });
}

/**
 * Pull new orders from an API connection and import them. The network call runs outside any
 * transaction; the import runs in one tenant transaction and advances the cursor with it.
 */
export async function syncConnection(
  companyId: string,
  connectionId: string,
  jobId?: string | null,
) {
  const ctx = systemContext(companyId);
  const conn = await withTenant(companyId, (tx) => getConnectionRow(tx, connectionId));
  // B-261: a poll tick can sit queued for minutes; the setting is read now, not at enqueue.
  // Manual syncs (they carry a jobId) are the shop asking, so they still run.
  if (!jobId && (conn.settings as { autoImport?: boolean } | null)?.autoImport === false) {
    log.debug("poll sync skipped: auto-import is off", { companyId, connectionId });
    return { imported: 0, skipped: true };
  }
  if (conn.mode !== "api" || conn.status === "disconnected" || conn.status === "pending") {
    await setJob(companyId, jobId, {
      status: "done",
      progress: 1,
      message: "Nothing to sync",
      finishedAt: new Date(),
    });
    return { imported: 0, skipped: true };
  }
  await setJob(companyId, jobId, { status: "running", progress: 0.1, message: "Fetching orders" });
  const adapter = await getChannelAdapter(conn.channel, conn.provider, conn);
  try {
    const fetched = await adapter.fetchOrders(await freshChannelConn(conn));
    const res = await withTenant(companyId, async (tx) => {
      await checkPlan(tx, ctx, fetched.orders, conn.channel);
      const out = await importNormalizedOrders(tx, ctx, conn, fetched.orders, {
        source: "api",
        cancelledChannelOrderIds: fetched.cancelledChannelOrderIds,
        cancelledLines: fetched.cancelledLines,
        holds: fetched.holds,
      });
      // T-7-2: refunds after the sale (dated ledger, upserted by channel refund id).
      if (fetched.refunds?.length)
        await ingestChannelRefunds(tx, companyId, conn.channel, "shopify", fetched.refunds);
      await markConnection(tx, conn.id, { kind: "poll", cursor: fetched.nextCursor });
      if (conn.status === "error")
        await tx
          .update(channelConnections)
          .set({ status: "connected" })
          .where(eq(channelConnections.id, conn.id));
      if (out.imported || out.updated)
        afterCommit(tx, async () => {
          await publish(companyId, "today.changed", { reason: "sync" });
        });
      return out;
    });
    await setJob(companyId, jobId, {
      status: "done",
      progress: 1,
      message: `${res.imported} new, ${res.updated} updated, ${res.cancelled} cancelled`,
      resultIds: res.orderIds.slice(0, 100),
      finishedAt: new Date(),
    });
    await publish(companyId, "connection.health", { connectionId, ok: true });
    return res;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn("sync failed", { companyId, connectionId, ...errorData(err) });
    await withTenant(companyId, async (tx) => {
      await markConnection(tx, conn.id, { kind: "error", error: message });
      // Once per outage, not on every retry and every poll (B-99).
      if (!pollFailing(conn))
        await emit(tx, companyId, "connection.sync_failed", {
          connectionId,
          error: message.slice(0, 500),
        });
    });
    await setJob(companyId, jobId, {
      status: "failed",
      error: message,
      message,
      finishedAt: new Date(),
    });
    await publish(companyId, "connection.health", { connectionId, ok: false });
    throw err;
  }
}

/** A connection whose last poll failed (or that is in `error`) waits this long between tries. */
export const POLL_ERROR_BACKOFF_MS = 60 * 60_000;

/** True when the connection's most recent sync attempt failed. */
export function pollFailing(
  row: Pick<ConnectionRow, "status" | "lastErrorAt" | "lastPollAt">,
): boolean {
  if (row.status === "error") return true;
  return !!row.lastErrorAt && (!row.lastPollAt || row.lastErrorAt > row.lastPollAt);
}

/**
 * API connections due for a poll (cross-tenant; the poll scheduler fans out per connection).
 * Skipped (B-99): auto-import off; channels whose API is pending marketplace approval (they can
 * only fail); companies whose trial expired without a plan (imports are refused anyway); and a
 * failing connection until POLL_ERROR_BACKOFF_MS after its last error, so a broken connection
 * is retried hourly instead of failing (and alerting) every 10 minutes.
 */
export async function pollableConnections(now = new Date()) {
  const rows = await withSystem((tx) =>
    tx
      .select({
        id: channelConnections.id,
        companyId: channelConnections.companyId,
        channel: channelConnections.channel,
        provider: channelConnections.provider,
        status: channelConnections.status,
        settings: channelConnections.settings,
        lastErrorAt: channelConnections.lastErrorAt,
        lastPollAt: channelConnections.lastPollAt,
        sub: {
          status: subscriptions.status,
          trialEndsAt: subscriptions.trialEndsAt,
          stripeSubscriptionId: subscriptions.stripeSubscriptionId,
        },
      })
      .from(channelConnections)
      .leftJoin(subscriptions, eq(subscriptions.companyId, channelConnections.companyId))
      .where(
        and(
          eq(channelConnections.mode, "api"),
          inArray(channelConnections.status, ["connected", "error"]),
        ),
      ),
  );
  const seen = new Set<string>();
  return rows.filter((r) => {
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    if ((r.settings as { autoImport?: boolean })?.autoImport === false) return false;
    if (channelPendingApproval(r.channel, r.provider)) return false;
    if (r.sub?.status && effectiveStatus(r.sub, now) === "trial_expired") return false;
    if (
      pollFailing(r) &&
      r.lastErrorAt &&
      now.getTime() - r.lastErrorAt.getTime() < POLL_ERROR_BACKOFF_MS
    )
      return false;
    return true;
  });
}

/* ------------------------------------ webhooks ------------------------------------ */

/**
 * Verify a channel webhook synchronously, on the raw body, before anything is written or
 * enqueued (Shopify wants a 401 for a bad HMAC). The adapter comes from the channel's own mock
 * flag. A mock provider signs with a public constant, so production never accepts it.
 */
export async function verifyWebhook(
  channel: ConnectionRow["channel"],
  headers: HeaderBag,
  body: string,
  opts?: VerifyWebhookOptions,
): Promise<boolean> {
  if (env.isProd && channelMocked(channel)) return false;
  return webhookAdapter(channel).verifyWebhook(headers, body, opts);
}

/**
 * Record a verified delivery. True when it is new; false when the channel already delivered it
 * (a redelivery: acknowledge and do nothing). Written with the system role because no tenant is
 * known yet; the app role cannot write this table.
 */
export async function recordWebhookDelivery(
  channel: ConnectionRow["channel"],
  deliveryId: string,
): Promise<boolean> {
  const inserted = await withSystem((tx) =>
    tx
      .insert(webhookDeliveries)
      .values({ channel, deliveryId })
      .onConflictDoNothing()
      .returning({ id: webhookDeliveries.id }),
  );
  return inserted.length > 0;
}

/** Undo a record whose job could not be enqueued, so the channel's retry is processed. */
export async function forgetWebhookDelivery(channel: ConnectionRow["channel"], deliveryId: string) {
  await withSystem((tx) =>
    tx
      .delete(webhookDeliveries)
      .where(
        and(
          eq(webhookDeliveries.channel, channel),
          eq(webhookDeliveries.deliveryId, deliveryId),
          eq(webhookDeliveries.status, "received"),
        ),
      ),
  );
}

async function finishWebhookDelivery(
  channel: ConnectionRow["channel"],
  headers: HeaderBag,
  outcome: {
    status: "processed" | "ignored" | "failed";
    companyId?: string | null;
    detail?: string | null;
  },
) {
  const deliveryId = webhookDeliveryId(channel, headers);
  if (!deliveryId) return;
  await withSystem((tx) =>
    tx
      .update(webhookDeliveries)
      .set({
        status: outcome.status,
        processedAt: new Date(),
        detail: outcome.detail?.slice(0, 500) ?? null,
        ...(outcome.companyId ? { companyId: outcome.companyId } : {}),
      })
      .where(
        and(eq(webhookDeliveries.channel, channel), eq(webhookDeliveries.deliveryId, deliveryId)),
      ),
  );
}

/** Delete deliveries older than the retention window (daily job). */
export async function purgeWebhookDeliveries(now = new Date()) {
  const cutoff = new Date(now.getTime() - WEBHOOK_DELIVERY_RETENTION_MS);
  const deleted = await withSystem((tx) =>
    tx
      .delete(webhookDeliveries)
      .where(lt(webhookDeliveries.receivedAt, cutoff))
      .returning({ id: webhookDeliveries.id }),
  );
  return { deleted: deleted.length };
}

type WebhookResult =
  | { handled: false; reason: string }
  | { handled: true; kind: WebhookEvent["kind"]; orderIds: string[] };

/**
 * Process a verified delivery in the worker. Re-verifies (timestamps against `receivedAt`, so a
 * queued retry still passes), routes by shop id to `connected` connections only, and for
 * `order_ref` events (Etsy) fetches the order by id instead of trusting the payload.
 */
export async function processWebhook(
  channel: ConnectionRow["channel"],
  headers: HeaderBag,
  body: string,
  receivedAt?: string,
): Promise<WebhookResult> {
  try {
    const res = await handleWebhook(channel, headers, body, receivedAt);
    await finishWebhookDelivery(channel, headers, {
      status: res.result.handled ? "processed" : "ignored",
      companyId: res.companyId,
      detail: res.result.handled ? null : res.result.reason,
    });
    return res.result;
  } catch (err) {
    await finishWebhookDelivery(channel, headers, {
      status: "failed",
      detail: err instanceof Error ? err.message : String(err),
    }).catch(() => {});
    throw err;
  }
}

/**
 * Process a verified, recorded delivery inside the request (Shopify compliance topics: the PII
 * must be gone before the 200). On failure the delivery record is removed, whatever its status,
 * so the channel's retry is processed again, and the error is rethrown for a 5xx.
 */
export async function processWebhookNow(
  channel: ConnectionRow["channel"],
  headers: HeaderBag,
  body: string,
): Promise<WebhookResult> {
  try {
    const res = await handleWebhook(channel, headers, body);
    await finishWebhookDelivery(channel, headers, {
      status: res.result.handled ? "processed" : "ignored",
      companyId: res.companyId,
      detail: res.result.handled ? null : res.result.reason,
    });
    return res.result;
  } catch (err) {
    const deliveryId = webhookDeliveryId(channel, headers);
    if (deliveryId)
      await withSystem((tx) =>
        tx
          .delete(webhookDeliveries)
          .where(
            and(
              eq(webhookDeliveries.channel, channel),
              eq(webhookDeliveries.deliveryId, deliveryId),
            ),
          ),
      ).catch(() => {});
    throw err;
  }
}

async function handleWebhook(
  channel: ConnectionRow["channel"],
  headers: HeaderBag,
  body: string,
  receivedAt?: string,
): Promise<{ result: WebhookResult; companyId: string | null }> {
  const skip = (reason: string) => ({
    result: { handled: false as const, reason },
    companyId: null,
  });
  const at = receivedAt ? new Date(receivedAt) : undefined;
  if (!(await verifyWebhook(channel, headers, body, { receivedAt: at }))) {
    log.warn("webhook signature invalid; dropped", { channel });
    return skip("invalid signature");
  }
  const adapter = webhookAdapter(channel);
  const event = await adapter.parseWebhook(headers, body);
  if (event.kind === "ignored") {
    // e.g. an unpaid (pending, cash-on-delivery, authorized) Shopify order: logged, not imported.
    if (event.reason)
      log.info("webhook skipped", { channel, topic: event.topic, reason: event.reason });
    return skip(event.reason ?? `topic ${event.topic} ignored`);
  }
  if (event.kind === "privacy") {
    const deliveryId = webhookDeliveryId(channel, headers);
    if (channel !== "shopify" || !event.shopDomain || !deliveryId)
      return skip("privacy request without a shop or delivery id");
    const res = await handlePrivacyRequest({
      channel,
      shopDomain: event.shopDomain,
      deliveryId,
      request: event.request,
    });
    if (!res.handled) return skip(res.reason ?? "privacy request not routed");
    return {
      result: { handled: true, kind: event.kind, orderIds: [] },
      companyId: res.companyIds[0] ?? null,
    };
  }
  if (!event.shopDomain) return skip("no shop domain");
  const live = await withSystem((tx) =>
    tx
      .select()
      .from(channelConnections)
      .where(
        and(
          eq(channelConnections.channel, channel),
          eq(channelConnections.externalShopId, event.shopDomain as string),
          // Only installs that finished OAuth (pending rows never carry the shop id).
          eq(channelConnections.status, "connected"),
        ),
      ),
  );
  if (live.length === 0) return skip(`no connection for ${event.shopDomain}`);
  let orderIds: string[] = [];
  for (const conn of live) {
    const ctx = systemContext(conn.companyId);
    // T-29-4 (decision 0030): with auto-import off, a webhook for an order we do not have is
    // acknowledged and skipped. Updates for known orders still apply. The cursor is untouched,
    // so a manual Sync now picks the order up.
    if (
      (event.kind === "order_upsert" || event.kind === "order_ref") &&
      (conn.settings as { autoImport?: boolean } | null)?.autoImport === false
    ) {
      const channelOrderId =
        event.kind === "order_upsert" ? event.order.channelOrderId : event.channelOrderId;
      const known = await withTenant(conn.companyId, async (tx) => {
        const [row] = await tx
          .select({ id: orders.id })
          .from(orders)
          .where(and(eq(orders.channel, conn.channel), eq(orders.channelOrderId, channelOrderId)))
          .limit(1);
        // A delivery still proves the webhook route works (health), cursor untouched.
        if (!row) await markConnection(tx, conn.id, { kind: "webhook" });
        return !!row;
      });
      if (!known) {
        log.info("webhook skipped: auto-import is off", {
          companyId: conn.companyId,
          connectionId: conn.id,
          channel,
          topic: event.topic,
        });
        continue;
      }
    }
    // Webhook as a trigger: fetch the order by id outside any transaction.
    let fetched: FetchedOrder | null = null;
    if (event.kind === "order_ref") {
      const store = await getChannelAdapter(
        channel,
        channelMocked(channel) ? "mock" : "live",
        conn,
      );
      if (!store.fetchOrder) return skip(`${channel} cannot fetch orders by id`);
      fetched = await store.fetchOrder(toChannelConn(conn), event.channelOrderId);
    }
    await withTenant(conn.companyId, async (tx) => {
      await markConnection(tx, conn.id, { kind: "webhook" });
      const upsert =
        event.kind === "order_upsert"
          ? event.order
          : fetched && !fetched.cancelled
            ? fetched.order
            : null;
      if (upsert) {
        await checkPlan(tx, ctx, [upsert], conn.channel);
        const res = await importNormalizedOrders(tx, ctx, conn, [upsert], {
          source: "webhook",
        });
        orderIds = orderIds.concat(res.orderIds);
        // T-7-4 (B-12): a delivery older than what was applied is ignored, payload archive too.
        const fresh = res.orderIds.filter((id) => !res.staleOrderIds.includes(id));
        if (event.kind === "order_upsert" && fresh.length) {
          // Encrypted raw payload archive (purged with the buyer PII).
          const rawKey = objectKey(conn.companyId, "raw", "json");
          await putObject(rawKey, encryptField(body), "application/octet-stream");
          await tx.update(orders).set({ rawPayloadKey: rawKey }).where(inArray(orders.id, fresh));
        }
        if (res.imported)
          afterCommit(tx, async () => {
            await publish(conn.companyId, "today.changed", { reason: "webhook" });
          });
      } else if (event.kind === "order_cancelled") {
        await cancelFromChannel(tx, ctx, conn.channel, event.channelOrderId);
      } else if (event.kind === "order_ref" && fetched?.cancelled) {
        await cancelFromChannel(tx, ctx, conn.channel, event.channelOrderId);
      } else if (event.kind === "uninstalled") {
        await tx
          .update(channelConnections)
          .set({
            status: "disconnected",
            credentials: null,
            lastError: "App uninstalled from Shopify",
            lastErrorAt: new Date(),
          })
          .where(eq(channelConnections.id, conn.id));
        await audit(tx, {
          companyId: conn.companyId,
          actor: ctx.actor,
          action: "settings.changed",
          entityType: "channel_connection",
          entityId: conn.id,
          summary: "Shopify app uninstalled; connection disconnected",
        });
        afterCommit(tx, async () => {
          await publish(conn.companyId, "connection.health", { connectionId: conn.id, ok: false });
        });
      }
    });
  }
  return {
    result: { handled: true, kind: event.kind, orderIds },
    companyId: live[0]?.companyId ?? null,
  };
}

/* ------------------------------------ Shopify OAuth ------------------------------------ */

/** An install link works for 10 minutes and once only. */
export const OAUTH_STATE_TTL_MS = 10 * 60_000;

/**
 * Burn the pending connection's OAuth state under a row lock, so two callbacks with the same
 * state can't both finish (the second sees no state and is refused). Keeps the pending shop so
 * the user can start again.
 */
async function consumeOAuthState(connectionId: string, state: string) {
  const ok = await withSystem(async (tx) => {
    const [row] = await tx
      .select()
      .from(channelConnections)
      .where(and(eq(channelConnections.id, connectionId), eq(channelConnections.status, "pending")))
      .for("update");
    if (!row?.credentials) return false;
    let creds: { oauthState?: string; pendingShop?: string };
    try {
      creds = decryptJson(row.credentials);
    } catch {
      return false;
    }
    if (typeof creds.oauthState !== "string" || !safeEqual(creds.oauthState, state)) return false;
    await tx
      .update(channelConnections)
      .set({
        credentials: encryptJson({
          pendingShop: creds.pendingShop,
          oauthStateUsedAt: new Date().toISOString(),
        }),
      })
      .where(eq(channelConnections.id, connectionId));
    return true;
  });
  if (!ok)
    throw badRequest("This Shopify connection link was already used. Connect the store again.");
}

/**
 * `/webhooks/shopify/oauth/callback?code&shop&state&hmac&timestamp`. Finds the pending
 * connection by shop + state, checks the state is at most OAUTH_STATE_TTL_MS old and burns it,
 * exchanges the code for an offline token, subscribes webhooks and marks the connection
 * connected. Mock mode skips the HMAC and token exchange.
 */
export async function completeShopifyOAuth(query: Record<string, string>) {
  const shop = query.shop ?? "";
  const state = query.state ?? "";
  if (!/^[a-z0-9-]+\.myshopify\.com$/.test(shop) || !state)
    throw badRequest("Invalid OAuth callback");
  if (!env.mocks.shopify && !verifyOAuthQuery(query)) throw badRequest("OAuth HMAC mismatch");
  const pending = await withSystem((tx) =>
    tx
      .select()
      .from(channelConnections)
      .where(
        and(eq(channelConnections.channel, "shopify"), eq(channelConnections.status, "pending")),
      ),
  );
  const conn = pending.find((c) => {
    try {
      const creds =
        c.credentials && decryptJson<{ oauthState?: string; pendingShop?: string }>(c.credentials);
      return (
        !!creds &&
        typeof creds.oauthState === "string" &&
        safeEqual(creds.oauthState, state) &&
        creds.pendingShop === shop
      );
    } catch {
      return false;
    }
  });
  if (!conn) throw notFound("pending Shopify connection");
  // `connect()` rewrites the pending row with each new state, so updatedAt is when it was issued.
  if (Date.now() - conn.updatedAt.getTime() > OAUTH_STATE_TTL_MS)
    throw badRequest("This Shopify connection link has expired. Connect the store again.");
  await consumeOAuthState(conn.id, state);
  if (await shopifyConnectedElsewhere(shop, conn.companyId))
    throw conflict("This Shopify store is connected to another InvAI account");

  let credentials: ChannelCredentials = { accessToken: "mock-token", scopes: [] };
  let name = conn.name;
  // A sample workspace never completes a real install (its connect already chose the mock).
  if (
    conn.provider === "live" &&
    !env.mocks.shopify &&
    !(await isSampleWorkspace(conn.companyId))
  ) {
    const token = await exchangeShopifyCode(shop, query.code ?? "");
    credentials = token;
    const done = await finishShopifyInstall({ externalShopId: shop, credentials: token });
    name = done.shopName;
  }
  // Subscribe the order webhooks; a topic that fails leaves the connection degraded (health).
  const webhooks = await (await getChannelAdapter("shopify", conn.provider, conn)).ensureWebhooks?.(
    { ...toChannelConn(conn), externalShopId: shop, credentials },
    channelWebhookUri("shopify"),
  );
  if (webhooks) credentials = { ...credentials, webhooks };
  const isUniqueViolation = (err: unknown) =>
    (err as { cause?: { code?: string } }).cause?.code === "23505" ||
    (err as { code?: string }).code === "23505";
  await withTenant(conn.companyId, async (tx) => {
    await tx
      .update(channelConnections)
      .set({
        status: "connected",
        name,
        externalShopId: shop,
        credentials: encryptJson(credentials),
        connectedAt: new Date(),
        lastError: null,
        lastErrorAt: null,
      })
      .where(eq(channelConnections.id, conn.id));
    await audit(tx, {
      companyId: conn.companyId,
      actor: { kind: "system" },
      action: "settings.changed",
      entityType: "channel_connection",
      entityId: conn.id,
      summary: `Shopify store ${shop} connected`,
    });
    await emit(tx, conn.companyId, "connection.connected", { connectionId: conn.id });
  }).catch((err) => {
    // channel_connections_connected_shop_uq: another company finished connecting this store.
    if (isUniqueViolation(err))
      throw conflict("This Shopify store is connected to another InvAI account");
    throw err;
  });
  return { connectionId: conn.id, companyId: conn.companyId };
}
