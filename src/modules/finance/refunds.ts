import type { Channel, RefundEvent } from "@invai/contracts";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { TenantContext } from "../../api/context";
import type { Tx } from "../../db/client";
import { blankVariants, orderItems, orders, profitLines, refundEvents } from "../../db/schema";
import type { ChannelRefund } from "../../integrations/channels/types";
import { audit } from "../../lib/audit";
import { badRequest, notFound, ORPCError } from "../../lib/errors";
import { feeCategoryOf, feeRecoveredCents, referralFeeCents, usesSchedule } from "./fees";
import { type FeeTable, feeTableFor } from "./profit";
import { ensureCostSettings, feeTablesOf } from "./service";

/*
 * T-7-2: the dated refund ledger. A refund reduces profit in the period of its own date
 * (`refundedAt`), not the order's: `getProfit` reads the `refunds` bucket (and the referral fee
 * the channel gives back) from here. Units cancelled before shipping are not refunds here --
 * `profit_lines` already books those as refunded in the order's period -- so ingestion skips
 * refunds that land only on cancelled units.
 */

type Ctx = Pick<TenantContext, "companyId" | "userId" | "actor">;
type RefundRow = typeof refundEvents.$inferSelect;
type Source = "shopify" | "csv" | "manual";

export function toRefundEvent(r: RefundRow): RefundEvent {
  return {
    id: r.id,
    orderId: r.orderId,
    orderItemId: r.orderItemId,
    channel: r.channel,
    source: r.source,
    amountCents: r.amountCents,
    feeRecoveredCents: r.feeRecoveredCents,
    refundedAt: r.refundedAt.toISOString(),
    note: r.note,
  };
}

export async function listRefunds(tx: Tx, orderId: string): Promise<{ items: RefundEvent[] }> {
  const rows = await tx
    .select()
    .from(refundEvents)
    .where(eq(refundEvents.orderId, orderId))
    .orderBy(asc(refundEvents.refundedAt), asc(refundEvents.createdAt));
  return { items: rows.map(toRefundEvent) };
}

type Unit = {
  id: string;
  channelLineId: string;
  cancelled: boolean;
  isReprint: boolean;
  saleCents: number;
  category: ReturnType<typeof feeCategoryOf>;
};

/** Every unit of an order with what it sold for (its profit line's revenue, else unit price). */
async function orderUnits(tx: Tx, orderId: string): Promise<Unit[]> {
  const rows = await tx
    .select({
      id: orderItems.id,
      channelLineId: orderItems.channelLineId,
      state: orderItems.state,
      isReprint: orderItems.isReprint,
      unitPrice: orderItems.unitPriceCents,
      revenue: profitLines.revenueCents,
      style: blankVariants.style,
      styleName: blankVariants.styleName,
    })
    .from(orderItems)
    .leftJoin(profitLines, eq(profitLines.orderItemId, orderItems.id))
    .leftJoin(blankVariants, eq(blankVariants.id, orderItems.blankVariantId))
    .where(eq(orderItems.orderId, orderId))
    .orderBy(asc(orderItems.lineNo), asc(orderItems.unitNo));
  return rows.map((r) => ({
    id: r.id,
    channelLineId: r.channelLineId,
    cancelled: r.state === "cancelled",
    isReprint: r.isReprint,
    saleCents: r.revenue ?? r.unitPrice,
    category: feeCategoryOf(r.style ? `${r.style} ${r.styleName ?? ""}` : null),
  }));
}

/** The transaction/referral fee the channel charged on these units. */
function chargedFee(table: FeeTable, channel: Channel, units: Unit[]): number {
  if (usesSchedule(table))
    return units.reduce((a, u) => a + referralFeeCents(channel, u.category, u.saleCents), 0);
  const sale = units.reduce((a, u) => a + u.saleCents, 0);
  return Math.round((sale * table.transactionPct) / 100);
}

/**
 * What a refund of `amountCents` on `units` (one line's units, or the whole order's kept units
 * for an order-level refund) gives back of the channel fee.
 */
export function recoveredFor(
  table: FeeTable,
  channel: Channel,
  units: Unit[],
  amountCents: number,
): number {
  const saleCents = units.reduce((a, u) => a + u.saleCents, 0);
  return feeRecoveredCents(channel, {
    chargedFeeCents: chargedFee(table, channel, units),
    saleCents,
    refundCents: amountCents,
  });
}

async function feeTable(tx: Tx, companyId: string, channel: Channel): Promise<FeeTable> {
  return feeTableFor(feeTablesOf(await ensureCostSettings(tx, companyId)), channel);
}

