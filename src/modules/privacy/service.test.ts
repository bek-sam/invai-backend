import { and, eq, inArray } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { app } from "../../api/app";
import { withSystem } from "../../db/client";
import {
  buyerPii,
  channelConnections,
  orderItems,
  orders,
  privacyRequests,
  webhookDeliveries,
} from "../../db/schema";
import { signShopifyBody } from "../../integrations/channels/shopify";
import { headObject } from "../../lib/s3";
import { createCompany, createLocation } from "../../test/fixtures";
import { processWebhook, recordWebhookDelivery } from "../channels/sync";
import { warnOverduePrivacyRequests } from "./service";

const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const orderId = () => String(8_000_000_000 + Math.floor(Math.random() * 900_000_000));

function signed(shop: string, topic: string, payload: unknown, over: Record<string, string> = {}) {
  const body = JSON.stringify(payload);
  const id = `t31p-${uniq()}`;
  return {
    id,
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-shopify-topic": topic,
        "x-shopify-shop-domain": shop,
        "x-shopify-webhook-id": id,
        "x-shopify-hmac-sha256": signShopifyBody(body),
        ...over,
      },
      body,
    },
  };
}

const post = (d: ReturnType<typeof signed>) => app.request("/webhooks/shopify", d.init);

async function importPaid(shop: string, id: string) {
  const body = JSON.stringify({
    id: Number(id),
    name: `#P${id.slice(-4)}`,
    created_at: new Date().toISOString(),
    financial_status: "paid",
    email: "private.buyer@example.com",
    note: "Leave at the back door",
    shipping_address: {
      name: "Private Buyer",
      address1: "9 Secret Ln",
      city: "Phoenix",
      province_code: "AZ",
      zip: "85001",
      country_code: "US",
    },
    line_items: [
      {
        id: Number(id) + 1,
        sku: "T31-P",
        title: "Tee",
        quantity: 1,
        price: "20",
        properties: [{ name: "Name on back", value: "PRIVATE" }],
      },
    ],
  });
  const wid = `t31i-${uniq()}`;
  await recordWebhookDelivery("shopify", wid);
  const res = await processWebhook(
    "shopify",
    {
      "x-shopify-topic": "orders/create",
      "x-shopify-shop-domain": shop,
      "x-shopify-webhook-id": wid,
      "x-shopify-hmac-sha256": signShopifyBody(body),
    },
    body,
  );
  expect(res).toMatchObject({ handled: true });
  const [o] = await withSystem((tx) =>
    tx
      .select()
      .from(orders)
      .where(and(eq(orders.channel, "shopify"), eq(orders.channelOrderId, id))),
  );
  if (!o) throw new Error("order not imported");
  return o;
}

async function setup() {
  const companyId = (await createCompany()).id;
  await createLocation(companyId);
  const shop = `t31p-${uniq()}.myshopify.com`;
  const [conn] = await withSystem((tx) =>
    tx
      .insert(channelConnections)
      .values({
        companyId,
        channel: "shopify",
        name: "Privacy test",
        status: "connected",
        mode: "api",
        provider: "mock",
        externalShopId: shop,
      })
      .returning(),
  );
  if (!conn) throw new Error("connection insert failed");
  return { companyId, shop, conn };
}

const piiOf = (ids: string[]) =>
  withSystem((tx) => tx.select().from(buyerPii).where(inArray(buyerPii.orderId, ids)));
const requestsOf = (companyId: string) =>
  withSystem((tx) =>
    tx.select().from(privacyRequests).where(eq(privacyRequests.companyId, companyId)),
  );
const objectExists = async (key: string) => (await headObject(key)).exists;

