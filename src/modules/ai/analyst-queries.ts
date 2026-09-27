import type { Channel } from "@invai/contracts";
import { and, eq, gte, inArray, isNotNull, isNull, lt, ne, sql } from "drizzle-orm";
import type { TenantContext } from "../../api/context";
import type { Tx } from "../../db/client";
import {
  adSpend,
  channelConnections,
  companies,
  designs,
  listings,
  listingVariants,
  orderItems,
  orders,
  profitLines,
  refundEvents,
  reprints,
} from "../../db/schema";
import { getProfit, localDay } from "../finance/service";

/*
 * Shared analyst queries (T-19-2, extracted from the wave 17 assistant tools). Plain data
 * functions: `(tx, ctx, input)` → numbers, no text. The assistant tools (assistant-tools.ts) and
 * the weekly digest (modules/digest) both call these, so the numbers match by construction.
 *
 * The caller opens the transaction (`withTenant(ctx.companyId, (tx) => ...)`), so RLS applies.
 * Every query also filters on `ctx.companyId`. No buyer PII: orders are counted, never listed.
 * Money in cents, ratios 0..1, timestamps ISO.
 */

/** Every list a query returns is capped at this many rows. */
export const MAX_ROWS = 20;
/** Rising, falling, low-margin and cross-listing signals need at least this many units. */
export const MIN_UNITS = 3;
export const LOW_MARGIN = 0.15;
export const OPEN_STATUSES = [
  "new",
  "needs_attention",
  "in_production",
  "ready_to_ship",
  "on_hold",
] as const;
/** A channel counts as "connected" for cross-listing unless it is pending or disconnected. */
const ACTIVE_CONNECTION = ["connected", "csv_only", "error"] as const;

export type Period = { from: string; to: string };
type Ctx = Pick<TenantContext, "companyId">;

export const ratio = (a: number, b: number) => (b > 0 ? a / b : null);
const perUnit = (a: number, b: number) => (b > 0 ? Math.round(a / b) : null);
const changeOf = (cur: number, prev: number) => ({
  abs: cur - prev,
  pct: prev !== 0 ? (cur - prev) / Math.abs(prev) : null,
});

/** Normalizes a range to ISO strings; throws on an invalid or empty range. */
export function toPeriod(from: string, to: string): Period {
  const f = new Date(from);
  const t = new Date(to);
  if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime()) || f >= t)
    throw new Error("`from` must be a valid timestamp before `to`");
  return { from: f.toISOString(), to: t.toISOString() };
}

/** The same-length period immediately before `p`. */
export function previousPeriod(p: Period): Period {
  const len = new Date(p.to).getTime() - new Date(p.from).getTime();
  return { from: new Date(new Date(p.from).getTime() - len).toISOString(), to: p.from };
}

/** Profit per channel for a period (at most 7 channels, so rows are never truncated). */
function channelProfit(tx: Tx, ctx: Ctx, period: Period, channel?: Channel) {
  return getProfit(tx, ctx, { dimension: "channel", period, channel, limit: 50, sort: "revenue" });
}

async function shopTimezone(tx: Tx, companyId: string): Promise<string> {
  const [c] = await tx
    .select({ tz: companies.timezone })
    .from(companies)
    .where(eq(companies.id, companyId));
  return c?.tz ?? "UTC";
}

/** Ad spend in a period: `ad_spend.day` is a shop-local day, as the profit allocation reads it. */
async function adSpendBy(
  tx: Tx,
  companyId: string,
  tz: string,
  p: Period,
  channel: Channel | undefined,
  byCampaign: boolean,
) {
  // Half-open on shop days too, so back-to-back periods never count a day twice.
  const where = and(
    eq(adSpend.companyId, companyId),
    gte(adSpend.day, localDay(new Date(p.from), tz)),
    lt(adSpend.day, localDay(new Date(p.to), tz)),
    channel ? eq(adSpend.channel, channel) : undefined,
  );
  const spend = sql<number>`coalesce(sum(${adSpend.amountCents}), 0)::int`;
  if (byCampaign)
    return tx
      .select({ channel: adSpend.channel, campaign: adSpend.campaign, spend })
      .from(adSpend)
      .where(where)
      .groupBy(adSpend.channel, adSpend.campaign);
  return tx
    .select({ channel: adSpend.channel, campaign: sql<string | null>`null`, spend })
    .from(adSpend)
    .where(where)
    .groupBy(adSpend.channel);
}

