import { and, eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { withSystem, withTenant } from "../../db/client";
import {
  auditLog,
  channelConnections,
  orders,
  outboxEvents,
  subscriptions,
  webhookDeliveries,
} from "../../db/schema";
import { mockShopifySubscriptions, signShopifyBody } from "../../integrations/channels/shopify";
import type { ChannelCredentials } from "../../integrations/channels/types";
import { decryptJson, encryptJson } from "../../lib/crypto";
import { createCompany, createLocation, createUser, tenantContext } from "../../test/fixtures";
import {
  checkWebhookSubscriptions,
  connect,
  disconnect,
  freshChannelConn,
  health,
  refreshConnectionToken,
  refreshExpiringTokens,
} from "./service";
import {
  completeShopifyOAuth,
  pollableConnections,
  processWebhook,
  recordWebhookDelivery,
  syncConnection,
} from "./sync";

const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const orderId = () => String(7_000_000_000 + Math.floor(Math.random() * 900_000_000));

function shopifyDelivery(shop: string, topic: string, payload: unknown) {
  const body = JSON.stringify(payload);
  const id = `t31-${uniq()}`;
  return {
    id,
    body,
    headers: {
      "x-shopify-topic": topic,
      "x-shopify-shop-domain": shop,
      "x-shopify-webhook-id": id,
      "x-shopify-hmac-sha256": signShopifyBody(body),
    },
  };
}

async function shopifyConnection(companyId: string, shop: string, over = {}) {
  const [row] = await withSystem((tx) =>
    tx
      .insert(channelConnections)
      .values({
        companyId,
        channel: "shopify",
        name: "Shopify test",
        status: "connected",
        mode: "api",
        provider: "mock",
        externalShopId: shop,
        ...over,
      })
      .returning(),
  );
  if (!row) throw new Error("connection insert failed");
  return row;
}

const restOrder = (id: string, financial_status: string, over = {}) => ({
  id: Number(id),
  name: `#T31-${id.slice(-4)}`,
  created_at: new Date().toISOString(),
  financial_status,
  email: "buyer@example.com",
  shipping_address: {
    name: "Test Buyer",
    address1: "1 Main St",
    city: "Phoenix",
    province_code: "AZ",
    zip: "85001",
    country_code: "US",
  },
  line_items: [{ id: Number(id) + 1, sku: "T31-UNKNOWN", title: "Tee", quantity: 1, price: "20" }],
  ...over,
});

async function deliver(d: ReturnType<typeof shopifyDelivery>) {
  expect(await recordWebhookDelivery("shopify", d.id)).toBe(true);
  return processWebhook("shopify", d.headers, d.body, new Date().toISOString());
}

const findOrder = (companyId: string, channelOrderId: string) =>
  withSystem((tx) =>
    tx
      .select()
      .from(orders)
      .where(and(eq(orders.companyId, companyId), eq(orders.channelOrderId, channelOrderId))),
  );

describe("Shopify order webhooks import paid orders only", () => {
  let companyId: string;
  let shop: string;
  beforeAll(async () => {
    companyId = (await createCompany()).id;
    await createLocation(companyId);
    shop = `t31-${uniq()}.myshopify.com`;
    await shopifyConnection(companyId, shop);
  });

  it("a pending (or cash-on-delivery) order is skipped and the reason logged on the delivery", async () => {
    const id = orderId();
    const d = shopifyDelivery(shop, "orders/create", restOrder(id, "pending"));
    const res = await deliver(d);
    expect(res).toMatchObject({ handled: false, reason: expect.stringContaining("not paid") });
    expect(await findOrder(companyId, id)).toHaveLength(0);
    const [row] = await withSystem((tx) =>
      tx.select().from(webhookDeliveries).where(eq(webhookDeliveries.deliveryId, d.id)),
    );
    expect(row?.status).toBe("ignored");
    expect(row?.detail).toContain("pending");
  });

  it("the same order is imported once Shopify reports it paid", async () => {
    const id = orderId();
    await deliver(shopifyDelivery(shop, "orders/create", restOrder(id, "pending")));
    const res = await deliver(shopifyDelivery(shop, "orders/paid", restOrder(id, "paid")));
    expect(res).toMatchObject({ handled: true, kind: "order_upsert" });
    expect(await findOrder(companyId, id)).toHaveLength(1);
  });

  it("a fully refunded order cancels what was imported", async () => {
    const id = orderId();
    await deliver(shopifyDelivery(shop, "orders/create", restOrder(id, "paid")));
    const res = await deliver(shopifyDelivery(shop, "orders/updated", restOrder(id, "refunded")));
    expect(res).toMatchObject({ handled: true, kind: "order_cancelled" });
    const [o] = await findOrder(companyId, id);
    expect(o?.status).toBe("cancelled");
  });

  // T-8-6 (follow-up to T-8-2 r3 / OI-5): a NUL byte reaching `orders.buyerNote` from a webhook
  // payload used to crash the insert the same way a CSV row or an oRPC input did. This goes
  // through the real webhook path (signature check, adapter parse, importNormalizedOrders), not
  // just the shared helper in isolation.
  it("a NUL byte in the order's note doesn't crash the webhook import", async () => {
    const id = orderId();
    const d = shopifyDelivery(
      shop,
      "orders/create",
      restOrder(id, "paid", { note: "Gift wrap please\u0000!!" }),
    );
    const res = await deliver(d);
    expect(res).toMatchObject({ handled: true, kind: "order_upsert" });
    const [o] = await findOrder(companyId, id);
    expect(o?.buyerNote).toBe("Gift wrap please!!");
  });
});

describe("Shopify webhook subscriptions and disconnect", () => {
  let ctx: ReturnType<typeof tenantContext>;

  // A fresh shop per test (the trial plan allows one connection).
  const install = async () => {
    const companyId = (await createCompany()).id;
    ctx = tenantContext(companyId, (await createUser(companyId, "owner")).id, "owner");
    const shop = `t31-${uniq()}.myshopify.com`;
    const res = (await withTenant(ctx.companyId, (tx) =>
      connect(tx, ctx, { channel: "shopify", shopDomain: shop }),
    )) as { connectionId: string; authorizeUrl: string };
    const state = new URL(res.authorizeUrl).searchParams.get("state") ?? "";
    await completeShopifyOAuth({ shop, state, code: "mock" });
    return res.connectionId;
  };

  const row = async (id: string) => {
    const [r] = await withSystem((tx) =>
      tx.select().from(channelConnections).where(eq(channelConnections.id, id)),
    );
    if (!r) throw new Error("no connection");
    return r;
  };

  it("OAuth subscribes the order webhooks and keeps their ids with the credentials", async () => {
    const id = await install();
    expect(mockShopifySubscriptions(id)).toHaveLength(4);
    const creds = decryptJson<ChannelCredentials>((await row(id)).credentials ?? "");
    expect(creds.webhooks?.subscriptionIds).toEqual(mockShopifySubscriptions(id));
    const h = await withTenant(ctx.companyId, (tx) => health(tx, ctx));
    expect(h.items.find((i) => i.connectionId === id)?.health).toMatchObject({ lastError: null });
  });

  it("a failed subscription shows the connection as degraded in channels.health", async () => {
    const id = await install();
    const creds = decryptJson<ChannelCredentials>((await row(id)).credentials ?? "");
    await withSystem((tx) =>
      tx
        .update(channelConnections)
        .set({
          lastPollAt: new Date(),
          credentials: encryptJson({
            ...creds,
            webhooks: {
              checkedAt: new Date().toISOString(),
              subscriptionIds: [],
              failures: [{ topic: "ORDERS_UPDATED", message: "Access denied" }],
            },
          }),
        })
        .where(eq(channelConnections.id, id)),
    );
    const item = (await withTenant(ctx.companyId, (tx) => health(tx, ctx))).items.find(
      (i) => i.connectionId === id,
    );
    expect((await row(id)).status).toBe("connected");
    expect(item?.health.ok).toBe(false);
    expect(item?.health.lastError).toContain("ORDERS_UPDATED (Access denied)");
    // The daily check re-subscribes (the mock store accepts) and clears the degraded state.
    await checkWebhookSubscriptions();
    const after = (await withTenant(ctx.companyId, (tx) => health(tx, ctx))).items.find(
      (i) => i.connectionId === id,
    );
    expect(after?.health.ok).toBe(true);
  });

  it("disconnect unsubscribes the webhooks and uninstalls, then drops the credentials", async () => {
    const id = await install();
    expect(mockShopifySubscriptions(id)).toHaveLength(4);
    await withTenant(ctx.companyId, (tx) => disconnect(tx, ctx, id));
    expect(mockShopifySubscriptions(id)).toHaveLength(0);
    const r = await row(id);
    expect(r.status).toBe("disconnected");
    expect(r.credentials).toBeNull();
    const logs = await withSystem((tx) =>
      tx.select().from(auditLog).where(eq(auditLog.entityId, id)),
    );
    expect(logs.map((l) => l.summary)).toContain(
      "Shopify: 4 webhook subscription(s) removed; app uninstalled and access revoked",
    );
  });
});

describe("Shopify token refresh (expiring offline tokens)", () => {
  afterEach(() => vi.unstubAllGlobals());

  async function liveConnection(expiresInMs: number) {
    const companyId = (await createCompany()).id;
    return shopifyConnection(companyId, `t31-${uniq()}.myshopify.com`, {
      provider: "live",
      credentials: encryptJson({
        accessToken: "shpat_old",
        refreshToken: "shprt_old",
        expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
      }),
    });
  }

  const credsOf = async (id: string) => {
    const [r] = await withSystem((tx) =>
      tx.select().from(channelConnections).where(eq(channelConnections.id, id)),
    );
    return { row: r, creds: decryptJson<ChannelCredentials>(r?.credentials ?? "") };
  };

  function stubRefresh(status = 200) {
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        n++;
        await new Promise((r) => setTimeout(r, 50));
        return new Response(
          JSON.stringify(
            status === 200
              ? {
                  access_token: `shpat_new_${n}`,
                  expires_in: 3600,
                  refresh_token: `shprt_new_${n}`,
                  refresh_token_expires_in: 7776000,
                }
              : { error: "invalid_grant" },
          ),
          { status },
        );
      }),
    );
    return () => n;
  }

  it(
    "refreshes before expiry and stores the rotated access and refresh tokens",
    async () => {
      const conn = await liveConnection(5 * 60_000);
      const calls = stubRefresh();
      const fresh = await freshChannelConn(conn);
      expect(calls()).toBe(1);
      expect(fresh.credentials?.accessToken).toBe("shpat_new_1");
      const { creds } = await credsOf(conn.id);
      expect(creds).toMatchObject({ accessToken: "shpat_new_1", refreshToken: "shprt_new_1" });
      // The mock issues a 60-minute token (expires_in: 3600) from whenever the refresh call ran.
      // Comparing against `Date.now()` here (after the refresh call, the DB round trip and any
      // host contention in between) only had a 10-minute margin, which a slow/shared dev DB can
      // burn through; 40 minutes leaves real headroom while still proving the new expiry is well
      // in the future rather than reusing the old ~5-minute one.
      expect(new Date(creds.expiresAt ?? 0).getTime()).toBeGreaterThan(Date.now() + 40 * 60_000);
    },
    60_000,
  );

  it("leaves a token with time left alone", async () => {
    const conn = await liveConnection(50 * 60_000);
    const calls = stubRefresh();
    expect((await freshChannelConn(conn)).credentials?.accessToken).toBe("shpat_old");
    expect(calls()).toBe(0);
  });

  it(
    "two workers at once spend the refresh token once (row lock)",
    async () => {
      // Real row-locked concurrency, same reasoning as the OAuth-state race in
      // webhooks.test.ts: correct regardless of speed, but a shared/loaded dev DB can make the
      // lock wait long enough to trip the file's default 30s timeout on an otherwise-passing run.
      const conn = await liveConnection(60_000);
      const calls = stubRefresh();
      const [a, b] = await Promise.all([
        refreshConnectionToken(conn.companyId, conn.id),
        refreshConnectionToken(conn.companyId, conn.id),
      ]);
      expect(calls()).toBe(1);
      expect(a?.credentials?.accessToken).toBe("shpat_new_1");
      expect(b?.credentials?.accessToken).toBe("shpat_new_1");
    },
    60_000,
  );

  it("a refused refresh flags the connection in health and keeps the old credentials", async () => {
    const conn = await liveConnection(60_000);
    stubRefresh(401);
    const res = await refreshExpiringTokens();
    expect(res.failed).toBeGreaterThanOrEqual(1);
    const { row, creds } = await credsOf(conn.id);
    expect(creds.refreshToken).toBe("shprt_old");
    expect(creds.refreshError).toMatchObject({ permanent: true });
    expect(row?.lastError).toContain("Reconnect the store");
    const ctx = tenantContext(conn.companyId, null as never, "owner");
    const item = (await withTenant(conn.companyId, (tx) => health(tx, ctx))).items.find(
      (i) => i.connectionId === conn.id,
    );
    expect(item?.health.ok).toBe(false);
  });
});

