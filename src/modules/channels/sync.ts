import type { CsvFormat, ImportReport, NormalizedOrder } from "@invai/contracts";
import { and, eq, inArray } from "drizzle-orm";
import { systemContext, type TenantContext } from "../../api/context";
import { afterCommit, type Tx, withSystem, withTenant } from "../../db/client";
import { channelConnections, importRuns, jobs, orders } from "../../db/schema";
import { env } from "../../env";
import { getChannelAdapter } from "../../integrations/channels";
import { parseOrdersCsv } from "../../integrations/channels/csv";
import {
  exchangeShopifyCode,
  finishShopifyInstall,
  verifyOAuthQuery,
} from "../../integrations/channels/shopify";
import type { HeaderBag } from "../../integrations/channels/types";
import { audit } from "../../lib/audit";
import { decryptJson, encryptField, encryptJson } from "../../lib/crypto";
import { badRequest, conflict, notFound, ORPCError } from "../../lib/errors";
import { errorData, logger } from "../../lib/log";
import { emit } from "../../lib/outbox";
import { publish } from "../../lib/realtime";
import { getObject, objectKey, putObject } from "../../lib/s3";
import { assertWithinPlan } from "../billing/service";
import { markFileReady } from "../files/service";
import { cancelFromChannel, importNormalizedOrders } from "../orders/import";
import {
  type ConnectionRow,
  getConnectionRow,
  markConnection,
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

export async function importCsv(
  tx: Tx,
  ctx: TenantContext,
  input: { id: string; fileKey: string; format: CsvFormat },
): Promise<ImportReport> {
  const conn = await getConnectionRow(tx, input.id);
  if (conn.status === "disconnected") throw conflict("This connection is disconnected");
  if (!input.fileKey.startsWith(`${ctx.companyId}/`)) throw notFound("file");
  let text: string;
  try {
    text = (await getObject(input.fileKey)).toString("utf8");
  } catch {
    throw notFound("file");
  }
  let parsed: ReturnType<typeof parseOrdersCsv>;
  try {
    parsed = parseOrdersCsv(input.format, text, conn.channel);
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
  await checkPlan(tx, ctx, parsed.orders, conn.channel);

  const [run] = await tx
    .insert(importRuns)
    .values({
      companyId: ctx.companyId,
      connectionId: conn.id,
      format: input.format,
      fileKey: input.fileKey,
      status: "running",
      rowsTotal: parsed.rowsTotal,
      createdBy: ctx.userId,
    })
    .returning();
  if (!run) throw new Error("import run insert failed");

  const res = await importNormalizedOrders(tx, ctx, conn, parsed.orders, {
    source: "csv",
    importRunId: run.id,
    cancelledChannelOrderIds: parsed.cancelledChannelOrderIds,
  });
  const errors = [
    ...parsed.errors,
    ...res.errors.map((e) => ({
      row: parsed.orderRows[e.index] ?? 1,
      message: `Order ${e.channelOrderId ?? "?"}: ${e.message}`,
    })),
  ].sort((a, b) => a.row - b.row);

  const [done] = await tx
    .update(importRuns)
    .set({
      status: "completed",
      ordersImported: res.imported,
      ordersUpdated: res.updated,
      ordersSkipped: res.skipped,
      rowsFailed: new Set(errors.map((e) => e.row)).size,
      itemsNeedingMapping: res.itemsNeedingMapping,
      errors: errors.slice(0, 500),
      orderIds: res.orderIds,
      finishedAt: new Date(),
    })
    .where(eq(importRuns.id, run.id))
    .returning();
  await markConnection(tx, conn.id, { kind: "import" });
  await markFileReady(tx, input.fileKey);
  await audit(tx, {
    companyId: ctx.companyId,
    actor: ctx.actor,
    action: "channel.import",
    entityType: "channel_connection",
    entityId: conn.id,
    summary: `${input.format} CSV: ${res.imported} new, ${res.updated} updated, ${res.skipped} unchanged, ${errors.length} error(s)`,
    data: { importId: run.id },
  });
  await emit(tx, ctx.companyId, "import.completed", {
    importId: run.id,
    connectionId: conn.id,
    orderIds: res.orderIds,
  });
  afterCommit(tx, async () => {
    await publish(ctx.companyId, "import.completed", {
      importId: run.id,
      connectionId: conn.id,
      ordersImported: res.imported,
      rowsFailed: errors.length,
    });
    await publish(ctx.companyId, "today.changed", { reason: "import" });
  });
  return toImportReport(done ?? run);
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
  const adapter = getChannelAdapter(conn.channel, conn.provider);
  try {
    const fetched = await adapter.fetchOrders(toChannelConn(conn));
    const res = await withTenant(companyId, async (tx) => {
      await checkPlan(tx, ctx, fetched.orders, conn.channel);
      const out = await importNormalizedOrders(tx, ctx, conn, fetched.orders, {
        source: "api",
        cancelledChannelOrderIds: fetched.cancelledChannelOrderIds,
      });
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

/** API connections due for a poll (cross-tenant; the poll scheduler fans out per connection). */
export async function pollableConnections() {
  return withSystem((tx) =>
    tx
      .select({
        id: channelConnections.id,
        companyId: channelConnections.companyId,
        settings: channelConnections.settings,
      })
      .from(channelConnections)
      .where(
        and(
          eq(channelConnections.mode, "api"),
          inArray(channelConnections.status, ["connected", "error"]),
        ),
      ),
  ).then((rows) =>
    rows.filter((r) => (r.settings as { autoImport?: boolean })?.autoImport !== false),
  );
}

/* ------------------------------------ webhooks ------------------------------------ */

/**
 * Verify a channel webhook synchronously (Shopify wants a 401 for a bad HMAC). Returns the
 * connections it belongs to, or null when the signature is invalid.
 */
export async function verifyWebhook(
  channel: ConnectionRow["channel"],
  headers: HeaderBag,
  body: string,
) {
  const adapter = getChannelAdapter(channel, env.mocks.shopify ? "mock" : "live");
  return adapter.verifyWebhook(headers, body);
}

export async function processWebhook(
  channel: ConnectionRow["channel"],
  headers: HeaderBag,
  body: string,
) {
  const adapter = getChannelAdapter(channel, env.mocks.shopify ? "mock" : "live");
  if (!(await adapter.verifyWebhook(headers, body))) {
    log.warn("webhook signature invalid; dropped", { channel });
    return { handled: false, reason: "invalid signature" };
  }
  const event = await adapter.parseWebhook(headers, body);
  if (event.kind === "ignored") return { handled: false, reason: `topic ${event.topic} ignored` };
  if (!event.shopDomain) return { handled: false, reason: "no shop domain" };
  const conns = await withSystem((tx) =>
    tx
      .select()
      .from(channelConnections)
      .where(
        and(
          eq(channelConnections.channel, channel),
          eq(channelConnections.externalShopId, event.shopDomain as string),
        ),
      ),
  );
  const live = conns.filter((c) => c.status !== "disconnected");
  if (live.length === 0) return { handled: false, reason: `no connection for ${event.shopDomain}` };
  let orderIds: string[] = [];
  for (const conn of live) {
    const ctx = systemContext(conn.companyId);
    await withTenant(conn.companyId, async (tx) => {
      await markConnection(tx, conn.id, { kind: "webhook" });
      if (event.kind === "order_upsert") {
        await checkPlan(tx, ctx, [event.order], conn.channel);
        const res = await importNormalizedOrders(tx, ctx, conn, [event.order], {
          source: "webhook",
        });
        orderIds = orderIds.concat(res.orderIds);
        // Encrypted raw payload archive (purged with the buyer PII).
        const rawKey = objectKey(conn.companyId, "raw", "json");
        await putObject(rawKey, encryptField(body), "application/octet-stream");
        if (res.orderIds.length)
          await tx
            .update(orders)
            .set({ rawPayloadKey: rawKey })
            .where(inArray(orders.id, res.orderIds));
        if (res.imported)
          afterCommit(tx, async () => {
            await publish(conn.companyId, "today.changed", { reason: "webhook" });
          });
      } else if (event.kind === "order_cancelled") {
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
  return { handled: true, kind: event.kind, orderIds };
}

/* ------------------------------------ Shopify OAuth ------------------------------------ */

/**
 * `/webhooks/shopify/oauth/callback?code&shop&state&hmac&timestamp`. Finds the pending
 * connection by shop + state, exchanges the code for an offline token, subscribes webhooks
 * and marks the connection connected. Mock mode skips the HMAC and token exchange.
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
        and(
          eq(channelConnections.channel, "shopify"),
          eq(channelConnections.externalShopId, shop),
          eq(channelConnections.status, "pending"),
        ),
      ),
  );
  const conn = pending.find((c) => {
    try {
      return (
        c.credentials && decryptJson<{ oauthState?: string }>(c.credentials).oauthState === state
      );
    } catch {
      return false;
    }
  });
  if (!conn) throw notFound("pending Shopify connection");

  let credentials: Record<string, unknown> = { accessToken: "mock-token", scopes: [] };
  let name = conn.name;
  if (conn.provider === "live" && !env.mocks.shopify) {
    const token = await exchangeShopifyCode(shop, query.code ?? "");
    credentials = token;
    const done = await finishShopifyInstall(
      { externalShopId: shop, credentials: token },
      `${env.BETTER_AUTH_URL}/webhooks/shopify`,
    );
    name = done.shopName;
  }
  await withTenant(conn.companyId, async (tx) => {
    await tx
      .update(channelConnections)
      .set({
        status: "connected",
        name,
        credentials: encryptJson(credentials),
        connectedAt: new Date(),
        lastError: null,
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
  });
  return { connectionId: conn.id, companyId: conn.companyId };
}
