import {
  CHANNEL_RULES,
  type ChannelConnection,
  type ConnectInput as ConnectInputSchema,
  type ConnectionSettings as ConnectionSettingsSchema,
  type ImportReport,
} from "@invai/contracts";
import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import type { z } from "zod";
import type { TenantContext } from "../../api/context";
import { afterCommit, type Tx, withSystem, withTenant } from "../../db/client";
import {
  channelConnections,
  DEFAULT_CONNECTION_SETTINGS,
  importRuns,
  orderItems,
  orders,
  shipments,
} from "../../db/schema";
import { env } from "../../env";
import { channelPendingApproval, getChannelAdapter } from "../../integrations/channels";
import {
  refreshShopifyToken,
  ShopifyRefreshError,
  shopifyAuthorizeUrl,
} from "../../integrations/channels/shopify";
import type {
  ChannelConn,
  ChannelCredentials,
  WebhookSubscriptionState,
} from "../../integrations/channels/types";
import { audit } from "../../lib/audit";
import { decryptJson, encryptJson, randomToken } from "../../lib/crypto";
import { badRequest, notFound, ORPCError } from "../../lib/errors";
import { emit } from "../../lib/outbox";
import { keyset, type PageInput } from "../../lib/pagination";
import { assertWithinPlan } from "../billing/service";
import { isSampleWorkspace } from "../tenancy/demo-flag";

/*
 * Channel connections: list/connect/update/disconnect, health, tracking push for shipping.
 * Import (CSV + API sync) lives in ./sync.ts and modules/orders/import.ts; SKU rules in ./sku.ts.
 */

export type ConnectionRow = typeof channelConnections.$inferSelect;
type ConnectInput = z.infer<typeof ConnectInputSchema>;
type ConnectionSettings = z.infer<typeof ConnectionSettingsSchema>;

const STALE_ALERT_MINUTES = 30;

/* ------------------------------ expiring access tokens (B-05) ------------------------------ */

/** Refresh when the access token has less than this left (it lasts 1 hour; the poll runs every 10). */
export const TOKEN_REFRESH_AHEAD_MS = 20 * 60_000;

export function tokenNeedsRefresh(c: ChannelCredentials | null | undefined, now = Date.now()) {
  if (!c?.refreshToken || !c.expiresAt) return false;
  return new Date(c.expiresAt).getTime() - now < TOKEN_REFRESH_AHEAD_MS;
}

/**
 * Refresh one connection's expiring token under a row lock (research 10 R1): two workers never
 * spend the same refresh token, and the rotated pair is stored with its expiry in one update.
 * A second caller waiting on the lock finds the fresh token and doesn't refresh again. On failure
 * the old credentials stay, the connection is flagged (`refreshError`, last error, health not ok)
 * and the stale connection is returned; the caller's API call then fails as before.
 */
export async function refreshConnectionToken(
  companyId: string,
  connectionId: string,
  opts: { force?: boolean } = {},
): Promise<ChannelConn | null> {
  return withTenant(companyId, async (tx) => {
    const [row] = await tx
      .select()
      .from(channelConnections)
      .where(eq(channelConnections.id, connectionId))
      .for("update");
    if (!row) return null;
    const conn = toChannelConn(row);
    const creds = conn.credentials;
    if (
      row.channel !== "shopify" ||
      row.provider !== "live" ||
      !row.externalShopId ||
      !creds?.refreshToken ||
      (!opts.force && !tokenNeedsRefresh(creds))
    )
      return conn;
    try {
      const fresh = await refreshShopifyToken(row.externalShopId, creds.refreshToken);
      const next: ChannelCredentials = { ...creds, ...fresh, refreshError: null };
      await tx
        .update(channelConnections)
        .set({
          credentials: encryptJson(next),
          ...(creds.refreshError ? { lastError: null } : {}),
        })
        .where(eq(channelConnections.id, row.id));
      return { ...conn, credentials: next };
    } catch (err) {
      const permanent = err instanceof ShopifyRefreshError && err.permanent;
      const message = err instanceof Error ? err.message : String(err);
      const flagged: ChannelCredentials = {
        ...creds,
        refreshError: { at: new Date().toISOString(), message, permanent },
      };
      await tx
        .update(channelConnections)
        .set({
          credentials: encryptJson(flagged),
          lastError: permanent
            ? "Shopify no longer accepts this connection's access. Reconnect the store."
            : `Shopify access could not be renewed (${message}); retrying.`,
          lastErrorAt: new Date(),
        })
        .where(eq(channelConnections.id, row.id));
      return { ...conn, credentials: flagged };
    }
  });
}

