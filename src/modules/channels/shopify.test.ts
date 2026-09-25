import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "../../db/client";
import { channelConnections, orders, webhookDeliveries } from "../../db/schema";
import { signShopifyBody } from "../../integrations/channels/shopify";
import { createCompany, createLocation } from "../../test/fixtures";
import { processWebhook, recordWebhookDelivery } from "./sync";

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
});
