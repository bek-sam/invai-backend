import type { Channel } from "@invai/contracts";
import { and, eq, gte, isNull, lt, type SQL, sql } from "drizzle-orm";
import type { TenantContext } from "../../api/context";
import type { Tx } from "../../db/client";
import {
  blankVariants,
  companies,
  designs,
  orderItems,
  orders,
  profitLines,
  refundEvents,
} from "../../db/schema";
import { type Buckets, sumBuckets } from "../finance/profit";

/*
 * The one net-profit calculation (T-A3, spec AC-G1). The Profit page (`finance.getProfit`),
 * `analytics.unitEconomics`, the assistant's unit-economics tool and the digest snapshot all
 * call `computeNet`, so their Net / CM3 agree to the cent by construction, not by coincidence.
 *
 * Rule (metrics/definitions/contribution_margin.md): profit lines by `placed_at` in
 * `[from, to)`; dated refund events by `refunded_at` in the same window, adding their amount to
 * refunds and taking the fee they gave back off channel fees. Net = revenue − every bucket.
 * Reads only finance's own tables (plus names for labels); runs inside the caller's `withTenant`.
 */

type Ctx = Pick<TenantContext, "companyId">;
export type NetPeriod = { from: string; to: string };
export type NetDimension = "order" | "design" | "blank" | "sku" | "channel" | "day";
export type NetOptions = { dimension: NetDimension; channel?: Channel; designId?: string };

/** One group's summed buckets (before net), its counts and the newest line's compute time. */
export type NetGroup = Omit<Buckets, "net" | "marginPct"> & {
  key: string;
  label: string | null;
  orders: number;
  units: number;
  /** Units whose blank, transfer, label or ads bucket is an estimate. */
  estimatedUnits: number;
  computedAt: Date | null;
};

export type NetResult = {
  groups: NetGroup[];
  /** Σ groups, net and margin recomputed (net = CM3). */
  totals: Buckets;
  /** Distinct orders with a profit line in the window (not Σ group orders: an order spans groups). */
  orders: number;
  units: number;
  estimatedUnits: number;
  /** Orders placed in the window with items but no profit line yet (AC-A7). */
  ordersWithoutProfitLine: number;
  computedAt: Date | null;
  timezone: string;
};

/** Buckets that make a unit "estimated" for `estimatedShare` (contracts `ContributionLadder`). */
const ESTIMATE_FLAGS = ["blankCost", "transferCost", "labelCost", "adsCost"];

/** getProfit's unit rule: not a cancel reversal (a re-pressed unit is still a sale, decision 0020). */
const isUnit = sql`${profitLines.refundsCents} = 0`;

const sums = {
  revenue: sql<number>`coalesce(sum(${profitLines.revenueCents}), 0)::int`,
  channelFees: sql<number>`coalesce(sum(${profitLines.channelFeesCents}), 0)::int`,
  blankCost: sql<number>`coalesce(sum(${profitLines.blankCostCents}), 0)::int`,
  transferCost: sql<number>`coalesce(sum(${profitLines.transferCostCents}), 0)::int`,
  labelCost: sql<number>`coalesce(sum(${profitLines.labelCostCents}), 0)::int`,
  packagingCost: sql<number>`coalesce(sum(${profitLines.packagingCostCents}), 0)::int`,
  laborCost: sql<number>`coalesce(sum(${profitLines.laborCostCents}), 0)::int`,
  adsCost: sql<number>`coalesce(sum(${profitLines.adsCostCents}), 0)::int`,
  refunds: sql<number>`coalesce(sum(${profitLines.refundsCents}), 0)::int`,
  orders: sql<number>`count(distinct ${profitLines.orderId})::int`,
  units: sql<number>`(count(*) filter (where ${isUnit}))::int`,
  estimatedUnits: sql<number>`(count(*) filter (where ${isUnit} and ${profitLines.estimated} && ${sql.raw(`array['${ESTIMATE_FLAGS.join("','")}']::text[]`)}))::int`,
  computedAt: sql<Date | null>`max(${profitLines.computedAt})`,
};