/** The adapter view of a connection, with its token refreshed first when it is about to expire. */
export async function freshChannelConn(row: ConnectionRow): Promise<ChannelConn> {
  const conn = toChannelConn(row);
  if (!tokenNeedsRefresh(conn.credentials)) return conn;
  return (await refreshConnectionToken(row.companyId, row.id)) ?? conn;
}

/** Every 10 minutes (with the poll): refresh the tokens that expire within 20 minutes. */
export async function refreshExpiringTokens(now = Date.now()) {
  const rows = await withSystem((tx) =>
    tx
      .select()
      .from(channelConnections)
      .where(
        and(
          eq(channelConnections.mode, "api"),
          eq(channelConnections.provider, "live"),
          inArray(channelConnections.status, ["connected", "error"]),
        ),
      ),
  );
  let refreshed = 0;
  let failed = 0;
  for (const row of rows) {
    if (!tokenNeedsRefresh(toChannelConn(row).credentials, now)) continue;
    const conn = await refreshConnectionToken(row.companyId, row.id);
    if (conn?.credentials?.refreshError) failed++;
    else refreshed++;
  }
  return { refreshed, failed };
}

/** Where a channel's webhooks are delivered (the API's public URL). */
export function channelWebhookUri(channel: ConnectionRow["channel"]) {
  return `${env.BETTER_AUTH_URL}/webhooks/${channel}`;
}

/**
 * The degraded reason when some webhook topics could not be subscribed, else null. The
 * connection stays `connected` (webhooks that do arrive still route, the poll still runs); health
 * shows it as not ok with this reason until a check subscribes every topic.
 */
export function webhookFailureMessage(state: WebhookSubscriptionState | null | undefined) {
  if (!state?.failures.length) return null;
  const topics = state.failures.map((f) => `${f.topic} (${f.message})`).join(", ");
  return `Webhook subscription failed: ${topics}. Orders still arrive by the 10-minute poll; reconnect the store if this persists.`.slice(
    0,
    500,
  );
}

export function settingsOf(row: Pick<ConnectionRow, "settings">): ConnectionSettings {
  return { ...DEFAULT_CONNECTION_SETTINGS, ...(row.settings ?? {}) };
}

/** The adapter-facing view of a connection (credentials decrypted). */
export function toChannelConn(row: ConnectionRow): ChannelConn {
  let credentials: ChannelCredentials | null = null;
  if (row.credentials) {
    try {
      credentials = decryptJson<ChannelCredentials>(row.credentials);
    } catch {
      credentials = null;
    }
  }
  return {
    id: row.id,
    companyId: row.companyId,
    channel: row.channel,
    name: row.name,
    mode: row.mode,
    provider: row.provider,
    externalShopId: row.externalShopId,
    cursor: row.cursor,
    credentials,
  };
}

type HealthStats = { ordersLast24h: number; errorsLast24h: number };

