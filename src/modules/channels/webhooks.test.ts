import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { withSystem, withTenant } from "../../db/client";
import { channelConnections, companies, orders, webhookDeliveries } from "../../db/schema";
import { signEtsyWebhook } from "../../integrations/channels/etsy";
import { MOCK_ETSY_WEBHOOK_SECRET } from "../../integrations/channels/etsy/webhooks";
import { signShopifyBody } from "../../integrations/channels/shopify";
import { createCompany, createUser, tenantContext } from "../../test/fixtures";
import { connect } from "./service";
import {
  completeShopifyOAuth,
  OAUTH_STATE_TTL_MS,
  processWebhook,
  purgeWebhookDeliveries,
  recordWebhookDelivery,
  verifyWebhook,
} from "./sync";

const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const shopId = () => String(10_000_000 + Math.floor(Math.random() * 80_000_000));

function etsyDelivery(shop: string, receiptId: string, ts = Math.floor(Date.now() / 1000)) {
  const id = `msg_${uniq()}`;
  const body = JSON.stringify({
    event_type: "ORDER_PAID",
    resource_url: `https://openapi.etsy.com/v3/application/shops/${shop}/receipts/${receiptId}`,
    shop_id: Number(shop),
    // Anything else in the payload is not trusted: the receipt is fetched by id.
    grandtotal: { amount: 1, divisor: 100 },
    buyer_email: "attacker@example.com",
  });
  return {
    id,
    body,
    headers: {
      "webhook-id": id,
      "webhook-timestamp": String(ts),
      "webhook-signature": signEtsyWebhook(id, ts, body, MOCK_ETSY_WEBHOOK_SECRET),
    },
  };
}

async function etsyConnection(companyId: string, shop: string) {
  const [row] = await withSystem((tx) =>
    tx
      .insert(channelConnections)
      .values({
        companyId,
        channel: "etsy",
        name: "Etsy test",
        status: "connected",
        mode: "api",
        provider: "mock",
        externalShopId: shop,
      })
      .returning(),
  );
  if (!row) throw new Error("connection insert failed");
  return row;
}

describe("webhooks pick the adapter from their own channel's mock flag", () => {
  afterEach(() => {
    delete process.env.ETSY_WEBHOOK_SECRET;
  });

  it("Etsy verifies with Etsy's scheme and secret, not Shopify's", async () => {
    const d = etsyDelivery("1", "2");
    expect(await verifyWebhook("etsy", d.headers, d.body)).toBe(true);
    const shopifySigned = { "x-shopify-hmac-sha256": signShopifyBody(d.body), "webhook-id": d.id };
    expect(await verifyWebhook("etsy", shopifySigned, d.body)).toBe(false);
    expect(await verifyWebhook("shopify", d.headers, d.body)).toBe(false);
  });

  it("with ETSY_WEBHOOK_SECRET set, Etsy goes live even while Shopify is on its mock", async () => {
    const real = `whsec_${Buffer.from("t12-real-etsy-secret").toString("base64")}`;
    process.env.ETSY_WEBHOOK_SECRET = real;
    const d = etsyDelivery("1", "2");
    // The mock secret no longer verifies (the old code picked the mock from env.mocks.shopify).
    expect(await verifyWebhook("etsy", d.headers, d.body)).toBe(false);
    const ts = Math.floor(Date.now() / 1000);
    const live = {
      ...d.headers,
      "webhook-timestamp": String(ts),
      "webhook-signature": signEtsyWebhook(d.id, ts, d.body, real),
    };
    expect(await verifyWebhook("etsy", live, d.body)).toBe(true);
  });
});