describe("the poller skips connections that can only fail (B-99)", () => {
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

  it("skips pending-approval channels, failing connections inside the backoff and expired trials", async () => {
    const co = (await createCompany()).id;
    const ok = await shopifyConnection(co, `t31-${uniq()}.myshopify.com`);
    const amazon = await shopifyConnection(co, `t31-amz-${uniq()}`, {
      channel: "amazon",
      status: "error",
      lastError: "Amazon API access is pending marketplace approval; use CSV import",
      lastErrorAt: minutesAgo(600),
    });
    const failingRecent = await shopifyConnection(co, `t31-${uniq()}.myshopify.com`, {
      lastPollAt: minutesAgo(30),
      lastErrorAt: minutesAgo(5),
    });
    const failingOld = await shopifyConnection(co, `t31-${uniq()}.myshopify.com`, {
      lastPollAt: minutesAgo(300),
      lastErrorAt: minutesAgo(90),
    });
    const recovered = await shopifyConnection(co, `t31-${uniq()}.myshopify.com`, {
      lastErrorAt: minutesAgo(20),
      lastPollAt: minutesAgo(5),
    });
    const expired = (await createCompany()).id;
    await withSystem((tx) =>
      tx.insert(subscriptions).values({
        companyId: expired,
        planKey: "trial",
        status: "trialing",
        trialEndsAt: minutesAgo(60),
      }),
    );
    const expiredConn = await shopifyConnection(expired, `t31-${uniq()}.myshopify.com`);

    const ids = new Set((await pollableConnections()).map((c) => c.id));
    expect(ids.has(ok.id)).toBe(true);
    expect(ids.has(recovered.id)).toBe(true);
    expect(ids.has(failingOld.id)).toBe(true);
    expect(ids.has(amazon.id)).toBe(false);
    expect(ids.has(failingRecent.id)).toBe(false);
    expect(ids.has(expiredConn.id)).toBe(false);
  });

  it("a failing connection emits sync_failed once per outage, not on every retry", async () => {
    const co = (await createCompany()).id;
    const conn = await shopifyConnection(co, `t31-amz-${uniq()}`, { channel: "amazon" });
    await expect(syncConnection(co, conn.id)).rejects.toThrow();
    await expect(syncConnection(co, conn.id)).rejects.toThrow();
    await expect(syncConnection(co, conn.id)).rejects.toThrow();
    const events = await withSystem((tx) =>
      tx
        .select()
        .from(outboxEvents)
        .where(
          and(eq(outboxEvents.companyId, co), eq(outboxEvents.name, "connection.sync_failed")),
        ),
    );
    expect(events).toHaveLength(1);
  });
});