/* -------------------------------- comparePeriods -------------------------------- */

export type ComparePeriodsInput = {
  from: string;
  to: string;
  previousFrom?: string;
  previousTo?: string;
  channel?: Channel;
};

/**
 * Two periods side by side: orders, units, revenue, net, margin, ads cost and AOV, the change,
 * and each channel's contribution to the revenue and net change. With no previous range, the
 * previous period is the same length immediately before.
 */
export async function comparePeriods(tx: Tx, ctx: Ctx, input: ComparePeriodsInput) {
  const cur = toPeriod(input.from, input.to);
  const prev =
    input.previousFrom && input.previousTo
      ? toPeriod(input.previousFrom, input.previousTo)
      : previousPeriod(cur);
  const [a, b] = [
    await channelProfit(tx, ctx, cur, input.channel),
    await channelProfit(tx, ctx, prev, input.channel),
  ];
  const metrics = (s: typeof a, p: Period) => {
    const ordersN = s.rows.reduce((n, r) => n + r.orders, 0);
    return {
      from: p.from,
      to: p.to,
      orders: ordersN,
      units: s.rows.reduce((n, r) => n + r.units, 0),
      revenue: s.totals.revenue,
      net: s.totals.net,
      margin: s.totals.marginPct,
      adsCost: s.totals.adsCost,
      avgOrderValue: perUnit(s.totals.revenue, ordersN),
    };
  };
  const current = metrics(a, cur);
  const previous = metrics(b, prev);
  const change = {
    orders: changeOf(current.orders, previous.orders),
    units: changeOf(current.units, previous.units),
    revenue: changeOf(current.revenue, previous.revenue),
    net: changeOf(current.net, previous.net),
    adsCost: changeOf(current.adsCost, previous.adsCost),
    avgOrderValue: changeOf(current.avgOrderValue ?? 0, previous.avgOrderValue ?? 0),
    marginPoints:
      current.margin != null && previous.margin != null ? current.margin - previous.margin : null,
  };
  const keys = [...new Set([...a.rows, ...b.rows].map((r) => r.key))];
  const byChannel = keys
    .map((k) => {
      const x = a.rows.find((r) => r.key === k);
      const y = b.rows.find((r) => r.key === k);
      return {
        channel: k,
        revenue: x?.revenue ?? 0,
        previousRevenue: y?.revenue ?? 0,
        revenueChange: (x?.revenue ?? 0) - (y?.revenue ?? 0),
        net: x?.net ?? 0,
        previousNet: y?.net ?? 0,
        netChange: (x?.net ?? 0) - (y?.net ?? 0),
        orders: x?.orders ?? 0,
        previousOrders: y?.orders ?? 0,
      };
    })
    .sort((p, q) => Math.abs(q.revenueChange) - Math.abs(p.revenueChange))
    .slice(0, MAX_ROWS);
  const incomplete = a.incomplete || b.incomplete;
  return { current, previous, change, byChannel, incomplete };
}

export type ComparePeriodsResult = Awaited<ReturnType<typeof comparePeriods>>;

/* --------------------------------- adPerformance --------------------------------- */

export type AdPerformanceInput = {
  from: string;
  to: string;
  channel?: Channel;
  groupBy?: "channel" | "campaign";
};

/**
 * Ad efficiency per channel (ROAS, TACoS, cost per order, net before and after ads, flags vs the
 * previous same-length period), or spend per campaign. Attribution is channel-level only.
 */