/** Manual "record refund" (CSV channels without refund columns). A new row per call. */
export async function recordRefund(
  tx: Tx,
  ctx: Ctx,
  input: {
    orderId: string;
    orderItemId: string | null;
    amountCents: number;
    refundedAt: string;
    note: string | null;
  },
): Promise<RefundEvent> {
  if (input.amountCents <= 0) throw badRequest("A refund amount must be more than zero");
  const [order] = await tx
    .select({ id: orders.id, channel: orders.channel })
    .from(orders)
    .where(eq(orders.id, input.orderId));
  if (!order) throw notFound("order", input.orderId);
  const units = await orderUnits(tx, order.id);
  let scope = units.filter((u) => !u.isReprint && !u.cancelled);
  if (input.orderItemId) {
    const unit = units.find((u) => u.id === input.orderItemId);
    if (!unit) throw new ORPCError("INVALID_ORDER_ITEM", { status: 400 });
    scope = [unit];
  }
  const table = await feeTable(tx, ctx.companyId, order.channel);
  const [row] = await tx
    .insert(refundEvents)
    .values({
      companyId: ctx.companyId,
      orderId: order.id,
      orderItemId: input.orderItemId,
      channel: order.channel,
      source: "manual",
      amountCents: input.amountCents,
      feeRecoveredCents: recoveredFor(table, order.channel, scope, input.amountCents),
      channelRefundId: null,
      refundedAt: new Date(input.refundedAt),
      note: input.note,
    })
    .returning();
  if (!row) throw new Error("refund insert failed");
  await audit(tx, {
    companyId: ctx.companyId,
    actor: ctx.actor,
    action: "refund.record",
    entityType: "order",
    entityId: order.id,
    summary: `Refund ${(input.amountCents / 100).toFixed(2)} recorded`,
    data: { refundId: row.id, orderItemId: input.orderItemId, amountCents: input.amountCents },
  });
  return toRefundEvent(row);
}

/**
 * Upsert the refunds a channel reported (Shopify poll, CSV refund columns) by
 * (channel, channelRefundId). Refunds for orders we don't have, and refunds that land only on
 * units already cancelled here, are skipped. A re-read updates the amount and fee but keeps the
 * first `refundedAt` (CSV files without a refund date use the first import time).
 */
export async function ingestChannelRefunds(
  tx: Tx,
  companyId: string,
  channel: Channel,
  source: Exclude<Source, "manual">,
  refunds: ChannelRefund[],
  now = new Date(),
): Promise<{ upserted: number; skipped: number }> {
  const valid = refunds.filter((r) => r.amountCents > 0 && r.channelRefundId);
  if (!valid.length) return { upserted: 0, skipped: refunds.length };
  const orderRows = await tx
    .select({ id: orders.id, channelOrderId: orders.channelOrderId })
    .from(orders)
    .where(
      and(
        eq(orders.companyId, companyId),
        eq(orders.channel, channel),
        inArray(orders.channelOrderId, [...new Set(valid.map((r) => r.channelOrderId))]),
      ),
    );
  const orderIdOf = new Map(orderRows.map((o) => [o.channelOrderId, o.id]));
  const table = await feeTable(tx, companyId, channel);
  const unitsCache = new Map<string, Unit[]>();
  const values: (typeof refundEvents.$inferInsert)[] = [];
  for (const r of valid) {
    const orderId = orderIdOf.get(r.channelOrderId);
    if (!orderId) continue;
    let units = unitsCache.get(orderId);
    if (!units) {
      units = await orderUnits(tx, orderId);
      unitsCache.set(orderId, units);
    }
    const kept = units.filter((u) => !u.isReprint && !u.cancelled);
    let scope = kept;
    let orderItemId: string | null = null;
    if (r.channelLineId) {
      const line = kept.filter((u) => u.channelLineId === r.channelLineId);
      if (!line.length) {
        // Every unit of the line was cancelled: the cancellation already refunded it.
        if (units.some((u) => u.channelLineId === r.channelLineId)) continue;
      } else {
        scope = line.slice(0, Math.max(1, r.quantity));
        orderItemId = scope[0]?.id ?? null;
      }
    }
    values.push({
      companyId,
      orderId,
      orderItemId,
      channel,
      source,
      amountCents: r.amountCents,
      feeRecoveredCents: recoveredFor(table, channel, scope, r.amountCents),
      channelRefundId: r.channelRefundId,
      refundedAt: r.refundedAt ? new Date(r.refundedAt) : now,
      note: r.note,
    });
  }
  // One row per channelRefundId (a file can list the same refund twice): the last one wins.
  const unique = [...new Map(values.map((v) => [v.channelRefundId, v])).values()];
  if (unique.length) {
    const ex = (c: string) => sql.raw(`excluded.${c}`);
    await tx
      .insert(refundEvents)
      .values(unique)
      .onConflictDoUpdate({
        target: [refundEvents.companyId, refundEvents.channel, refundEvents.channelRefundId],
        set: {
          orderItemId: ex("order_item_id"),
          amountCents: ex("amount_cents"),
          feeRecoveredCents: ex("fee_recovered_cents"),
          note: ex("note"),
          updatedAt: now,
        },
      });
  }
  return { upserted: unique.length, skipped: refunds.length - values.length };
}
