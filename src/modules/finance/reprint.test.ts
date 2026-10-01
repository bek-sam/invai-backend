import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem, withTenant } from "../../db/client";
import {
  blankVariants,
  gangSheetBatches,
  gangSheets,
  orderItems,
  orders,
  shipments,
  transfers,
} from "../../db/schema";
import {
  createCompany,
  createConnection,
  createOrder,
  createUser,
  tenantContext,
} from "../../test/fixtures";
import * as analytics from "../analytics/finance-service";
import * as svc from "./service";

/**
 * B-242 / decision 0020: a reprinted unit is the same order item re-pressed (`openReprint` flips
 * `isReprint` on the row and prints a second transfer). It stays a sale unit: it keeps its revenue
 * and counts as a unit; the reprint shows up only as the extra transfer's cost.
 */
describe("a reprinted item stays a sale unit (B-242)", () => {
  type Shop = {
    companyId: string;
    ctx: ReturnType<typeof tenantContext>;
    connId: string;
    blankId: string;
    sheetId: string;
  };
  let shopA: Shop;

  async function makeShop(): Promise<Shop> {
    const companyId = (await createCompany()).id;
    const ctx = tenantContext(companyId, (await createUser(companyId, "owner")).id, "owner");
    const connId = (await createConnection(companyId, "etsy")).id;
    return withSystem(async (tx) => {
      const [bv] = await tx
        .insert(blankVariants)
        .values({
          companyId,
          brand: "Gildan",
          style: "Softstyle",
          styleCode: "G64000",
          color: "Black",
          colorCode: "BLK",
          size: "M",
          sizeCode: "M",
          sku: "G64000-BLK-M",
          costCents: 300,
        })
        .returning();
      const [batch] = await tx
        .insert(gangSheetBatches)
        .values({ companyId, name: "B1" })
        .returning();
      const [sheet] = await tx
        .insert(gangSheets)
        .values({ companyId, batchId: batch?.id as string, name: "S1", costCents: 0 })
        .returning();
      return { companyId, ctx, connId, blankId: bv?.id as string, sheetId: sheet?.id as string };
    });
  }

  beforeAll(async () => {
    shopA = await makeShop();
  });

  const today = () => ({
    from: new Date(Date.now() - 86_400_000).toISOString(),
    to: new Date(Date.now() + 86_400_000).toISOString(),
  });

  /**
   * A shipped 2-unit Etsy order ($25 each, $5 shipping, labeled), with `reprinted[k]` re-presses
   * of unit k: the same item row flagged, one scrapped transfer per reprint plus the pressed one.
   */
  async function order(s: Shop, reprinted: [number, number], sizeIn = 10) {
    const { companyId, connId, blankId, sheetId, ctx } = s;
    const { order, items } = await createOrder(companyId, connId, {
      units: 2,
      state: "shipped",
      channel: "etsy",
    });
    await withSystem(async (tx) => {
      await tx
        .update(orderItems)
        .set({ blankVariantId: blankId, printWidthIn: sizeIn, printHeightIn: sizeIn })
        .where(eq(orderItems.orderId, order.id));
      await tx
        .update(orders)
        .set({ shippingCents: 500, totalCents: 5500 })
        .where(eq(orders.id, order.id));
      await tx.insert(shipments).values({
        companyId,
        orderId: order.id,
        orderItemIds: items.map((i) => i.id),
        status: "labeled",
        postageCents: 480,
        labelFeeCents: 4,
        labeledAt: new Date(),
      });
      for (const [k, it] of items.entries()) {
        const re = reprinted[k] ?? 0;
        for (let n = 0; n <= re; n++)
          await tx.insert(transfers).values({
            companyId,
            gangSheetId: sheetId,
            orderItemId: it.id,
            widthIn: sizeIn,
            heightIn: sizeIn,
            isReprint: n > 0,
            scrapped: n < re,
            status: n < re ? "scrap" : "pressed",
          });
        if (re > 0)
          await tx.update(orderItems).set({ isReprint: true }).where(eq(orderItems.id, it.id));
      }
    });
    await withTenant(companyId, (tx) => svc.recomputeProfit(tx, ctx, { orderIds: [order.id] }));
    return { order, items };
  }

  it("AC1: one of two items reprinted keeps its sale; only the second transfer's cost is added", async () => {
    const { companyId, ctx } = shopA;
    const plain = await order(shopA, [0, 0]);
    const rp = await order(shopA, [0, 1]);
    const p0 = await withTenant(companyId, (tx) => svc.orderProfit(tx, ctx, plain.order.id));
    const p1 = await withTenant(companyId, (tx) => svc.orderProfit(tx, ctx, rp.order.id));

    // Revenue: 2 × $25 + $5 shipping, split evenly; the reprinted unit keeps its $27.50.
    expect(p1.revenue).toBe(5500);
    expect(p1.revenue).toBe(p0.revenue);
    expect(p1.lines).toHaveLength(2);
    const line = p1.lines.find((l) => l.orderItemId === rp.items[1]?.id);
    expect(line?.isReprint).toBe(true);
    expect(line?.revenue).toBe(2750);
    // Fees on the same sale; one blank per unit.
    expect(p1.channelFees).toBe(p0.channelFees);
    expect(p1.blankCost).toBe(p0.blankCost);
    // One extra 10 × 10 in transfer at the default 3¢/sq in = 300; CM2 drops by exactly that.
    expect(p1.transferCost).toBe(p0.transferCost + 300);
    expect(p1.net).toBe(p0.net - 300);

    // Units: all four units of the two orders count.
    const byChannel = await withTenant(companyId, (tx) =>
      svc.getProfit(tx, ctx, { dimension: "channel", period: today() }),
    );
    expect(byChannel.rows[0]?.units).toBe(4);
    expect(byChannel.totals.revenue).toBe(11_000);

    // Re-running the recompute changes nothing (per-item upsert).
    await withTenant(companyId, (tx) => svc.recomputeProfit(tx, ctx, { orderIds: [rp.order.id] }));
    const again = await withTenant(companyId, (tx) => svc.orderProfit(tx, ctx, rp.order.id));
    expect(again).toEqual(p1);
  });

  it("AC2: both items reprinted: losingOrders shows 2 units and the sale, listed only when it really loses", async () => {
    const b = await makeShop();
    // Small prints: two reprints still leave a profit. Big prints (30 in, 2,700¢ a transfer):
    // the reprints really make the order lose money.
    const cheap = await order(b, [1, 1], 10);
    const costly = await order(b, [1, 1], 30);
    const lo = await withTenant(b.companyId, (tx) =>
      analytics.losingOrders(tx, b.ctx, { period: today() }),
    );
    expect(lo.ordersWithProfitLine).toBe(2);
    expect(lo.losingOrders).toBe(1);
    expect(lo.orders.map((o) => o.orderId)).toEqual([costly.order.id]);
    expect(lo.orders[0]).toMatchObject({ units: 2, revenue: 5500 });
    expect(lo.orders[0]?.cm2).toBeLessThan(0);
    expect(lo.orders.some((o) => o.orderId === cheap.order.id)).toBe(false);

    // Tenant isolation: shop A sees none of B's orders; B's order id is NOT_FOUND for A.
    const seenByA = await withTenant(shopA.companyId, (tx) =>
      analytics.losingOrders(tx, shopA.ctx, { period: today() }),
    );
    expect(seenByA.orders.some((o) => o.orderId === costly.order.id)).toBe(false);
    await expect(
      withTenant(shopA.companyId, (tx) => svc.orderProfit(tx, shopA.ctx, costly.order.id)),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