describe("Shopify compliance webhooks", () => {
  let s: Awaited<ReturnType<typeof setup>>;
  beforeAll(async () => {
    s = await setup();
  });

  it("a bad HMAC gets 401 and nothing is recorded", async () => {
    const d = signed(s.shop, "customers/redact", { shop_domain: s.shop, orders_to_redact: [] });
    const res = await post({
      ...d,
      init: { ...d.init, headers: { ...d.init.headers, "x-shopify-hmac-sha256": "bad" } },
    });
    expect(res.status).toBe(401);
    const rows = await withSystem((tx) =>
      tx.select().from(webhookDeliveries).where(eq(webhookDeliveries.deliveryId, d.id)),
    );
    expect(rows).toHaveLength(0);
  });

  it("customers/redact removes that customer's PII before the 200 and keeps order facts", async () => {
    const mine = await importPaid(s.shop, orderId());
    const other = await importPaid(s.shop, orderId());
    expect(mine.rawPayloadKey).not.toBeNull();
    const rawKey = mine.rawPayloadKey as string;
    expect(await objectExists(rawKey)).toBe(true);

    const d = signed(s.shop, "customers/redact", {
      shop_id: 1,
      shop_domain: s.shop,
      customer: { id: 191167, email: "private.buyer@example.com", phone: "555-625-1199" },
      orders_to_redact: [Number(mine.channelOrderId)],
    });
    const res = await post(d);
    expect(res.status).toBe(200);

    // Already gone when the 200 arrived.
    expect(await piiOf([mine.id])).toHaveLength(0);
    expect(await objectExists(rawKey)).toBe(false);
    const [after] = await withSystem((tx) =>
      tx.select().from(orders).where(eq(orders.id, mine.id)),
    );
    expect(after).toMatchObject({
      buyerNote: null,
      buyerRef: null,
      rawPayloadKey: null,
      totalCents: mine.totalCents,
      orderNo: mine.orderNo,
    });
    const items = await withSystem((tx) =>
      tx.select().from(orderItems).where(eq(orderItems.orderId, mine.id)),
    );
    expect(items[0]?.personalization).toEqual([
      { question: "Name on back", answer: null, fileUrl: null },
    ]);
    // Another customer's order is untouched.
    expect(await piiOf([other.id])).toHaveLength(1);

    const reqs = (await requestsOf(s.companyId)).filter((r) => r.deliveryId === d.id);
    expect(reqs).toHaveLength(1);
    expect(reqs[0]).toMatchObject({
      topic: "customers/redact",
      status: "completed",
      channelCustomerId: "191167",
      channelOrderIds: [mine.channelOrderId],
      counts: { orders: 1, buyerPii: 1, rawPayloads: 1, personalizedItems: 1 },
    });
    // No PII in the record.
    expect(JSON.stringify(reqs[0])).not.toContain("private.buyer");
    expect(JSON.stringify(reqs[0])).not.toContain("555-625");

    // A redelivery is acknowledged and records nothing new.
    const again = await post(d);
    expect(await again.json()).toMatchObject({ duplicate: true });
    expect((await requestsOf(s.companyId)).filter((r) => r.deliveryId === d.id)).toHaveLength(1);
  });

  it("a redact can only reach orders from the store that sent it", async () => {
    const victim = await setup();
    const o = await importPaid(victim.shop, orderId());
    const attacker = await setup();
    const res = await post(
      signed(attacker.shop, "customers/redact", {
        shop_domain: attacker.shop,
        customer: { id: 1 },
        orders_to_redact: [Number(o.channelOrderId)],
      }),
    );
    expect(res.status).toBe(200);
    expect(await piiOf([o.id])).toHaveLength(1);
  });

  it("the shop comes from the signed body; an unsigned header naming another shop is refused", async () => {
    const victim = await setup();
    const o = await importPaid(victim.shop, orderId());
    const d = signed(
      "t31-attacker.myshopify.com",
      "shop/redact",
      { shop_domain: "t31-attacker.myshopify.com" },
      { "x-shopify-shop-domain": victim.shop },
    );
    expect((await post(d)).status).toBe(200);
    expect(await piiOf([o.id])).toHaveLength(1);
  });

  it("customers/data_request opens a request for the owner, due in 30 days", async () => {
    const d = signed(s.shop, "customers/data_request", {
      shop_domain: s.shop,
      customer: { id: 191167, email: "private.buyer@example.com" },
      orders_requested: [299938, 280263],
      data_request: { id: 9999 },
    });
    expect((await post(d)).status).toBe(200);
    const [r] = (await requestsOf(s.companyId)).filter((x) => x.deliveryId === d.id);
    expect(r).toMatchObject({
      topic: "customers/data_request",
      status: "open",
      channelRequestId: "9999",
      channelOrderIds: ["299938", "280263"],
    });
    expect((r?.dueAt.getTime() ?? 0) - (r?.receivedAt.getTime() ?? 0)).toBe(30 * 86400_000);
    const later = new Date(Date.now() + 21 * 86400_000);
    expect((await warnOverduePrivacyRequests(later)).overdue).toBeGreaterThanOrEqual(1);
  });

  it("shop/redact after uninstall removes PII from every order of that store", async () => {
    const t = await setup();
    const a = await importPaid(t.shop, orderId());
    const b = await importPaid(t.shop, orderId());
    await withSystem((tx) =>
      tx
        .update(channelConnections)
        .set({ status: "disconnected", credentials: null })
        .where(eq(channelConnections.id, t.conn.id)),
    );
    const res = await post(signed(t.shop, "shop/redact", { shop_id: 1, shop_domain: t.shop }));
    expect(res.status).toBe(200);
    expect(await piiOf([a.id, b.id])).toHaveLength(0);
    const [r] = await requestsOf(t.companyId);
    expect(r).toMatchObject({ topic: "shop/redact", status: "completed" });
    expect(r?.counts).toMatchObject({ orders: 2, buyerPii: 2 });
  });

  it("a store we never connected is acknowledged and logged", async () => {
    const shop = `t31-unknown-${uniq()}.myshopify.com`;
    const d = signed(shop, "shop/redact", { shop_domain: shop });
    const res = await post(d);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ handled: false });
  });
});