function toConnection(row: ConnectionRow, stats: HealthStats): ChannelConnection {
  const pendingApproval = channelPendingApproval(row.channel, row.provider);
  const lastSync = [row.lastPollAt, row.lastWebhookAt]
    .filter((d): d is Date => !!d)
    .sort((a, b) => b.getTime() - a.getTime())[0];
  const staleMinutes =
    row.mode === "api" && row.status === "connected"
      ? lastSync
        ? Math.max(0, Math.floor((Date.now() - lastSync.getTime()) / 60_000))
        : null
      : null;
  const errored = row.status === "error";
  const stale = staleMinutes !== null && staleMinutes > STALE_ALERT_MINUTES;
  const creds = row.mode === "api" ? toChannelConn(row).credentials : null;
  const degraded =
    row.status === "connected" || row.status === "error"
      ? creds?.refreshError
        ? "Shopify access could not be renewed. Reconnect the store if this persists."
        : row.status === "connected"
          ? webhookFailureMessage(creds?.webhooks)
          : null
      : null;
  return {
    id: row.id,
    channel: row.channel,
    name: row.name,
    status: row.status,
    mode: row.mode,
    externalShopId: row.externalShopId,
    provider: row.provider,
    settings: settingsOf(row),
    health: {
      ok: !errored && !stale && !degraded && row.status !== "disconnected",
      lastWebhookAt: row.lastWebhookAt?.toISOString() ?? null,
      lastPollAt: row.lastPollAt?.toISOString() ?? null,
      lastImportAt: row.lastImportAt?.toISOString() ?? null,
      ordersLast24h: stats.ordersLast24h,
      errorsLast24h: stats.errorsLast24h,
      lastError: row.lastError ?? degraded,
      pendingApproval,
      staleMinutes,
    },
    connectedAt: row.connectedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

async function healthStats(tx: Tx, rows: ConnectionRow[]): Promise<Map<string, HealthStats>> {
  const out = new Map<string, HealthStats>();
  if (rows.length === 0) return out;
  const ids = rows.map((r) => r.id);
  const since = new Date(Date.now() - 86400_000);
  const orderCounts = await tx
    .select({ id: orders.connectionId, n: sql<number>`count(*)`.mapWith(Number) })
    .from(orders)
    .where(and(inArray(orders.connectionId, ids), gt(orders.createdAt, since)))
    .groupBy(orders.connectionId);
  const errorCounts = await tx
    .select({
      id: importRuns.connectionId,
      n: sql<number>`coalesce(sum(${importRuns.rowsFailed} + case when ${importRuns.status} = 'failed' then 1 else 0 end), 0)`.mapWith(
        Number,
      ),
    })
    .from(importRuns)
    .where(and(inArray(importRuns.connectionId, ids), gt(importRuns.startedAt, since)))
    .groupBy(importRuns.connectionId);
  for (const r of rows) {
    const recentError = r.lastErrorAt && r.lastErrorAt > since ? 1 : 0;
    out.set(r.id, {
      ordersLast24h: orderCounts.find((c) => c.id === r.id)?.n ?? 0,
      errorsLast24h: (errorCounts.find((c) => c.id === r.id)?.n ?? 0) + recentError,
    });
  }
  return out;
}

async function hydrate(tx: Tx, rows: ConnectionRow[]): Promise<ChannelConnection[]> {
  const stats = await healthStats(tx, rows);
  return rows.map((r) =>
    toConnection(r, stats.get(r.id) ?? { ordersLast24h: 0, errorsLast24h: 0 }),
  );
}

export async function getConnectionRow(tx: Tx, id: string): Promise<ConnectionRow> {
  const [row] = await tx
    .select()
    .from(channelConnections)
    .where(eq(channelConnections.id, id))
    .limit(1);
  if (!row) throw notFound("channel_connection", id);
  return row;
}

/** Every connection of the company (disconnected ones last). */
export async function listConnections(tx: Tx, _ctx: TenantContext): Promise<ChannelConnection[]> {
  const rows = await tx
    .select()
    .from(channelConnections)
    .orderBy(
      sql`case when ${channelConnections.status} = 'disconnected' then 1 else 0 end`,
      channelConnections.createdAt,
    );
  return hydrate(tx, rows);
}

export async function getConnection(tx: Tx, _ctx: TenantContext, id: string) {
  const [out] = await hydrate(tx, [await getConnectionRow(tx, id)]);
  return out as ChannelConnection;
}

/** The shop domain a pending Shopify install is for (only in its encrypted credentials). */
export function pendingShopOf(row: Pick<ConnectionRow, "credentials">): string | null {
  if (!row.credentials) return null;
  try {
    const c = decryptJson<ChannelCredentials>(row.credentials);
    return typeof c.pendingShop === "string" ? c.pendingShop : null;
  } catch {
    return null;
  }
}

/** Cross-tenant check (system scope): is this shop already connected to another company? */
export async function shopifyConnectedElsewhere(shop: string, companyId: string): Promise<boolean> {
  const rows = await withSystem((stx) =>
    stx
      .select({ companyId: channelConnections.companyId })
      .from(channelConnections)
      .where(
        and(
          eq(channelConnections.channel, "shopify"),
          eq(channelConnections.externalShopId, shop),
          eq(channelConnections.status, "connected"),
        ),
      ),
  );
  return rows.some((r) => r.companyId !== companyId);
}

export async function connect(tx: Tx, ctx: TenantContext, input: ConnectInput) {
  if (input.channel === "shopify") {
    const shop = input.shopDomain;
    // The shop domain is unproven until Shopify's OAuth callback: a pending row keeps it only in
    // its encrypted credentials, and `external_shop_id` (which routes webhooks) is set on success.
    if (await shopifyConnectedElsewhere(shop, ctx.companyId))
      throw new ORPCError("ALREADY_CONNECTED", {
        status: 409,
        message: "This shop is connected to another InvAI account",
      });
    const rows = await tx
      .select()
      .from(channelConnections)
      .where(eq(channelConnections.channel, "shopify"));
    const existing =
      rows.find((r) => r.externalShopId === shop) ??
      rows.find((r) => r.status === "pending" && pendingShopOf(r) === shop);
    if (existing && existing.status !== "disconnected" && existing.status !== "pending") {
      throw new ORPCError("ALREADY_CONNECTED", {
        status: 409,
        message: "This shop is already connected",
      });
    }
    // A pending install already counts; a new or reconnected shop takes a connection slot.
    if (!existing || existing.status === "disconnected")
      await assertWithinPlan(tx, ctx, "connections");
    // A sample workspace never talks to a real store, whatever keys are configured.
    const provider =
      env.mocks.shopify || (await isSampleWorkspace(ctx.companyId)) ? "mock" : "live";
    const state = randomToken(24);
    const values = {
      name: shop.replace(/\.myshopify\.com$/, ""),
      status: "pending" as const,
      mode: "api" as const,
      provider: provider as "mock" | "live",
      externalShopId: null,
      credentials: encryptJson({
        oauthState: state,
        pendingShop: shop,
      } satisfies ChannelCredentials),
      lastError: null,
    };
    const row = existing
      ? (
          await tx
            .update(channelConnections)
            .set(values)
            .where(eq(channelConnections.id, existing.id))
            .returning()
        )[0]
      : (
          await tx
            .insert(channelConnections)
            .values({ companyId: ctx.companyId, channel: "shopify", ...values })
            .returning()
        )[0];
    if (!row) throw new Error("connection insert failed");
    const redirectUri = `${env.BETTER_AUTH_URL}/webhooks/shopify/oauth/callback`;
    // The mock store has no Shopify admin to send the browser to: the callback completes directly.
    const authorizeUrl =
      provider === "mock"
        ? `${redirectUri}?shop=${encodeURIComponent(shop)}&state=${state}&code=mock`
        : shopifyAuthorizeUrl(shop, state, redirectUri);
    await audit(tx, {
      companyId: ctx.companyId,
      actor: ctx.actor,
      action: "settings.changed",
      entityType: "channel_connection",
      entityId: row.id,
      summary: `Shopify install started for ${shop}`,
    });
    return { kind: "oauth" as const, connectionId: row.id, authorizeUrl };
  }

  const mode = input.mode;
  await assertWithinPlan(tx, ctx, "connections");
  const [row] = await tx
    .insert(channelConnections)
    .values({
      companyId: ctx.companyId,
      channel: input.channel,
      name: input.name,
      status: mode === "csv" ? "csv_only" : "error",
      mode,
      provider: "mock",
      externalShopId: null,
      lastError:
        mode === "api"
          ? `${CHANNEL_RULES[input.channel].label} API access is pending marketplace approval; use CSV import`
          : null,
      lastErrorAt: mode === "api" ? new Date() : null,
      connectedAt: new Date(),
    })
    .returning();
  if (!row) throw new Error("connection insert failed");
  await audit(tx, {
    companyId: ctx.companyId,
    actor: ctx.actor,
    action: "settings.changed",
    entityType: "channel_connection",
    entityId: row.id,
    summary: `${CHANNEL_RULES[input.channel].label} connection "${input.name}" created`,
  });
  await emit(tx, ctx.companyId, "connection.connected", { connectionId: row.id });
  return { kind: "created" as const, connection: await getConnection(tx, ctx, row.id) };
}

export async function updateConnection(
  tx: Tx,
  ctx: TenantContext,
  input: { id: string; name?: string; settings?: Partial<ConnectionSettings> },
) {
  const row = await getConnectionRow(tx, input.id);
  const settings = { ...settingsOf(row), ...(input.settings ?? {}) };
  await tx
    .update(channelConnections)
    .set({ name: input.name ?? row.name, settings })
    .where(eq(channelConnections.id, input.id));
  await audit(tx, {
    companyId: ctx.companyId,
    actor: ctx.actor,
    action: "settings.changed",
    entityType: "channel_connection",
    entityId: row.id,
    summary: `Channel ${row.name} settings updated`,
    data: { settings: input.settings ?? {}, name: input.name ?? null },
  });
  return getConnection(tx, ctx, input.id);
}

/**
 * Disconnect: the row is marked disconnected and its credentials dropped in the transaction; after
 * it commits, the channel's side is cleaned up with the old credentials (Shopify: delete the
 * webhook subscriptions, then uninstall the app, which revokes the token). That call never undoes
 * the disconnect; what failed is audited and kept as the connection's last error.
 */
export async function disconnect(tx: Tx, ctx: TenantContext, id: string) {
  const row = await getConnectionRow(tx, id);
  const remote =
    row.mode === "api" && (row.status === "connected" || row.status === "error")
      ? toChannelConn(row)
      : null;
  const adapter = remote?.credentials?.accessToken
    ? await getChannelAdapter(row.channel, row.provider, row)
    : null;
  const cleanUp = adapter?.disconnect?.bind(adapter);
  if (remote && cleanUp)
    afterCommit(tx, async () => {
      const res = await cleanUp(remote, channelWebhookUri(row.channel));
      const label = CHANNEL_RULES[row.channel].label;
      await withTenant(ctx.companyId, async (t) => {
        await audit(t, {
          companyId: ctx.companyId,
          actor: ctx.actor,
          action: "settings.changed",
          entityType: "channel_connection",
          entityId: id,
          summary: `${label}: ${res.unsubscribed} webhook subscription(s) removed; ${
            res.uninstalled ? "app uninstalled and access revoked" : "app not uninstalled"
          }`,
          data: { ...res, errors: res.errors.slice(0, 10) },
        });
        if (!res.errors.length) return;
        const failed = `${label} cleanup failed: ${res.errors.join("; ")}`;
        await t
          .update(channelConnections)
          .set({
            lastError:
              `Disconnected here, but ${failed}. Remove the app in the ${label} admin.`.slice(
                0,
                500,
              ),
            lastErrorAt: new Date(),
          })
          .where(eq(channelConnections.id, id));
      });
    });
  await tx
    .update(channelConnections)
    .set({ status: "disconnected", credentials: null, cursor: row.cursor })
    .where(eq(channelConnections.id, id));
  await audit(tx, {
    companyId: ctx.companyId,
    actor: ctx.actor,
    action: "settings.changed",
    entityType: "channel_connection",
    entityId: id,
    summary: `Channel ${row.name} disconnected`,
  });
  return getConnection(tx, ctx, id);
}

export async function health(tx: Tx, ctx: TenantContext) {
  const items = await listConnections(tx, ctx);
  return {
    items: items
      .filter((c) => c.status !== "disconnected")
      .map((c) => ({ connectionId: c.id, channel: c.channel, name: c.name, health: c.health })),
  };
}

/**
 * Daily: re-list and recreate the webhook subscriptions of every connected API connection whose
 * adapter manages them (Shopify drops shop-scoped subscriptions after repeated delivery failures).
 * The result is stored with the credentials, re-read under a row lock so a token refreshed
 * meanwhile is never overwritten; a failing topic marks the connection degraded.
 */
export async function checkWebhookSubscriptions() {
  const rows = await withSystem((tx) =>
    tx
      .select()
      .from(channelConnections)
      .where(and(eq(channelConnections.mode, "api"), eq(channelConnections.status, "connected"))),
  );
  let checked = 0;
  let degraded = 0;
  for (const row of rows) {
    const conn = toChannelConn(row);
    const adapter = await getChannelAdapter(row.channel, row.provider, row);
    if (!adapter.ensureWebhooks || !conn.credentials?.accessToken) continue;
    const state = await adapter.ensureWebhooks(conn, channelWebhookUri(row.channel));
    const message = webhookFailureMessage(state);
    checked++;
    if (message) degraded++;
    await withTenant(row.companyId, async (tx) => {
      const [cur] = await tx
        .select()
        .from(channelConnections)
        .where(eq(channelConnections.id, row.id))
        .for("update");
      if (cur?.status !== "connected") return;
      const credentials = toChannelConn(cur).credentials ?? {};
      await tx
        .update(channelConnections)
        // Health reads the degraded state from here; lastError stays the poll's (backoff, B-99).
        .set({ credentials: encryptJson({ ...credentials, webhooks: state }) })
        .where(eq(channelConnections.id, row.id));
    });
  }
  return { checked, degraded };
}

/** Record a sync/webhook/import outcome on the connection (health, alerts). */
export async function markConnection(
  tx: Tx,
  id: string,
  outcome:
    | { kind: "poll"; cursor?: string | null }
    | { kind: "webhook" }
    | { kind: "import" }
    | { kind: "error"; error: string },
) {
  const now = new Date();
  const set: Partial<typeof channelConnections.$inferInsert> =
    outcome.kind === "error"
      ? { lastError: outcome.error.slice(0, 500), lastErrorAt: now }
      : outcome.kind === "poll"
        ? {
            lastPollAt: now,
            lastError: null,
            ...(outcome.cursor !== undefined ? { cursor: outcome.cursor } : {}),
          }
        : outcome.kind === "webhook"
          ? { lastWebhookAt: now }
          : { lastImportAt: now };
  await tx.update(channelConnections).set(set).where(eq(channelConnections.id, id));
}

/* ---------------------------------- imports list ---------------------------------- */

type ImportRunRow = typeof importRuns.$inferSelect;

export function toImportReport(r: ImportRunRow): ImportReport {
  return {
    importId: r.id,
    connectionId: r.connectionId,
    format: r.format,
    fileKey: r.fileKey,
    status: r.status === "failed" ? "failed" : "completed",
    rowsTotal: r.rowsTotal,
    ordersImported: r.ordersImported,
    ordersUpdated: r.ordersUpdated,
    ordersSkipped: r.ordersSkipped,
    rowsFailed: r.rowsFailed,
    itemsNeedingMapping: r.itemsNeedingMapping,
    errors: r.errors,
    orderIds: r.orderIds,
    startedAt: r.startedAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
  };
}

export async function listImports(tx: Tx, _ctx: TenantContext, input: PageInput & { id: string }) {
  const page = keyset(importRuns.createdAt, importRuns.id, input);
  const rows = await tx
    .select()
    .from(importRuns)
    .where(and(eq(importRuns.connectionId, input.id), page.where))
    .orderBy(...page.orderBy)
    .limit(page.limit + 1);
  return page.result(rows, toImportReport);
}

/* ---------------------------------- tracking push ---------------------------------- */

export type PushTrackingResult = {
  status: "pushed" | "manual" | "not_required";
  connectionId: string;
  externalId: string | null;
  message: string | null;
};

/**
 * Push a labeled shipment's tracking for the given units to the order's channel. The shipping
 * module calls this with no transaction open, after it committed its own `pushing` intent: the
 * reads run in one short transaction, the channel is called with none open, and the audit is
 * written after. Returns `not_required` when the connection has tracking push off (or is
 * disconnected) and `manual` for channels without API access (the shop uploads it by hand).
 * Throws UPSTREAM_FAILED when the channel rejects it, so the caller can retry and record it.
 * Adapters must be safe to call again after a lost answer: Shopify only fulfills lines that
 * still have quantity remaining, so a retry doesn't notify the buyer twice.
 */
export async function pushTrackingForShipment(
  ctx: TenantContext,
  shipmentId: string,
  orderItemIds: string[],
): Promise<PushTrackingResult> {
  const plan = await withTenant(ctx.companyId, async (tx) => {
    const [shipment] = await tx
      .select()
      .from(shipments)
      .where(eq(shipments.id, shipmentId))
      .limit(1);
    if (!shipment) throw notFound("shipment", shipmentId);
    if (!shipment.trackingCode || !shipment.carrier)
      throw badRequest("Shipment has no tracking code yet");
    const [order] = await tx.select().from(orders).where(eq(orders.id, shipment.orderId)).limit(1);
    if (!order) throw notFound("order", shipment.orderId);
    const conn = await getConnectionRow(tx, order.connectionId);
    if (conn.status === "disconnected" || !settingsOf(conn).pushTracking)
      return { kind: "off" as const, connectionId: conn.id };
    // Only the units the caller checked at push time, and never a cancelled one.
    const items = orderItemIds.length
      ? await tx
          .select({ channelLineId: orderItems.channelLineId })
          .from(orderItems)
          .where(and(inArray(orderItems.id, orderItemIds), sql`${orderItems.state} <> 'cancelled'`))
      : [];
    const byLine = new Map<string, number>();
    for (const i of items) byLine.set(i.channelLineId, (byLine.get(i.channelLineId) ?? 0) + 1);
    return {
      kind: "push" as const,
      row: conn,
      channel: conn.channel,
      provider: conn.provider,
      orderId: order.id,
      push: {
        channelOrderId: order.channelOrderId,
        carrier: shipment.carrier,
        trackingCode: shipment.trackingCode,
        trackingUrl: shipment.trackingUrl,
        items: [...byLine].map(([channelLineId, quantity]) => ({ channelLineId, quantity })),
      },
    };
  });
  if (plan.kind === "off") {
    return {
      status: "not_required",
      connectionId: plan.connectionId,
      externalId: null,
      message: "Tracking push is off for this channel",
    };
  }

  const adapter = await getChannelAdapter(plan.channel, plan.provider, ctx);
  const conn = await freshChannelConn(plan.row);
  const result = await adapter.pushTracking(conn, plan.push);
  await withTenant(ctx.companyId, (tx) =>
    audit(tx, {
      companyId: ctx.companyId,
      actor: ctx.actor,
      action: "tracking.pushed",
      entityType: "order",
      entityId: plan.orderId,
      summary:
        result.status === "pushed"
          ? `Tracking ${plan.push.trackingCode} pushed to ${CHANNEL_RULES[plan.channel].label}`
          : (result.message ?? "Tracking needs a manual upload"),
      data: { shipmentId, status: result.status, externalId: result.externalId },
    }),
  );
  return {
    status: result.status,
    connectionId: conn.id,
    externalId: result.externalId,
    message: result.message,
  };
}

/** Latest import runs across connections (for Today / onboarding). */
export async function recentImports(tx: Tx, limit = 10) {
  const rows = await tx.select().from(importRuns).orderBy(desc(importRuns.startedAt)).limit(limit);
  return rows.map(toImportReport);
}