export async function companyTimezone(tx: Tx, companyId: string): Promise<string> {
  const [row] = await tx
    .select({ tz: companies.timezone })
    .from(companies)
    .where(eq(companies.id, companyId));
  return row?.tz ?? "America/Phoenix";
}

const blankLabel = sql<
  string | null
>`max(${blankVariants.brand} || ' ' || ${blankVariants.styleCode} || coalesce(' ' || ${blankVariants.styleName}, ''))`;

export async function computeNet(
  tx: Tx,
  ctx: Ctx,
  period: NetPeriod,
  opts: NetOptions,
): Promise<NetResult> {
  const from = new Date(period.from);
  const to = new Date(period.to);
  const tz = await companyTimezone(tx, ctx.companyId);
  const filters: SQL[] = [
    eq(profitLines.companyId, ctx.companyId),
    gte(profitLines.placedAt, from),
    lt(profitLines.placedAt, to),
  ];
  if (opts.channel) filters.push(eq(profitLines.channel, opts.channel));
  if (opts.designId) filters.push(eq(profitLines.designId, opts.designId));

  const keyExpr: Record<NetDimension, SQL<string>> = {
    order: sql<string>`${profitLines.orderId}::text`,
    design: sql<string>`coalesce(${profitLines.designId}::text, 'unmapped')`,
    blank: sql<string>`coalesce(${profitLines.styleCode}, 'unmapped')`,
    sku: sql<string>`coalesce(${profitLines.blankVariantId}::text, 'unmapped')`,
    channel: sql<string>`${profitLines.channel}`,
    day: sql<string>`to_char(${profitLines.placedAt} at time zone ${tz}, 'YYYY-MM-DD')`,
  };
  const labelExpr: Record<NetDimension, SQL<string | null>> = {
    order: sql<string | null>`max(${orders.orderNo})`,
    design: sql<string | null>`max(${designs.name})`,
    blank: blankLabel,
    sku: sql<string | null>`max(${blankVariants.sku})`,
    channel: sql<string | null>`null`,
    day: sql<string | null>`null`,
  };

  let q = tx
    .select({ key: keyExpr[opts.dimension], label: labelExpr[opts.dimension], ...sums })
    .from(profitLines)
    .$dynamic();
  if (opts.dimension === "order") q = q.leftJoin(orders, eq(orders.id, profitLines.orderId));
  if (opts.dimension === "design") q = q.leftJoin(designs, eq(designs.id, profitLines.designId));
  if (opts.dimension === "blank" || opts.dimension === "sku")
    q = q.leftJoin(blankVariants, eq(blankVariants.id, profitLines.blankVariantId));
  // GROUP BY the first select column: the day key binds the time zone as a parameter, and
  // Postgres won't match `$1` in the select list to `$5` in GROUP BY (500 on the day view).
  const groups: NetGroup[] = await q.where(and(...filters)).groupBy(sql`1`);
  mergeRefunds(groups, await refundGroups(tx, ctx.companyId, period, opts, tz));

  const [whole] = await tx
    .select({
      orders: sums.orders,
      units: sums.units,
      estimatedUnits: sums.estimatedUnits,
    })
    .from(profitLines)
    .where(and(...filters));
  const computedAt = groups.reduce<Date | null>((m, g) => {
    const d = g.computedAt ? new Date(g.computedAt) : null;
    return d && (!m || d > m) ? d : m;
  }, null);
  return {
    groups,
    totals: sumBuckets(groups),
    orders: whole?.orders ?? 0,
    units: whole?.units ?? 0,
    estimatedUnits: whole?.estimatedUnits ?? 0,
    ordersWithoutProfitLine: await countOrdersWithoutProfitLine(tx, ctx, period, opts.channel),
    computedAt,
    timezone: tz,
  };
}

