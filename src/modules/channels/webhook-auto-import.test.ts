import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { systemContext } from "../../api/context";
import { withSystem, withTenant } from "../../db/client";
import { channelConnections, DEFAULT_CONNECTION_SETTINGS, jobs, orders } from "../../db/schema";
import { mockEtsyReceipt, signEtsyWebhook } from "../../integrations/channels/etsy";
import { MOCK_ETSY_WEBHOOK_SECRET } from "../../integrations/channels/etsy/webhooks";
import { signShopifyBody } from "../../integrations/channels/shopify";
import { mockShopifyOrder } from "../../integrations/channels/shopify/mock";
import { createCompany, createLocation } from "../../test/fixtures";
import { importNormalizedOrders } from "../orders/import";
import { processWebhook, recordWebhookDelivery, syncConnection } from "./sync";

/* T-29-4 (decision 0030, B-292): with auto-import off, a webhook for an unknown order is
 * acknowledged and skipped; updates/cancels for known orders apply; a manual sync imports it. */

const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

function delivery(shop: string, topic: string, payload: unknown, id = `t294-${uniq()}`) {
  const body = JSON.stringify(payload);
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

const restOrder = (
  id: string,
  financial_status: string,
  extra: { note?: string; updated_at?: string } = {},
) => ({
  ...extra,
  id: Number(id),
  name: `#T294-${id.slice(-4)}`,
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
  line_items: [{ id: Number(id) + 1, sku: "T294-UNKNOWN", title: "Tee", quantity: 1, price: "20" }],
});

async function setup(autoImport: boolean | undefined) {
  const companyId = (await createCompany()).id;
  await createLocation(companyId);
  const shop = `t294-${uniq()}.myshopify.com`;
  const [conn] = await withSystem((tx) =>
    tx
      .insert(channelConnections)
      .values({
        companyId,
        channel: "shopify",
        name: "Shopify t294",
        status: "connected",
        mode: "api",
        provider: "mock",
        externalShopId: shop,
        settings:
          autoImport === undefined ? undefined : { ...DEFAULT_CONNECTION_SETTINGS, autoImport },
      })
      .returning(),
  );
  if (!conn) throw new Error("insert failed");
  return { companyId, shop, conn };
}

const setAutoImport = (id: string, autoImport: boolean) =>
  withSystem((tx) =>
    tx
      .update(channelConnections)
      .set({ settings: { ...DEFAULT_CONNECTION_SETTINGS, autoImport } })
      .where(eq(channelConnections.id, id)),
  );
const find = (companyId: string, channelOrderId: string) =>
  withSystem((tx) =>
    tx
      .select()
      .from(orders)
      .where(and(eq(orders.companyId, companyId), eq(orders.channelOrderId, channelOrderId))),
  );
const reload = (companyId: string, id: string) =>
  withTenant(companyId, async (tx) => {
    const [r] = await tx.select().from(channelConnections).where(eq(channelConnections.id, id));
    return r;
  });
async function send(d: ReturnType<typeof delivery>) {
  expect(await recordWebhookDelivery("shopify", d.id)).toBe(true);
  return processWebhook("shopify", d.headers, d.body, new Date().toISOString());
}

describe("webhooks with auto-import off", () => {
  it("skips a new order, leaves the cursor alone, and a manual sync imports it once", async () => {
    const { companyId, shop, conn } = await setup(false);
    const mockId = mockShopifyOrder(1).channelOrderId;
    const res = await send(delivery(shop, "orders/create", restOrder(mockId, "paid")));
    expect(res).toMatchObject({ handled: true, orderIds: [] });
    expect(await find(companyId, mockId)).toHaveLength(0);
    const after = await reload(companyId, conn.id);
    expect(after?.cursor ?? null).toBe(conn.cursor ?? null); // no lost orders: cursor unmoved
    expect(after?.lastWebhookAt).not.toBeNull();

    const [job] = await withSystem((tx) =>
      tx
        .insert(jobs)
        .values({ companyId, kind: "sync", status: "queued", input: { connectionId: conn.id } })
        .returning({ id: jobs.id }),
    );
    if (!job) throw new Error("job insert failed");
    await syncConnection(companyId, conn.id, job.id);
    expect(await find(companyId, mockId)).toHaveLength(1);
    await syncConnection(companyId, conn.id, null); // poll-started: skipped, still one
    expect(await find(companyId, mockId)).toHaveLength(1);
  });

  it("a re-sent delivery is deduped; turning auto-import on imports the order once", async () => {
    const { companyId, shop, conn } = await setup(false);
    const id = String(7_100_000_000 + Math.floor(Math.random() * 1_000_000));
    const d = delivery(shop, "orders/create", restOrder(id, "paid"));
    await send(d);
    expect(await recordWebhookDelivery("shopify", d.id)).toBe(false); // route would 200 and stop
    expect(await find(companyId, id)).toHaveLength(0);
    await setAutoImport(conn.id, true);
    await send(delivery(shop, "orders/create", restOrder(id, "paid")));
    await send(delivery(shop, "orders/updated", restOrder(id, "paid")));
    expect(await find(companyId, id)).toHaveLength(1);
  });

  it("a cancel for an order already imported still applies", async () => {
    const { companyId, shop, conn } = await setup(true);
    const id = String(7_200_000_000 + Math.floor(Math.random() * 1_000_000));
    await send(delivery(shop, "orders/create", restOrder(id, "paid")));
    expect(await find(companyId, id)).toHaveLength(1);
    await setAutoImport(conn.id, false);
    const res = await send(delivery(shop, "orders/updated", restOrder(id, "refunded")));
    expect(res).toMatchObject({ handled: true, kind: "order_cancelled" });
    expect((await find(companyId, id))[0]?.status).toBe("cancelled");
  });

  it("an update for a known order applies (note and watermark change, no second row)", async () => {
    const { companyId, shop, conn } = await setup(true);
    const id = String(7_300_000_000 + Math.floor(Math.random() * 1_000_000));
    await send(
      delivery(
        shop,
        "orders/create",
        restOrder(id, "paid", { updated_at: "2026-10-01T10:00:00Z" }),
      ),
    );
    const before = (await find(companyId, id))[0];
    expect(before?.buyerNote).toBeNull();
    await setAutoImport(conn.id, false);
    const res = await send(
      delivery(
        shop,
        "orders/updated",
        restOrder(id, "paid", { note: "please gift wrap", updated_at: "2026-10-02T10:00:00Z" }),
      ),
    );
    expect(res).toMatchObject({ handled: true, kind: "order_upsert" });
    const rows = await find(companyId, id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.buyerNote).toBe("please gift wrap");
    expect(rows[0]?.channelUpdatedAt?.toISOString()).toBe("2026-10-02T10:00:00.000Z");
  });

  it("an Etsy cancel (order_ref) for a known order still applies with auto-import off", async () => {
    const companyId = (await createCompany()).id;
    await createLocation(companyId);
    const etsyShop = String(20_000_000 + Math.floor(Math.random() * 70_000_000));
    // Receipt ids ending in 0 are cancelled in the mock Etsy store.
    const receipt = String(8_000_000_000 + Math.floor(Math.random() * 100_000) * 10);
    const [econn] = await withSystem((tx) =>
      tx
        .insert(channelConnections)
        .values({
          companyId,
          channel: "etsy",
          name: "Etsy t294",
          status: "connected",
          mode: "api",
          provider: "mock",
          externalShopId: etsyShop,
          settings: { ...DEFAULT_CONNECTION_SETTINGS, autoImport: false },
        })
        .returning(),
    );
    if (!econn) throw new Error("insert failed");
    const fetched = mockEtsyReceipt(receipt).order;
    expect(fetched).not.toBeNull();
    if (!fetched) throw new Error("mock receipt has no order");
    await withTenant(companyId, (tx) =>
      importNormalizedOrders(tx, systemContext(companyId), econn, [fetched], {
        source: "csv",
      }),
    );
    expect((await find(companyId, receipt))[0]?.status).not.toBe("cancelled");

    const id = `msg_${uniq()}`;
    const ts = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({
      event_type: "ORDER_CANCELED",
      resource_url: `https://openapi.etsy.com/v3/application/shops/${etsyShop}/receipts/${receipt}`,
      shop_id: Number(etsyShop),
    });
    const headers = {
      "webhook-id": id,
      "webhook-timestamp": String(ts),
      "webhook-signature": signEtsyWebhook(id, ts, body, MOCK_ETSY_WEBHOOK_SECRET),
    };
    expect(await recordWebhookDelivery("etsy", id)).toBe(true);
    const res = await processWebhook("etsy", headers, body, new Date().toISOString());
    expect(res).toMatchObject({ handled: true });
    expect((await find(companyId, receipt))[0]?.status).toBe("cancelled");
  });

  it("auto-import on or unset imports from a webhook as before", async () => {
    for (const setting of [true, undefined]) {
      const { companyId, shop } = await setup(setting);
      const id = String(7_400_000_000 + Math.floor(Math.random() * 1_000_000));
      await send(delivery(shop, "orders/create", restOrder(id, "paid")));
      expect(await find(companyId, id)).toHaveLength(1);
    }
  });

  it("only the paused connection skips (per-connection, other tenants unaffected)", async () => {
    const off = await setup(false);
    const on = await setup(true);
    const id = String(7_500_000_000 + Math.floor(Math.random() * 1_000_000));
    await send(delivery(off.shop, "orders/create", restOrder(id, "paid")));
    await send(delivery(on.shop, "orders/create", restOrder(id, "paid")));
    expect(await find(off.companyId, id)).toHaveLength(0);
    expect(await find(on.companyId, id)).toHaveLength(1);
  });
});