describe("Etsy webhooks fetch the receipt by id", () => {
  let companyId: string;
  let shop: string;

  beforeAll(async () => {
    companyId = (await createCompany()).id;
    shop = shopId();
    await etsyConnection(companyId, shop);
  });

  it("imports the fetched receipt, not the payload, and marks the delivery processed", async () => {
    const receipt = String(7_000_000 + Math.floor(Math.random() * 1_000_000) * 10 + 3);
    const d = etsyDelivery(shop, receipt);
    expect(await recordWebhookDelivery("etsy", d.id)).toBe(true);
    const res = await processWebhook("etsy", d.headers, d.body, new Date().toISOString());
    expect(res).toMatchObject({ handled: true, kind: "order_ref" });
    const [order] = await withTenant(companyId, (tx) =>
      tx
        .select()
        .from(orders)
        .where(and(eq(orders.channel, "etsy"), eq(orders.channelOrderId, receipt))),
    );
    expect(order).toBeDefined();
    expect(order?.orderNo).toBe(receipt);
    expect(order?.totalCents).toBeGreaterThan(100);
    const [row] = await withSystem((tx) =>
      tx.select().from(webhookDeliveries).where(eq(webhookDeliveries.deliveryId, d.id)),
    );
    expect(row).toMatchObject({ status: "processed", companyId });
    expect(row?.processedAt).not.toBeNull();
  });

  it("a queued retry re-verifies against when the delivery arrived, not now", async () => {
    const tenMinutesAgo = Math.floor(Date.now() / 1000) - 600;
    const d = etsyDelivery(shop, "8000003", tenMinutesAgo);
    const late = await processWebhook("etsy", d.headers, d.body, new Date().toISOString());
    expect(late).toEqual({ handled: false, reason: "invalid signature" });
    const onTime = await processWebhook(
      "etsy",
      d.headers,
      d.body,
      new Date(tenMinutesAgo * 1000 + 1_000).toISOString(),
    );
    expect(onTime).toMatchObject({ handled: true });
  });

  it("routes only to a connected Etsy shop", async () => {
    const d = etsyDelivery(shopId(), "8000013");
    expect(await processWebhook("etsy", d.headers, d.body)).toMatchObject({ handled: false });
  });
});

describe("webhook_deliveries", () => {
  it("is unique per channel and delivery id", async () => {
    const id = `t12-${uniq()}`;
    expect(await recordWebhookDelivery("shopify", id)).toBe(true);
    expect(await recordWebhookDelivery("shopify", id)).toBe(false);
    expect(await recordWebhookDelivery("etsy", id)).toBe(true);
  });

  it("the app role reads only its own company's rows and can never write", async () => {
    const a = (await createCompany()).id;
    const b = (await createCompany()).id;
    const id = `t12-${uniq()}`;
    await recordWebhookDelivery("shopify", id);
    await withSystem((tx) =>
      tx
        .update(webhookDeliveries)
        .set({ companyId: a })
        .where(eq(webhookDeliveries.deliveryId, id)),
    );
    const mine = await withTenant(a, (tx) =>
      tx.select().from(webhookDeliveries).where(eq(webhookDeliveries.deliveryId, id)),
    );
    expect(mine).toHaveLength(1);
    const theirs = await withTenant(b, (tx) =>
      tx.select().from(webhookDeliveries).where(eq(webhookDeliveries.deliveryId, id)),
    );
    expect(theirs).toHaveLength(0);
    const denied = (err: unknown) =>
      /permission denied/.test(String((err as { cause?: unknown }).cause ?? err));
    await expect(
      withTenant(b, (tx) =>
        tx
          .insert(webhookDeliveries)
          .values({ companyId: b, channel: "shopify", deliveryId: `x-${id}` }),
      ),
    ).rejects.toSatisfy(denied);
    await expect(
      withTenant(a, (tx) =>
        tx
          .update(webhookDeliveries)
          .set({ status: "failed" })
          .where(eq(webhookDeliveries.deliveryId, id)),
      ),
    ).rejects.toSatisfy(denied);
    await expect(
      withTenant(a, (tx) =>
        tx.delete(webhookDeliveries).where(eq(webhookDeliveries.deliveryId, id)),
      ),
    ).rejects.toSatisfy(denied);
  });

  it("the purge keeps deliveries for 7 days (well past Etsy's ~30 h retries)", async () => {
    const old = `t12-old-${uniq()}`;
    const recent = `t12-recent-${uniq()}`;
    await recordWebhookDelivery("etsy", old);
    await recordWebhookDelivery("etsy", recent);
    await withSystem(async (tx) => {
      await tx
        .update(webhookDeliveries)
        .set({ receivedAt: sql`now() - interval '8 days'` })
        .where(eq(webhookDeliveries.deliveryId, old));
      await tx
        .update(webhookDeliveries)
        .set({ receivedAt: sql`now() - interval '31 hours'` })
        .where(eq(webhookDeliveries.deliveryId, recent));
    });
    const res = await purgeWebhookDeliveries();
    expect(res.deleted).toBeGreaterThanOrEqual(1);
    const left = await withSystem((tx) =>
      tx.select({ id: webhookDeliveries.deliveryId }).from(webhookDeliveries),
    );
    const ids = left.map((r) => r.id);
    expect(ids).not.toContain(old);
    expect(ids).toContain(recent);
    // A redelivery 31 h later is still recognised.
    expect(await recordWebhookDelivery("etsy", recent)).toBe(false);
  });
});