/** Orders placed in the window with items but no profit line yet: reported, never dropped (AC-A7). */
export async function countOrdersWithoutProfitLine(
  tx: Tx,
  ctx: Ctx,
  period: NetPeriod,
  channel?: Channel,
): Promise<number> {
  const [missing] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(orders)
    .where(
      and(
        eq(orders.companyId, ctx.companyId),
        gte(orders.placedAt, new Date(period.from)),
        lt(orders.placedAt, new Date(period.to)),
        channel ? eq(orders.channel, channel) : undefined,
        sql`exists (select 1 from order_items oi where oi.order_id = ${orders.id})`,
        sql`not exists (select 1 from profit_lines pl where pl.order_id = ${orders.id})`,
      ),
    );
  return missing?.n ?? 0;
}

/**
 * T-7-2: refunds and the channel fee they give back, per dimension key, dated by the refund's
 * own `refundedAt` (not the order's placed-at), so a refund lands in its own period.
 */
async function refundGroups(
  tx: Tx,
  companyId: string,
  period: NetPeriod,
  opts: NetOptions,
  tz: string,
) {
  const r = refundEvents;
  const keyExpr: Record<NetDimension, SQL<string>> = {
    order: sql<string>`${r.orderId}::text`,
    design: sql<string>`coalesce(${orderItems.designId}::text, 'unmapped')`,
    blank: sql<string>`coalesce(${blankVariants.styleCode}, 'unmapped')`,
    sku: sql<string>`coalesce(${orderItems.blankVariantId}::text, 'unmapped')`,
    channel: sql<string>`${r.channel}`,
    day: sql<string>`to_char(${r.refundedAt} at time zone ${tz}, 'YYYY-MM-DD')`,
  };
  const labelExpr: Record<NetDimension, SQL<string | null>> = {
    order: sql<string | null>`max(${orders.orderNo})`,
    design: sql<string | null>`max(${designs.name})`,
    blank: blankLabel,
    sku: sql<string | null>`max(${blankVariants.sku})`,
    channel: sql<string | null>`null`,
    day: sql<string | null>`null`,
  };
  return tx
    .select({
      key: keyExpr[opts.dimension],
      label: labelExpr[opts.dimension],
      amount: sql<number>`coalesce(sum(${r.amountCents}), 0)::int`,
      recovered: sql<number>`coalesce(sum(${r.feeRecoveredCents}), 0)::int`,
    })
    .from(r)
    .innerJoin(orders, eq(orders.id, r.orderId))
    .leftJoin(orderItems, eq(orderItems.id, r.orderItemId))
    .leftJoin(designs, eq(designs.id, orderItems.designId))
    .leftJoin(blankVariants, eq(blankVariants.id, orderItems.blankVariantId))
    .where(
      and(
        eq(r.companyId, companyId),
        isNull(r.voidedAt),
        gte(r.refundedAt, new Date(period.from)),
        lt(r.refundedAt, new Date(period.to)),
        opts.channel ? eq(r.channel, opts.channel) : undefined,
        opts.designId ? eq(orderItems.designId, opts.designId) : undefined,
      ),
    )
    .groupBy(sql`1`);
}

/** Add refund events into the profit groups: refunds up, channel fees down by what came back. */
export function mergeRefunds(
  groups: NetGroup[],
  refunds: { key: string; label: string | null; amount: number; recovered: number }[],
): void {
  const byKey = new Map(groups.map((g) => [g.key, g]));
  for (const r of refunds) {
    let g = byKey.get(r.key);
    if (!g) {
      g = {
        key: r.key,
        label: r.label,
        revenue: 0,
        channelFees: 0,
        blankCost: 0,
        transferCost: 0,
        labelCost: 0,
        packagingCost: 0,
        laborCost: 0,
        adsCost: 0,
        refunds: 0,
        orders: 0,
        units: 0,
        estimatedUnits: 0,
        computedAt: null,
      };
      groups.push(g);
      byKey.set(r.key, g);
    }
    g.refunds += r.amount;
    g.channelFees -= r.recovered;
  }
}
