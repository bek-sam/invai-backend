import type { Channel } from "@invai/contracts";
import { and, eq, gte, inArray, isNotNull, lt, ne, or, sql } from "drizzle-orm";
import type { TenantContext } from "../../api/context";
import type { Tx } from "../../db/client";
import { channelConnections, orders, profitLines } from "../../db/schema";
import { errorData, logger } from "../../lib/log";
import {
  adPerformance,
  comparePeriods,
  designInsights,
  fulfillmentHealth,
  OPEN_STATUSES,
} from "../ai/analyst-queries";
import { getProfit } from "../finance/service";
import { lowStockItems } from "../inventory/service";
import { DIGEST_CONFIG as C } from "./config";
import { computeTrackE } from "./track-e";
import type { CostLines, LowStockBlank, Snapshot, UnhealthyChannel, WeekTotals } from "./types";
import { addDays, localMidnights } from "./week";

/*
 * The weekly snapshot (spec pipeline 4). Numbers come from the shared analyst queries (T-19-2)
 * and finance's `getProfit`, the functions behind the assistant tools and the profit page, so the
 * glance block's net equals the profit page's net for the same week by construction (AC1).
 *
 * Three small reads here touch other modules' tables directly, read-only, because no service
 * function answers them at an instant the digest controls (tests freeze time; the DB's `now()`
 * is not frozen): overdue open orders at `asOf`, the count of orders whose fees aren't final, the
 * connection health rows for D1, and which blanks the top designs' recent sales used (D7).
 */

type Ctx = Pick<TenantContext, "companyId">;

const log = logger("digest.snapshot");

export type WeekWindow = {
  weekKey: string;
  weekStart: string;
  weekEnd: string;
  periodFrom: Date;
  periodTo: Date;
  timezone: string;
};

const ZERO_COSTS: CostLines = {
  channelFees: 0,
  blankCost: 0,
  transferCost: 0,
  labelCost: 0,
  packagingCost: 0,
  laborCost: 0,
  adsCost: 0,
  refunds: 0,
};

function totalsOf(t: {
  orders: number;
  units: number;
  revenue: number;
  net: number;
  margin: number | null;
  adsCost: number;
  avgOrderValue: number | null;
}): WeekTotals {
  return {
    orders: t.orders,
    units: t.units,
    revenue: t.revenue,
    net: t.net,
    marginPct: t.margin === null ? null : Math.round(t.margin * 1000) / 10,
    adsCost: t.adsCost,
    avgOrderValue: t.avgOrderValue,
  };
}

