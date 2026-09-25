import type { CsvFormat, ImportReport, NormalizedOrder } from "@invai/contracts";
import { and, eq, inArray, lt } from "drizzle-orm";
import { systemContext, type TenantContext } from "../../api/context";
import { afterCommit, type Tx, withSystem, withTenant } from "../../db/client";
import {
  channelConnections,
  importRuns,
  jobs,
  orders,
  WEBHOOK_DELIVERY_RETENTION_MS,
  webhookDeliveries,
} from "../../db/schema";
import { env } from "../../env";
import {
  channelMocked,
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
import { publish } from "../../lib/realtime";
import { getObject, objectKey, putObject } from "../../lib/s3";
import { assertWithinPlan } from "../billing/service";
import { markFileReady } from "../files/service";
import { cancelFromChannel, importNormalizedOrders } from "../orders/import";
import { handlePrivacyRequest } from "../privacy/service";
import {
  type ConnectionRow,
  channelWebhookUri,
  getConnectionRow,
  markConnection,
  shopifyConnectedElsewhere,
  toChannelConn,
  toImportReport,
  webhookFailureMessage,
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
    // Webhook as a trigger: fetch the order by id outside any transaction.
    let fetched: FetchedOrder | null = null;
    if (event.kind === "order_ref") {
      if (!adapter.fetchOrder) return skip(`${channel} cannot fetch orders by id`);
      fetched = await adapter.fetchOrder(toChannelConn(conn), event.channelOrderId);
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
        if (event.kind === "order_upsert") {
          // Encrypted raw payload archive (purged with the buyer PII).
          const rawKey = objectKey(conn.companyId, "raw", "json");
          await putObject(rawKey, encryptField(body), "application/octet-stream");
          if (res.orderIds.length)
            await tx
              .update(orders)
              .set({ rawPayloadKey: rawKey })
              .where(inArray(orders.id, res.orderIds));
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
  if (conn.provider === "live" && !env.mocks.shopify) {
    const token = await exchangeShopifyCode(shop, query.code ?? "");
    credentials = token;
    const done = await finishShopifyInstall({ externalShopId: shop, credentials: token });
    name = done.shopName;
  }
  // Subscribe the order webhooks; a topic that fails leaves the connection degraded (health).
  const webhooks = await getChannelAdapter("shopify", conn.provider).ensureWebhooks?.(
    { ...toChannelConn(conn), externalShopId: shop, credentials },
    channelWebhookUri("shopify"),
  );
  if (webhooks) credentials = { ...credentials, webhooks };
  const degraded = webhookFailureMessage(webhooks);
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
        lastError: degraded,
        lastErrorAt: degraded ? new Date() : null,
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