export async function adPerformance(tx: Tx, ctx: Ctx, input: AdPerformanceInput) {
  const groupBy = input.groupBy ?? "channel";
  const cur = toPeriod(input.from, input.to);
  const prev = previousPeriod(cur);
  const tz = await shopTimezone(tx, ctx.companyId);
  const spendNow = await adSpendBy(
    tx,
    ctx.companyId,
    tz,
    cur,
    input.channel,
    groupBy === "campaign",
  );
  const totalSpend = spendNow.reduce((n, r) => n + r.spend, 0);

  if (groupBy === "campaign") {
    const campaigns = spendNow
      .filter((r) => r.spend !== 0)
      .sort((p, q) => q.spend - p.spend)
      .slice(0, MAX_ROWS)
      .map((r) => ({
        campaign: r.campaign,
        channel: r.channel,
        spend: r.spend,
        shareOfSpend: ratio(r.spend, totalSpend),
      }));
    return {
      attribution: "channel" as const,
      groupBy: "campaign" as const,
      totalSpend,
      campaigns,
    };
  }

  const spendPrev = await adSpendBy(tx, ctx.companyId, tz, prev, input.channel, false);
  // Whole-shop profit (no channel filter): TACoS divides by total shop revenue.
  const [pa, pb] = [await channelProfit(tx, ctx, cur), await channelProfit(tx, ctx, prev)];
  const totalRevenue = pa.totals.revenue;
  const keys = [
    ...new Set([...spendNow.map((r) => r.channel), ...pa.rows.map((r) => r.key)]),
  ].filter((k) => !input.channel || k === input.channel);
  const channels = keys
    .map((k) => {
      const spend = spendNow.find((r) => r.channel === k)?.spend ?? 0;
      const previousSpend = spendPrev.find((r) => r.channel === k)?.spend ?? 0;
      const p = pa.rows.find((r) => r.key === k);
      const q = pb.rows.find((r) => r.key === k);
      const revenue = p?.revenue ?? 0;
      const previousRevenue = q?.revenue ?? 0;
      const netBeforeAds = (p?.net ?? 0) + (p?.adsCost ?? 0);
      const netAfterAds = netBeforeAds - spend;
      const flags: string[] = [];
      if (spend > 0 && netAfterAds < 0) flags.push("spend_with_negative_net");
      if (spend > previousSpend && revenue < previousRevenue) flags.push("spend_up_revenue_down");
      return {
        channel: k,
        spend,
        revenue,
        orders: p?.orders ?? 0,
        roas: ratio(revenue, spend),
        tacos: ratio(spend, totalRevenue),
        adCostPerOrder: spend > 0 ? perUnit(spend, p?.orders ?? 0) : null,
        netBeforeAds,
        netAfterAds,
        previousSpend,
        previousRevenue,
        flags,
      };
    })
    .filter((r) => r.spend !== 0 || r.revenue !== 0)
    .sort((p, q) => q.spend - p.spend || q.revenue - p.revenue)
    .slice(0, MAX_ROWS);
  const scopeRevenue = input.channel ? (channels[0]?.revenue ?? 0) : totalRevenue;
  const totals = {
    spend: totalSpend,
    revenue: scopeRevenue,
    totalShopRevenue: totalRevenue,
    roas: ratio(scopeRevenue, totalSpend),
    tacos: ratio(totalSpend, totalRevenue),
  };
  return { attribution: "channel" as const, groupBy: "channel" as const, totals, channels };
}

export type AdPerformanceResult = Awaited<ReturnType<typeof adPerformance>>;

/* -------------------------------- designInsights -------------------------------- */

export type DesignInsightsInput = { from: string; to: string; limit?: number };

/**
 * Rising and falling designs, low-margin designs, top net designs and cross-listing gaps, vs the
 * previous same-length period. `designsSold` is the number of mapped designs sold in the period
 * (the assistant tool uses it for its "no sales" text and doesn't pass it to the model).
 */