export async function computeSnapshot(
  tx: Tx,
  ctx: Ctx,
  w: WeekWindow,
  asOf: Date,
): Promise<Snapshot> {
  const from = w.periodFrom.toISOString();
  const to = w.periodTo.toISOString();
  // Week starts back to 8 weeks before this one, as instants (DST-safe): index k = k weeks back.
  const starts = Array.from({ length: C.trailingWeeks + 1 }, (_, k) =>
    addDays(w.weekStart, -7 * k),
  );
  const mids = await localMidnights(tx, w.timezone, starts);
  const prevFrom = (mids[1] as Date).toISOString();
  const trailFrom = (mids[C.trailingWeeks] as Date).toISOString();

  const cmp = await comparePeriods(tx, ctx, {
    from,
    to,
    previousFrom: prevFrom,
    previousTo: from,
  });

  // Day rows over the trailing weeks plus this week: cost lines and trailing weekly totals.
  const days = await getProfit(tx, ctx, {
    dimension: "day",
    period: { from: trailFrom, to },
    limit: 7 * (C.trailingWeeks + 1) + 7,
    sort: "key",
  });
  const weekIndex = (ymd: string) => {
    const diff =
      (Date.parse(`${w.weekStart}T00:00:00Z`) - Date.parse(`${ymd}T00:00:00Z`)) / 86_400_000;
    return diff <= 0 ? 0 : Math.ceil(diff / 7);
  };
  const costs: CostLines[] = Array.from({ length: C.trailingWeeks + 1 }, () => ({ ...ZERO_COSTS }));
  const weekNet = new Map<number, number>();
  const weekRevenue = new Map<number, number>();
  for (const r of days.rows) {
    const k = weekIndex(r.key);
    if (k > C.trailingWeeks) continue;
    const c = costs[k] as CostLines;
    for (const line of Object.keys(ZERO_COSTS) as (keyof CostLines)[]) c[line] += r[line] ?? 0;
    weekNet.set(k, (weekNet.get(k) ?? 0) + r.net);
    weekRevenue.set(k, (weekRevenue.get(k) ?? 0) + r.revenue);
  }
  const trailingKeys = [...weekNet.keys()].filter((k) => k >= 1).sort((a, b) => a - b);

  const ads = await adPerformance(tx, ctx, { from, to });
  const designs = await designInsights(tx, ctx, { from, to, limit: C.d7.topDesigns });
  const fh = await fulfillmentHealth(tx, ctx, { from, to });
  const fhPrev = await fulfillmentHealth(tx, ctx, { from: prevFrom, to: from });

  const overdueRows = await tx
    .select({ channel: orders.channel, n: sql<number>`count(*)::int` })
    .from(orders)
    .where(
      and(
        eq(orders.companyId, ctx.companyId),
        inArray(orders.status, [...OPEN_STATUSES]),
        lt(orders.shipBy, asOf),
      ),
    )
    .groupBy(orders.channel);

  const channelKeys = [
    ...new Set([...fh.channels.map((c) => c.channel), ...overdueRows.map((r) => r.channel)]),
  ];
  const channels = channelKeys.map((ch) => {
    const c = fh.channels.find((x) => x.channel === ch);
    const p = fhPrev.channels.find((x) => x.channel === ch);
    return {
      channel: ch as Channel,
      shipped: c?.shipped ?? 0,
      onTimeRate: c?.onTimeRate ?? null,
      previousOnTimeRate: p?.onTimeRate ?? null,
      previousShipped: p?.shipped ?? 0,
      overdueNow: overdueRows.find((r) => r.channel === ch)?.n ?? 0,
    };
  });

  // A best-ever on-time rate is only worth checking when this week could be one (D8).
  let bestTrailingOnTimeRate: number | null = fhPrev.totals.onTimeRate;
  const current = fh.totals.onTimeRate;
  if (
    current !== null &&
    fh.totals.shipped >= C.d8.onTimeRecordMinShipped &&
    (bestTrailingOnTimeRate === null || current > bestTrailingOnTimeRate)
  ) {
    for (let k = 2; k <= C.minTrailingWeeks + 1; k++) {
      const h = await fulfillmentHealth(tx, ctx, {
        from: (mids[k] as Date).toISOString(),
        to: (mids[k - 1] as Date).toISOString(),
      });
      const r = h.totals.onTimeRate;
      if (r !== null && (bestTrailingOnTimeRate === null || r > bestTrailingOnTimeRate))
        bestTrailingOnTimeRate = r;
    }
  }

  let incompleteOrders = 0;
  if (cmp.incomplete) {
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(orders)
      .where(
        and(
          eq(orders.companyId, ctx.companyId),
          gte(orders.placedAt, w.periodFrom),
          lt(orders.placedAt, w.periodTo),
          sql`exists (select 1 from order_items oi where oi.order_id = ${orders.id})`,
          sql`not exists (select 1 from profit_lines pl where pl.order_id = ${orders.id})`,
        ),
      );
    incompleteOrders = row?.n ?? 0;
  }

  const unhealthyChannels = await unhealthy(tx, ctx, w);
  const lowStock = await lowStockForTopDesigns(tx, ctx, w, trailFrom, designs.topNet);

  // Track E (D9..D13, D2's mover) in a savepoint: a failed analytics read leaves those detectors
  // silent for this build instead of failing the whole digest.
  const trackE = await tx
    .transaction((sp) =>
      computeTrackE(
        sp,
        ctx,
        { periodFrom: w.periodFrom, periodTo: w.periodTo, weekStarts: mids as Date[] },
        w.timezone,
      ),
    )
    .catch((err) => {
      log.warn("track E inputs unavailable; D9..D13 left out", {
        companyId: ctx.companyId,
        ...errorData(err),
      });
      return undefined;
    });

  const netPerUnit = cmp.current.units > 0 ? cmp.current.net / cmp.current.units : null;
  return {
    weekKey: w.weekKey,
    weekStart: w.weekStart,
    weekEnd: w.weekEnd,
    periodFrom: from,
    periodTo: to,
    timezone: w.timezone,
    asOf: asOf.toISOString(),
    current: totalsOf(cmp.current),
    previous: totalsOf(cmp.previous),
    trailingNet: trailingKeys.map((k) => weekNet.get(k) ?? 0),
    trailingRevenue: trailingKeys.map((k) => weekRevenue.get(k) ?? 0),
    costLines: { current: costs[0] as CostLines, previous: costs[1] as CostLines },
    byChannel: cmp.byChannel.map((c) => ({
      channel: c.channel as Channel,
      revenue: c.revenue,
      previousRevenue: c.previousRevenue,
      net: c.net,
      previousNet: c.previousNet,
      orders: c.orders,
    })),
    incompleteOrders,
    ads:
      ads.groupBy === "channel" && ads.channels
        ? ads.channels.map((a) => ({
            channel: a.channel as Channel,
            spend: a.spend,
            previousSpend: a.previousSpend,
            revenue: a.revenue,
            previousRevenue: a.previousRevenue,
            roas: a.roas,
            netAfterAds: a.netAfterAds,
          }))
        : [],
    designs: {
      rising: designs.rising.map((d) => ({
        designId: d.designId,
        name: d.name,
        units: d.units,
        previousUnits: d.previousUnits,
      })),
      lowMargin: designs.lowMargin.map((d) => ({
        designId: d.designId,
        name: d.name,
        units: d.units,
        revenue: d.revenue,
        net: d.net,
        marginPct: Math.round((d.margin ?? 0) * 1000) / 10,
      })),
      crossListingGaps: designs.crossListingGaps.map((g) => {
        const top = designs.topNet.find((t) => t.designId === g.designId);
        return {
          designId: g.designId,
          name: g.name,
          soldOn: g.soldOn.map((s) => ({ channel: s.channel as Channel, units: s.units })),
          missingOn: g.missingOn as Channel[],
          netPerUnit: top && top.units > 0 ? top.net / top.units : netPerUnit,
        };
      }),
      top: designs.topNet.map((d) => ({
        designId: d.designId,
        name: d.name,
        units: d.units,
        net: d.net,
      })),
    },
    fulfillment: {
      channels,
      overdueNow: overdueRows.reduce((n, r) => n + r.n, 0),
      shipped: fh.totals.shipped,
      onTimeRate: fh.totals.onTimeRate,
      previousOnTimeRate: fhPrev.totals.onTimeRate,
      bestTrailingOnTimeRate,
      reprints: fh.totals.reprints,
      previousReprints: fhPrev.totals.reprints,
      reprintCostCents: fh.totals.reprintCostCents,
      topReprintReason: fh.reprints[0]?.reason ?? null,
      itemsPlaced: fh.totals.itemsPlaced,
    },
    lowStock,
    unhealthyChannels,
    trackE,
  };
}

