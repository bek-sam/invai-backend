import type { Channel } from "@invai/contracts";
import { systemContext } from "../../api/context";
import type { Tx } from "../../db/client";
import {
  breakEven,
  losingOrders,
  profitBridge,
  shippingMargin,
} from "../analytics/finance-service";
import { inventoryHealth, supplierTrends } from "../analytics/inventory-service";
import { getBlank } from "../catalog/service";
import { DIGEST_CONFIG as C } from "./config";
import type { ShippingChannelWeek, SizeGap, SupplierCostRise, TrackE } from "./types";

/*
 * Track E inputs for D9..D13 and D2's bridge mover (T-A9). Every number comes from the same
 * `analytics.*` service the screens and the assistant call, for the digest's own period, so the
 * digest, Today and the analytics pages agree by construction (spec rule 1). Read-only.
 */

type Ctx = { companyId: string };

/** `[from, to)` instants of the digest week and the weeks before it (index k = k weeks back). */
export type TrackEWindow = { periodFrom: Date; periodTo: Date; weekStarts: Date[] };

const iso = (d: Date) => d.toISOString();

/** `YYYY-MM` minus `n` months. */
export function monthMinus(ym: string, n: number): string {
  const [y, m] = ym.split("-").map(Number) as [number, number];
  const idx = y * 12 + (m - 1) - n;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;
}

/**
 * D12 rows: for each supplier × style, its latest month against the most recent month at least
 * `monthsBack` earlier. The latest month must be the window's month or the one before (a price
 * from last spring is not news).
 */
export function supplierCostRises(
  rows: {
    supplierName: string;
    styleCode: string;
    month: string;
    units: number;
    avgUnitCost: number;
    supplier: string;
  }[],
  windowMonth: string,
): SupplierCostRise[] {
  const bySeries = new Map<string, typeof rows>();
  for (const r of rows) {
    const k = `${r.supplier}|${r.styleCode}`;
    bySeries.set(k, [...(bySeries.get(k) ?? []), r]);
  }
  const out: SupplierCostRise[] = [];
  for (const series of bySeries.values()) {
    const sorted = [...series].sort((a, b) => a.month.localeCompare(b.month));
    const latest = sorted[sorted.length - 1];
    if (!latest || latest.month < monthMinus(windowMonth, 1)) continue;
    const cutoff = monthMinus(latest.month, C.d12.monthsBack);
    const base = sorted.filter((r) => r.month <= cutoff).pop();
    if (!base || base.avgUnitCost <= 0) continue;
    out.push({
      supplierName: latest.supplierName,
      style: latest.styleCode,
      month: latest.month,
      baseMonth: base.month,
      unitCost: latest.avgUnitCost,
      baseUnitCost: base.avgUnitCost,
      units: latest.units,
    });
  }
  return out.sort(
    (a, b) => a.supplierName.localeCompare(b.supplierName) || a.style.localeCompare(b.style),
  );
}

export async function computeTrackE(
  tx: Tx,
  ctx: Ctx,
  w: TrackEWindow,
  timezone: string,
): Promise<TrackE> {
  const period = { from: iso(w.periodFrom), to: iso(w.periodTo) };

  // D9: this week and the weeks before it, by channel.
  const cur = await shippingMargin(tx, ctx, { period, groupBy: "channel" });
  const trailing: Map<string, number>[] = [];
  for (let k = 1; k <= C.d9.trailingWeeks; k++) {
    const from = w.weekStarts[k];
    const to = w.weekStarts[k - 1];
    if (!from || !to) break;
    const r = await shippingMargin(tx, ctx, {
      period: { from: iso(from), to: iso(to) },
      groupBy: "channel",
    });
    trailing.push(
      new Map(
        r.rows
          .filter((x) => x.marginPerOrder !== null)
          .map((x) => [x.key, x.marginPerOrder as number]),
      ),
    );
  }
  const shipping: ShippingChannelWeek[] = cur.rows.map((r) => ({
    channel: r.key as Channel,
    labeledOrders: r.labeledOrders,
    marginPerOrder: r.marginPerOrder,
    trailing: trailing.flatMap((m) => (m.has(r.key) ? [m.get(r.key) as number] : [])),
  }));

  // D10.
  const lo = await losingOrders(tx, ctx, { period, limit: 1 });

  // D11: stock as of now, sales over the trailing window.
  const inv = await inventoryHealth(tx, ctx, { days: C.d11.days });
  const topRow = inv.deadStock.rows[0];
  let topDead: TrackE["inventory"]["topDead"] = null;
  if (topRow) {
    const b = await getBlank(tx, systemContext(ctx.companyId), topRow.blankVariantId).catch(
      () => null,
    );
    if (b)
      topDead = {
        blankVariantId: topRow.blankVariantId,
        style: b.styleCode,
        color: b.color,
        value: topRow.value,
      };
  }
  const gaps: SizeGap[] = inv.sizeMixGaps
    .filter((g) => g.hasEnoughUnits)
    .flatMap((g) =>
      g.sizes.flatMap((s) =>
        s.gapPts !== null && s.coverDays !== null
          ? [
              {
                style: g.styleCode,
                color: g.color,
                size: s.size,
                gapPts: s.gapPts,
                coverDays: s.coverDays,
                unitsSold: s.unitsSold,
                onHand: s.onHand,
              },
            ]
          : [],
      ),
    );

  // D12: months in the shop's time zone, from the supplier trend service.
  const st = await supplierTrends(tx, ctx, {
    period: {
      from: iso(new Date(w.periodTo.getTime() - C.d12.lookbackDays * 86_400_000)),
      to: period.to,
    },
  });
  const windowMonth = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
  })
    .format(new Date(w.periodTo.getTime() - 1))
    .slice(0, 7);

  // D13: pace over the last 4 weeks (a 7-day pace is too noisy for a monthly break-even).
  const beFrom = w.weekStarts[C.d13.windowWeeks - 1] ?? w.periodFrom;
  const be = await breakEven(tx, ctx, { period: { from: iso(beFrom), to: period.to } });

  // D2 (AC-E1f): the bridge's own ranking for the same period, by design (its default).
  const bridge = await profitBridge(tx, ctx, { period, by: "design" });
  const top = bridge.topMovers[0];

  return {
    shipping,
    losing: {
      ordersWithProfitLine: lo.ordersWithProfitLine,
      losingOrders: lo.losingOrders,
      losingPct: lo.losingPct,
      lossCents: lo.lossCents,
    },
    inventory: {
      days: inv.days,
      deadPctOfStockValue: inv.deadStock.pctOfStockValue,
      deadValue: inv.deadStock.value,
      deadVariants: inv.deadStock.variants,
      topDead,
      gaps,
    },
    supplierCosts: supplierCostRises(st.rows, windowMonth),
    breakEven: {
      fixedCostsSet: be.fixedCostsSet,
      hasEnoughOrders: be.hasEnoughOrders,
      days: Math.max(1, Math.round((w.periodTo.getTime() - beFrom.getTime()) / 86_400_000)),
      orders: be.orders,
      pace: be.pace,
      breakEvenOrders: be.breakEvenOrders,
      operatingProfitPace: be.operatingProfitPace,
    },
    bridgeTopMover:
      top && top.change !== 0 ? { key: top.key, label: top.label, change: top.change } : null,
  };
}