export async function designInsights(tx: Tx, ctx: Ctx, input: DesignInsightsInput) {
  const limit = input.limit ?? 5;
  const cur = toPeriod(input.from, input.to);
  const prev = previousPeriod(cur);
  const opts = { dimension: "design", limit: 500, sort: "net" } as const;
  const a = await getProfit(tx, ctx, { ...opts, period: cur });
  const b = await getProfit(tx, ctx, { ...opts, period: prev });
  const prevUnits = new Map(b.rows.map((r) => [r.key, r.units]));
  const rows = a.rows
    .filter((r) => r.key !== "unmapped")
    .map((r) => ({
      designId: r.key,
      name: r.label,
      units: r.units,
      previousUnits: prevUnits.get(r.key) ?? 0,
      revenue: r.revenue,
      net: r.net,
      margin: r.marginPct,
    }));
  const trend = (r: (typeof rows)[number]) => ({
    designId: r.designId,
    name: r.name,
    units: r.units,
    previousUnits: r.previousUnits,
    change: changeOf(r.units, r.previousUnits),
  });
  const rising = rows
    .filter((r) => r.units >= MIN_UNITS && r.units > r.previousUnits)
    .sort((p, q) => q.units - q.previousUnits - (p.units - p.previousUnits))
    .slice(0, limit)
    .map(trend);
  // Designs that sold before and fell (including to zero this period).
  const falling = b.rows
    .filter((r) => r.key !== "unmapped" && r.units >= MIN_UNITS)
    .map((r) => {
      const now = rows.find((x) => x.designId === r.key);
      return {
        designId: r.key,
        name: r.label,
        units: now?.units ?? 0,
        previousUnits: r.units,
        revenue: now?.revenue ?? 0,
        net: now?.net ?? 0,
        margin: now?.margin ?? null,
      };
    })
    .filter((r) => r.units < r.previousUnits)
    .sort((p, q) => p.units - p.previousUnits - (q.units - q.previousUnits))
    .slice(0, limit)
    .map(trend);
  const lowMargin = rows
    .filter((r) => r.units >= MIN_UNITS && r.margin != null && r.margin < LOW_MARGIN)
    .sort((p, q) => (p.margin ?? 0) - (q.margin ?? 0))
    .slice(0, limit)
    .map(({ designId, name, units, revenue, net, margin }) => ({
      designId,
      name,
      units,
      revenue,
      net,
      margin,
    }));
  const topNet = rows
    .filter((r) => r.net > 0)
    .sort((p, q) => q.net - p.net)
    .slice(0, limit)
    .map(({ designId, name, units, revenue, net, margin }) => ({
      designId,
      name,
      units,
      revenue,
      net,
      margin,
    }));

  // Cross-listing gaps: units per design and channel (sold, not reprints or refunded).
  const sold = await tx
    .select({
      designId: sql<string>`${profitLines.designId}::text`,
      channel: profitLines.channel,
      units: sql<number>`count(*)::int`,
    })
    .from(profitLines)
    .where(
      and(
        eq(profitLines.companyId, ctx.companyId),
        gte(profitLines.placedAt, new Date(cur.from)),
        lt(profitLines.placedAt, new Date(cur.to)),
        isNotNull(profitLines.designId),
        eq(profitLines.isReprint, false),
        eq(profitLines.refundsCents, 0),
      ),
    )
    .groupBy(profitLines.designId, profitLines.channel)
    .having(sql`count(*) >= ${MIN_UNITS}`);
  const conns = await tx
    .select({ channel: channelConnections.channel, status: channelConnections.status })
    .from(channelConnections)
    .where(
      and(eq(channelConnections.companyId, ctx.companyId), ne(channelConnections.channel, "csv")),
    );
  const isActive = (st: string) => (ACTIVE_CONNECTION as readonly string[]).includes(st);
  const connected = [...new Set(conns.filter((c) => isActive(c.status)).map((c) => c.channel))];
  // A channel whose every connection is pending or disconnected is left out of the gaps.
  const inactive = [
    ...new Set(conns.filter((c) => !connected.includes(c.channel)).map((c) => c.channel)),
  ];
  const gapIds = [...new Set(sold.map((s) => s.designId))];
  const listed = gapIds.length
    ? [
        ...(await tx
          .selectDistinct({
            designId: sql<string>`${listings.designId}::text`,
            channel: listings.channel,
          })
          .from(listings)
          .where(
            and(
              eq(listings.companyId, ctx.companyId),
              eq(listings.state, "active"),
              inArray(listings.designId, gapIds),
            ),
          )),
        ...(await tx
          .selectDistinct({
            designId: sql<string>`${listingVariants.designId}::text`,
            channel: listings.channel,
          })
          .from(listingVariants)
          .innerJoin(listings, eq(listings.id, listingVariants.listingId))
          .where(
            and(
              eq(listingVariants.companyId, ctx.companyId),
              eq(listings.state, "active"),
              inArray(listingVariants.designId, gapIds),
            ),
          )),
      ]
    : [];
  const names = gapIds.length
    ? await tx
        .select({ id: sql<string>`${designs.id}::text`, name: designs.name })
        .from(designs)
        .where(and(eq(designs.companyId, ctx.companyId), inArray(designs.id, gapIds)))
    : [];
  const crossListingGaps = gapIds
    .map((id) => {
      const soldOn = sold
        .filter((s) => s.designId === id)
        .sort((p, q) => q.units - p.units)
        .map((s) => ({ channel: s.channel, units: s.units }));
      const has = new Set(listed.filter((l) => l.designId === id).map((l) => l.channel));
      const missingOn = connected.filter(
        (c) => !has.has(c) && !soldOn.some((s) => s.channel === c),
      );
      return {
        designId: id,
        name: names.find((n) => n.id === id)?.name ?? null,
        soldOn,
        missingOn,
      };
    })
    .filter((g) => g.missingOn.length > 0)
    .sort((p, q) => (q.soldOn[0]?.units ?? 0) - (p.soldOn[0]?.units ?? 0))
    .slice(0, limit);

  const reasons = [
    ...(a.incomplete ? ["missing_cost_data"] : []),
    ...(inactive.length ? [`channel_not_connected:${inactive.join(",")}`] : []),
  ];
  return {
    period: cur,
    previousPeriod: prev,
    minUnits: MIN_UNITS,
    lowMarginBelow: LOW_MARGIN,
    rising,
    falling,
    lowMargin,
    topNet,
    crossListingGaps,
    inactiveChannels: inactive,
    incomplete: reasons.length > 0,
    incompleteReasons: reasons,
    /** Cost data missing in the period (the tool's "estimates" note). */
    missingCostData: a.incomplete,
    designsSold: rows.length,
  };
}