/**
 * D1 source: a connection in error now, one disconnected during the week, or one that logged an
 * error during the week. CSV connections are never "disconnected" and are left out.
 */
async function unhealthy(tx: Tx, ctx: Ctx, w: WeekWindow): Promise<UnhealthyChannel[]> {
  const rows = await tx
    .select({
      id: channelConnections.id,
      channel: channelConnections.channel,
      status: channelConnections.status,
    })
    .from(channelConnections)
    .where(
      and(
        eq(channelConnections.companyId, ctx.companyId),
        ne(channelConnections.channel, "csv"),
        or(
          eq(channelConnections.status, "error"),
          and(
            eq(channelConnections.status, "disconnected"),
            gte(channelConnections.updatedAt, w.periodFrom),
          ),
          and(
            isNotNull(channelConnections.lastErrorAt),
            gte(channelConnections.lastErrorAt, w.periodFrom),
            lt(channelConnections.lastErrorAt, w.periodTo),
          ),
        ),
      ),
    )
    .orderBy(channelConnections.createdAt);
  return rows.map((r) => ({ connectionId: r.id, channel: r.channel as Channel, status: r.status }));
}

/** D7 source: low blanks, each linked to a top design whose recent sales used it. */
async function lowStockForTopDesigns(
  tx: Tx,
  ctx: Ctx,
  w: WeekWindow,
  trailFrom: string,
  top: { designId: string; name: string | null; units: number }[],
): Promise<LowStockBlank[]> {
  const low = await lowStockItems(tx, ctx).catch(() => []);
  if (!low.length) return [];
  const ids = low.map((l) => l.blankVariantId);
  const links = top.length
    ? await tx
        .selectDistinct({
          designId: sql<string>`${profitLines.designId}::text`,
          blankVariantId: sql<string>`${profitLines.blankVariantId}::text`,
        })
        .from(profitLines)
        .where(
          and(
            eq(profitLines.companyId, ctx.companyId),
            gte(profitLines.placedAt, new Date(trailFrom)),
            lt(profitLines.placedAt, w.periodTo),
            inArray(
              profitLines.designId,
              top.map((t) => t.designId),
            ),
            inArray(profitLines.blankVariantId, ids),
          ),
        )
    : [];
  return low.map((l) => {
    // The best-selling top design that used this blank.
    const design = top.find((t) =>
      links.some((x) => x.blankVariantId === l.blankVariantId && x.designId === t.designId),
    );
    const b = l.blank;
    return {
      blankVariantId: l.blankVariantId,
      name: [b.brand, b.styleCode, b.color, b.size].filter(Boolean).join(" "),
      available: l.available,
      reorderPoint: l.reorderPoint ?? 0,
      forDesign: design ? { designId: design.designId, name: design.name } : null,
      designUnits: design?.units ?? 0,
    };
  });
}
