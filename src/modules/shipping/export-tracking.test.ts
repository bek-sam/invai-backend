import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { withSystem, withTenant } from "../../db/client";
import { type Carrier, shipments } from "../../db/schema";
import { getObject } from "../../lib/s3";
import {
  createCompany,
  createConnection,
  createOrder,
  createUser,
  tenantContext,
} from "../../test/fixtures";
import * as svc from "./service";

/*
 * T-7-1 (B-68): `shipping.exportTracking` for the four CSV-only (pendingApproval) channels.
 * The wave stub's query names `trackingPushStatus = 'manual'`, a value that doesn't exist on
 * this column (see the comment in service.ts); these tests exercise the real filter instead --
 * labeled, has a tracking code, not voided -- against a real per-card test DB.
 */

async function labelShipment(
  companyId: string,
  orderId: string,
  orderItemIds: string[],
  over: Partial<typeof shipments.$inferInsert> = {},
) {
  const [row] = await withSystem((tx) =>
    tx
      .insert(shipments)
      .values({
        companyId,
        orderId,
        orderItemIds,
        status: "labeled",
        carrier: "usps" as Carrier,
        service: "Priority",
        trackingCode: `9400${Date.now()}${Math.floor(Math.random() * 1000)}`,
        trackingUrl: "https://tools.usps.com/go/TrackConfirmAction",
        labeledAt: new Date(),
        trackingPushStatus: "not_required",
        ...over,
      })
      .returning(),
  );
  if (!row) throw new Error("shipment insert failed");
  return row;
}

async function setup(channel: "etsy" | "amazon" | "shopify" = "etsy") {
  const shop = await createCompany();
  const owner = await createUser(shop.id, "owner");
  return {
    shop,
    ctx: tenantContext(shop.id, owner.id, "owner"),
    conn: await createConnection(shop.id, channel),
  };
}

describe("shipping.exportTracking", () => {
  it("rejects a channel that isn't CSV-only", async () => {
    const { shop, ctx } = await setup("shopify");
    await expect(
      withTenant(shop.id, (tx) => svc.exportTracking(tx, ctx, { channel: "shopify", since: null })),
    ).rejects.toMatchObject({ code: "NOT_CSV_CHANNEL" });
  });

  it("exports labeled shipments for the channel, in Etsy's tracking-upload shape, and marks exportedAt", async () => {
    const { shop, ctx, conn } = await setup("etsy");
    const { order, items } = await createOrder(shop.id, conn.id, { units: 2, channel: "etsy" });
    const shipment = await labelShipment(
      shop.id,
      order.id,
      items.map((i) => i.id),
    );

    const out = await withTenant(shop.id, (tx) =>
      svc.exportTracking(tx, ctx, { channel: "etsy", since: null }),
    );
    expect(out.count).toBe(1);

    const body = (await getObject(out.key)).toString("utf8");
    const [header, data] = body.split("\r\n");
    expect(header).toBe("receipt_id,tracking_code,carrier_name,note_to_buyer,send_bcc");
    expect(data).toContain(order.channelOrderId);
    expect(data).toContain(shipment.trackingCode);

    const [row] = await withTenant(shop.id, (tx) =>
      tx.select().from(shipments).where(eq(shipments.id, shipment.id)),
    );
    expect(row?.exportedAt).toBeTruthy();
  });

  it("re-export with since=null uses the channel's last export as the cutoff (nothing new), but an explicit earlier since re-includes it", async () => {
    const { shop, ctx, conn } = await setup("etsy");
    const { order, items } = await createOrder(shop.id, conn.id, { channel: "etsy" });
    await labelShipment(
      shop.id,
      order.id,
      items.map((i) => i.id),
    );

    const first = await withTenant(shop.id, (tx) =>
      svc.exportTracking(tx, ctx, { channel: "etsy", since: null }),
    );
    expect(first.count).toBe(1);

    const again = await withTenant(shop.id, (tx) =>
      svc.exportTracking(tx, ctx, { channel: "etsy", since: null }),
    );
    expect(again.count).toBe(0);

    const replay = await withTenant(shop.id, (tx) =>
      svc.exportTracking(tx, ctx, {
        channel: "etsy",
        since: new Date(Date.now() - 60_000).toISOString(),
      }),
    );
    expect(replay.count).toBe(1);
  });

  it("only includes the requested channel's shipments, and skips unlabeled ones", async () => {
    const { shop, ctx, conn: etsyConn } = await setup("etsy");
    const amazonConn = await createConnection(shop.id, "amazon");
    const { order: etsyOrder, items: etsyItems } = await createOrder(shop.id, etsyConn.id, {
      channel: "etsy",
    });
    const { order: amazonOrder, items: amazonItems } = await createOrder(shop.id, amazonConn.id, {
      channel: "amazon",
    });
    await labelShipment(
      shop.id,
      amazonOrder.id,
      amazonItems.map((i) => i.id),
    );
    await withSystem((tx) =>
      tx.insert(shipments).values({
        companyId: shop.id,
        orderId: etsyOrder.id,
        orderItemIds: etsyItems.map((i) => i.id),
        status: "pending",
      }),
    );

    const out = await withTenant(shop.id, (tx) =>
      svc.exportTracking(tx, ctx, { channel: "etsy", since: null }),
    );
    expect(out.count).toBe(0);
  });

  it("builds Amazon's tab-delimited flat file, one row per order-item line", async () => {
    const { shop, ctx, conn } = await setup("amazon");
    const { order, items } = await createOrder(shop.id, conn.id, { units: 2, channel: "amazon" });
    await labelShipment(
      shop.id,
      order.id,
      items.map((i) => i.id),
      { carrier: "ups" as Carrier },
    );

    const out = await withTenant(shop.id, (tx) =>
      svc.exportTracking(tx, ctx, { channel: "amazon", since: null }),
    );
    expect(out.count).toBe(1);
    const body = (await getObject(out.key)).toString("utf8");
    expect(body.split("\r\n")[0]).toBe(
      "order-id\torder-item-id\tquantity\tship-date\tcarrier-code\tcarrier-name\ttracking-number\tship-method",
    );
    expect(body).toContain("UPS");
  });
});
