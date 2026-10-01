import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem, withTenant } from "../../db/client";
import { auditLog, orderItems, orders } from "../../db/schema";
import {
  createCompany,
  createConnection,
  createOrder,
  createUser,
  tenantContext,
} from "../../test/fixtures";
import { ingestChannelRefunds, listRefunds, recordRefund, voidRefund } from "./refunds";
import * as svc from "./service";

const DAY = 86400_000;

describe("finance refunds (T-7-2)", () => {
  let companyId: string;
  let ctx: ReturnType<typeof tenantContext>;

  beforeAll(async () => {
    companyId = (await createCompany()).id;
    const owner = await createUser(companyId, "owner");
    ctx = tenantContext(companyId, owner.id, "owner");
  });

  async function shippedOrder(channel: "amazon" | "shopify", placedDaysAgo: number) {
    const conn = await createConnection(companyId, channel);
    const { order, items } = await createOrder(companyId, conn.id, {
      units: 2,
      state: "shipped",
      channel,
    });
    const placedAt = new Date(Date.now() - placedDaysAgo * DAY);
    await withSystem((tx) =>
      tx.update(orders).set({ placedAt, taxCents: 0 }).where(eq(orders.id, order.id)),
    );
    await withTenant(companyId, (tx) => svc.recomputeProfit(tx, ctx, { orderIds: [order.id] }));
    return { order, items, placedAt };
  }

  const period = (fromDaysAgo: number, toDaysAgo: number) => ({
    from: new Date(Date.now() - fromDaysAgo * DAY).toISOString(),
    to: new Date(Date.now() - toDaysAgo * DAY + 60_000).toISOString(),
  });

  it("records a manual refund in its own period and returns the Amazon referral fee", async () => {
    const { order, items } = await shippedOrder("amazon", 40);
    const item = items[0];
    if (!item) throw new Error("no item");
    const ev = await withTenant(companyId, (tx) =>
      recordRefund(tx, ctx, {
        orderId: order.id,
        orderItemId: item.id,
        amountCents: 2500,
        refundedAt: new Date().toISOString(),
        note: "Returned",
      }),
    );
    // $25 tee: 17% = 425; Amazon keeps 20% (85) -> 340 back.
    expect(ev).toMatchObject({ source: "manual", amountCents: 2500, feeRecoveredCents: 340 });

    // The order's period (40 days ago): no refund there.
    const then = await withTenant(companyId, (tx) =>
      svc.getProfit(tx, ctx, { dimension: "order", period: period(41, 39) }),
    );
    const row = then.rows.find((r) => r.key === order.id);
    expect(row?.refunds).toBe(0);
    expect(row?.channelFees).toBe(850);
    // This week: the refund and the fee back, on the order's key.
    const now = await withTenant(companyId, (tx) =>
      svc.getProfit(tx, ctx, { dimension: "order", period: period(7, 0) }),
    );
    const r = now.rows.find((x) => x.key === order.id);
    expect(r).toMatchObject({ refunds: 2500, channelFees: -340, revenue: 0, orders: 0 });
    expect(r?.net).toBe(-2500 + 340);

    // The order view shows it on the item's line and the fee credit in the breakdown.
    const op = await withTenant(companyId, (tx) => svc.orderProfit(tx, ctx, order.id));
    expect(op.refunds).toBe(2500);
    expect(op.feeBreakdown.at(-1)).toEqual({ label: "Fee returned on refunds", amount: -340 });
    expect(op.lines.find((l) => l.orderItemId === item.id)?.refunds).toBe(2500);

    const list = await withTenant(companyId, (tx) => listRefunds(tx, order.id));
    expect(list.items).toHaveLength(1);

    // The day view (time zone bound as a parameter) groups the refund on its own day.
    const days = await withTenant(companyId, (tx) =>
      svc.getProfit(tx, ctx, { dimension: "day", period: period(7, 0) }),
    );
    expect(days.totals.refunds).toBe(2500);
  });

  it("caps manual refunds at what is left on the order and on the item", async () => {
    const { order, items } = await shippedOrder("amazon", 2); // 2 x $25, no tax
    const rec = (amountCents: number, orderItemId: string | null = null) =>
      withTenant(companyId, (tx) =>
        recordRefund(tx, ctx, {
          orderId: order.id,
          orderItemId,
          amountCents,
          refundedAt: new Date().toISOString(),
          note: null,
        }),
      );
    // $999 typed instead of $9.99 on a $50 order.
    await expect(rec(99_900)).rejects.toMatchObject({
      code: "REFUND_EXCEEDS_ORDER",
      data: { remainingCents: 5000 },
    });
    // One unit can't take more than it sold for.
    await expect(rec(2501, items[0]?.id)).rejects.toMatchObject({
      code: "REFUND_EXCEEDS_ORDER",
      data: { remainingCents: 2500 },
    });
    await rec(3000);
    // Cumulative: $30 already refunded, $20 left.
    await expect(rec(2001)).rejects.toMatchObject({ data: { remainingCents: 2000 } });
    await rec(2000);
    await expect(rec(1)).rejects.toMatchObject({ data: { remainingCents: 0 } });
    // A unit cancelled before shipping is already refunded: it lowers what's left.
    const other = await shippedOrder("amazon", 2);
    await withSystem((tx) =>
      tx
        .update(orderItems)
        .set({ state: "cancelled" })
        .where(eq(orderItems.id, other.items[0]?.id as string)),
    );
    await expect(
      withTenant(companyId, (tx) =>
        recordRefund(tx, ctx, {
          orderId: other.order.id,
          orderItemId: null,
          amountCents: 2600,
          refundedAt: new Date().toISOString(),
          note: null,
        }),
      ),
    ).rejects.toMatchObject({ data: { remainingCents: 2500 } });
  });

  it("counts a reprinted unit as a sale unit in refund scope (B-242)", async () => {
    // Decision 0020: a re-pressed unit is still the buyer's unit; cancelled, it's refunded.
    const { order, items } = await shippedOrder("amazon", 2); // 2 x $25, no tax
    await withSystem((tx) =>
      tx
        .update(orderItems)
        .set({ isReprint: true, state: "cancelled" })
        .where(eq(orderItems.id, items[0]?.id as string)),
    );
    await withTenant(companyId, (tx) => svc.recomputeProfit(tx, ctx, { orderIds: [order.id] }));
    const rec = (amountCents: number, orderItemId: string | null = null) =>
      withTenant(companyId, (tx) =>
        recordRefund(tx, ctx, {
          orderId: order.id,
          orderItemId,
          amountCents,
          refundedAt: new Date().toISOString(),
          note: null,
        }),
      );
    await expect(rec(2600)).rejects.toMatchObject({ data: { remainingCents: 2500 } });
    // A reprinted unit that shipped takes a refund on its own line.
    await withSystem((tx) =>
      tx
        .update(orderItems)
        .set({ isReprint: true })
        .where(eq(orderItems.id, items[1]?.id as string)),
    );
    await withTenant(companyId, (tx) => svc.recomputeProfit(tx, ctx, { orderIds: [order.id] }));
    const ev = await rec(2500, items[1]?.id as string);
    expect(ev).toMatchObject({ orderItemId: items[1]?.id, amountCents: 2500 });
  });

  it("voids a manual refund: audited, dated, and out of profit", async () => {
    const { order } = await shippedOrder("amazon", 2);
    const ev = await withTenant(companyId, (tx) =>
      recordRefund(tx, ctx, {
        orderId: order.id,
        orderItemId: null,
        amountCents: 5000,
        refundedAt: new Date().toISOString(),
        note: "typo",
      }),
    );
    const before = await withTenant(companyId, (tx) => svc.orderProfit(tx, ctx, order.id));
    expect(before.refunds).toBe(5000);
    const voided = await withTenant(companyId, (tx) =>
      voidRefund(tx, ctx, { id: ev.id, reason: "Entered the wrong order" }),
    );
    expect(voided.voidedAt).not.toBeNull();
    expect(voided.voidReason).toBe("Entered the wrong order");
    const after = await withTenant(companyId, (tx) => svc.orderProfit(tx, ctx, order.id));
    expect(after.refunds).toBe(0);
    expect(after.channelFees).toBe(before.channelFees + ev.feeRecoveredCents);
    expect(after.feeBreakdown.some((f) => f.label === "Fee returned on refunds")).toBe(false);
    const byOrder = await withTenant(companyId, (tx) =>
      svc.getProfit(tx, ctx, { dimension: "order", period: period(7, 0) }),
    );
    expect(byOrder.rows.find((r) => r.key === order.id)?.refunds).toBe(0);
    // Still listed (with the void), and the full amount is refundable again.
    const list = await withTenant(companyId, (tx) => listRefunds(tx, order.id));
    expect(list.items[0]?.voidedAt).toBe(voided.voidedAt);
    const audit = await withSystem((tx) =>
      tx.select().from(auditLog).where(eq(auditLog.entityId, order.id)),
    );
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(["refund.record", "refund.void"]),
    );
    await expect(
      withTenant(companyId, (tx) => voidRefund(tx, ctx, { id: ev.id, reason: "again" })),
    ).rejects.toMatchObject({ code: "REFUND_ALREADY_VOIDED" });
  });

  it("won't void a channel refund", async () => {
    const { order } = await shippedOrder("shopify", 2);
    const [o] = await withSystem((tx) => tx.select().from(orders).where(eq(orders.id, order.id)));
    await withTenant(companyId, (tx) =>
      ingestChannelRefunds(tx, companyId, "shopify", "shopify", [
        {
          channelOrderId: o?.channelOrderId as string,
          channelRefundId: "void-test:L1",
          channelLineId: "L1",
          quantity: 1,
          amountCents: 1000,
          refundedAt: new Date().toISOString(),
          note: null,
        },
      ]),
    );
    const [ev] = (await withTenant(companyId, (tx) => listRefunds(tx, order.id))).items;
    await expect(
      withTenant(companyId, (tx) => voidRefund(tx, ctx, { id: ev?.id as string, reason: "x" })),
    ).rejects.toMatchObject({ code: "REFUND_NOT_MANUAL" });
  });

  it("rejects an item from another order", async () => {
    const a = await shippedOrder("amazon", 1);
    const b = await shippedOrder("amazon", 1);
    await expect(
      withTenant(companyId, (tx) =>
        recordRefund(tx, ctx, {
          orderId: a.order.id,
          orderItemId: b.items[0]?.id ?? null,
          amountCents: 100,
          refundedAt: new Date().toISOString(),
          note: null,
        }),
      ),
    ).rejects.toMatchObject({ code: "INVALID_ORDER_ITEM" });
  });

  it("upserts channel refunds by refund id and skips cancelled units", async () => {
    const { order, items } = await shippedOrder("shopify", 3);
    const [o] = await withSystem((tx) => tx.select().from(orders).where(eq(orders.id, order.id)));
    const refund = {
      channelOrderId: o?.channelOrderId as string,
      channelRefundId: "r1:L1",
      channelLineId: "L1",
      quantity: 1,
      amountCents: 2500,
      refundedAt: new Date().toISOString(),
      note: null,
    };
    const first = await withTenant(companyId, (tx) =>
      ingestChannelRefunds(tx, companyId, "shopify", "shopify", [refund]),
    );
    expect(first.upserted).toBe(1);
    await withTenant(companyId, (tx) =>
      ingestChannelRefunds(tx, companyId, "shopify", "shopify", [
        refund,
        { ...refund, channelRefundId: "r1:shipping", channelLineId: null, amountCents: 500 },
      ]),
    );
    const list = await withTenant(companyId, (tx) => listRefunds(tx, order.id));
    expect(list.items.map((i) => i.amountCents).sort()).toEqual([2500, 500]);
    // Shopify Payments keeps its fee.
    expect(list.items.every((i) => i.feeRecoveredCents === 0)).toBe(true);

    // Every unit of the line cancelled: the cancellation already booked the refund.
    await withSystem((tx) =>
      tx.update(orderItems).set({ state: "cancelled" }).where(eq(orderItems.orderId, order.id)),
    );
    const skipped = await withTenant(companyId, (tx) =>
      ingestChannelRefunds(tx, companyId, "shopify", "shopify", [
        { ...refund, channelRefundId: "r2:L1" },
      ]),
    );
    expect(skipped).toEqual({ upserted: 0, skipped: 1 });
    expect(items).toHaveLength(2);
  });
});