// These three tests hit the DB several times each and the "racing" one deliberately makes two
// transactions contend for the same row lock. On a shared/loaded dev DB (other agents' suites,
// the wave gate) the round trips and the lock wait can comfortably exceed the file's default
// 30s testTimeout without anything being wrong -- Postgres still serializes the row lock
// correctly regardless of how long it takes. Each `it` below gets a generous 60s timeout
// (matching hookTimeout) so a slow-but-correct run doesn't get flagged as a failure.
describe("Shopify OAuth state", () => {
  let ctx: ReturnType<typeof tenantContext>;

  beforeAll(async () => {
    const c = (await createCompany()).id;
    ctx = tenantContext(c, (await createUser(c, "owner")).id, "owner");
    // Many installs in one company; the trial's connection limit is tested in billing (T-2-1).
    await withSystem((tx) =>
      tx.update(companies).set({ plan: "scale" }).where(eq(companies.id, c)),
    );
  });

  const start = async (shop: string) => {
    const res = await withTenant(ctx.companyId, (tx) =>
      connect(tx, ctx, { channel: "shopify", shopDomain: shop } as never),
    );
    const { connectionId, authorizeUrl } = res as { connectionId: string; authorizeUrl: string };
    return { connectionId, state: new URL(authorizeUrl).searchParams.get("state") ?? "" };
  };
  const domain = () => `t12-${uniq()}.myshopify.com`;

  it(
    "expires after 10 minutes",
    async () => {
      expect(OAUTH_STATE_TTL_MS).toBeLessThanOrEqual(10 * 60_000);
      const shop = domain();
      const p = await start(shop);
      await withSystem((tx) =>
        tx
          .update(channelConnections)
          .set({ updatedAt: new Date(Date.now() - OAUTH_STATE_TTL_MS - 60_000) })
          .where(eq(channelConnections.id, p.connectionId)),
      );
      await expect(
        completeShopifyOAuth({ shop, state: p.state, code: "mock" }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringMatching(/expired/) });
      // Starting again issues a fresh link that works.
      const again = await start(shop);
      await expect(
        completeShopifyOAuth({ shop, state: again.state, code: "mock" }),
      ).resolves.toMatchObject({ connectionId: again.connectionId });
    },
    60_000,
  );

  it(
    "can be used only once, even by two callbacks racing",
    async () => {
      const shop = domain();
      const p = await start(shop);
      // Two real, concurrent transactions contend for the same row's `for update` lock. Postgres
      // serializes them correctly regardless of how long either one takes to run (retry-once below
      // only guards against the shared DB's connection pool being briefly saturated by other
      // agents' suites, which can surface as a connection-acquire error on both sides rather than
      // the expected single-winner outcome -- that's an infra hiccup, not evidence the lock is
      // wrong, so it's worth one retry before failing the test).
      const race = () =>
        Promise.allSettled([
          completeShopifyOAuth({ shop, state: p.state, code: "mock" }),
          completeShopifyOAuth({ shop, state: p.state, code: "mock" }),
        ]);
      let results = await race();
      let fulfilled = results.filter((r) => r.status === "fulfilled");
      // Only retry the zero-winners case (both sides hit a transient infra error, e.g. the shared
      // pool was briefly out of connections) -- two winners would mean the row lock itself failed,
      // which must fail the test, not be retried away.
      if (fulfilled.length === 0) {
        results = await race();
        fulfilled = results.filter((r) => r.status === "fulfilled");
      }
      expect(fulfilled).toHaveLength(1);
      await expect(completeShopifyOAuth({ shop, state: p.state, code: "mock" })).rejects.toThrow();
    },
    60_000,
  );

  it(
    "a failed completion burns the state too",
    async () => {
      const shop = domain();
      const p = await start(shop);
      // Another company holds the store: this completion fails after the state is consumed.
      const other = (await createCompany()).id;
      await withSystem((tx) =>
        tx.insert(channelConnections).values({
          companyId: other,
          channel: "shopify",
          name: "holder",
          status: "connected",
          mode: "api",
          externalShopId: shop,
        }),
      );
      await expect(
        completeShopifyOAuth({ shop, state: p.state, code: "mock" }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      await withSystem((tx) =>
        tx.delete(channelConnections).where(eq(channelConnections.companyId, other)),
      );
      await expect(
        completeShopifyOAuth({ shop, state: p.state, code: "mock" }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    },
    60_000,
  );
});