export type DesignInsightsResult = Awaited<ReturnType<typeof designInsights>>;

/* ------------------------------- fulfillmentHealth ------------------------------- */

export type FulfillmentHealthInput = { from: string; to: string; channel?: Channel };

/**
 * On-time ship rate per channel, late shipments, median placed → shipped hours, open orders
 * overdue right now, reprints by reason (rate and estimated cost) and refunds per channel.
 */
export async function fulfillmentHealth(tx: Tx, ctx: Ctx, input: FulfillmentHealthInput) {
  const cur = toPeriod(input.from, input.to);
  const from = new Date(cur.from);
  const to = new Date(cur.to);
  const byChannel = input.channel ? eq(orders.channel, input.channel) : undefined;
  const hours = sql`extract(epoch from (${orders.shippedAt} - ${orders.placedAt})) / 3600`;
  const shippedWhere = and(
    eq(orders.companyId, ctx.companyId),
    gte(orders.shippedAt, from),
    lt(orders.shippedAt, to),
    ne(orders.status, "cancelled"),
    byChannel,
  );
  const shipped = await tx
    .select({
      channel: orders.channel,
      shipped: sql<number>`count(*)::int`,
      onTime: sql<number>`(count(*) filter (where ${orders.shippedAt} <= ${orders.shipBy}))::int`,
      medianHours: sql<
        number | null
      >`percentile_cont(0.5) within group (order by ${hours})::float8`,
    })
    .from(orders)
    .where(shippedWhere)
    .groupBy(orders.channel);
  const [all] = await tx
    .select({
      medianHours: sql<
        number | null
      >`percentile_cont(0.5) within group (order by ${hours})::float8`,
    })
    .from(orders)
    .where(shippedWhere);
  const overdue = await tx
    .select({ channel: orders.channel, n: sql<number>`count(*)::int` })
    .from(orders)
    .where(
      and(
        eq(orders.companyId, ctx.companyId),
        inArray(orders.status, [...OPEN_STATUSES]),
        sql`${orders.shipBy} < now()`,
        byChannel,
      ),
    )
    .groupBy(orders.channel);
  const [placed] = await tx
    .select({ items: sql<number>`count(*)::int` })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(
      and(
        eq(orderItems.companyId, ctx.companyId),
        gte(orders.placedAt, from),
        lt(orders.placedAt, to),
        ne(orderItems.state, "cancelled"),
        byChannel,
      ),
    );
  // Estimated reprint cost: one more transfer (the item's transfer cost split over its
  // prints) plus the blank when it was ruined.
  const reprintCost = sql<number>`coalesce(sum(
    case when ${reprints.blankConsumed} then coalesce(${profitLines.blankCostCents}, 0) else 0 end
    + coalesce(${profitLines.transferCostCents}, 0) / (1 + (
      select count(*) from reprints r2
      where r2.order_item_id = ${reprints.orderItemId} and r2.status <> 'cancelled'))
  ), 0)::int`;
  const reprintRows = await tx
    .select({
      reason: reprints.reason,
      count: sql<number>`count(*)::int`,
      costCents: reprintCost,
    })
    .from(reprints)
    .innerJoin(orderItems, eq(orderItems.id, reprints.orderItemId))
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .leftJoin(profitLines, eq(profitLines.orderItemId, reprints.orderItemId))
    .where(
      and(
        eq(reprints.companyId, ctx.companyId),
        gte(reprints.requestedAt, from),
        lt(reprints.requestedAt, to),
        ne(reprints.status, "cancelled"),
        byChannel,
      ),
    )
    .groupBy(reprints.reason);
  const refunds = await tx
    .select({
      channel: refundEvents.channel,
      count: sql<number>`count(*)::int`,
      amount: sql<number>`coalesce(sum(${refundEvents.amountCents}), 0)::int`,
    })
    .from(refundEvents)
    .where(
      and(
        eq(refundEvents.companyId, ctx.companyId),
        isNull(refundEvents.voidedAt),
        gte(refundEvents.refundedAt, from),
        lt(refundEvents.refundedAt, to),
        input.channel ? eq(refundEvents.channel, input.channel) : undefined,
      ),
    )
    .groupBy(refundEvents.channel);

  const keys = [...new Set([...shipped, ...overdue].map((r) => r.channel))];
  const channels = keys
    .map((k) => {
      const s = shipped.find((r) => r.channel === k);
      return {
        channel: k,
        shipped: s?.shipped ?? 0,
        onTime: s?.onTime ?? 0,
        late: (s?.shipped ?? 0) - (s?.onTime ?? 0),
        onTimeRate: ratio(s?.onTime ?? 0, s?.shipped ?? 0),
        medianHoursToShip: s?.medianHours ?? null,
        overdueOpenNow: overdue.find((r) => r.channel === k)?.n ?? 0,
      };
    })
    .sort((p, q) => q.shipped - p.shipped)
    .slice(0, MAX_ROWS);
  const shippedN = channels.reduce((n, c) => n + c.shipped, 0);
  const onTimeN = channels.reduce((n, c) => n + c.onTime, 0);
  const items = placed?.items ?? 0;
  const reprintList = reprintRows
    .map((r) => ({ ...r, ratePerItem: ratio(r.count, items) }))
    .sort((p, q) => q.count - p.count)
    .slice(0, MAX_ROWS);
  const reprintN = reprintList.reduce((n, r) => n + r.count, 0);
  const totals = {
    shipped: shippedN,
    onTime: onTimeN,
    late: shippedN - onTimeN,
    onTimeRate: ratio(onTimeN, shippedN),
    medianHoursToShip: all?.medianHours ?? null,
    overdueOpenNow: channels.reduce((n, c) => n + c.overdueOpenNow, 0),
    itemsPlaced: items,
    reprints: reprintN,
    reprintRate: ratio(reprintN, items),
    reprintCostCents: reprintList.reduce((n, r) => n + r.costCents, 0),
    refunds: refunds.reduce((n, r) => n + r.count, 0),
    refundAmount: refunds.reduce((n, r) => n + r.amount, 0),
  };
  const refundRows = refunds.sort((p, q) => q.amount - p.amount).slice(0, MAX_ROWS);
  return { period: cur, totals, channels, reprints: reprintList, refunds: refundRows };
}

export type FulfillmentHealthResult = Awaited<ReturnType<typeof fulfillmentHealth>>;
