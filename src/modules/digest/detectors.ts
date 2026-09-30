import type { DigestActionParams, DigestFact } from "@invai/contracts";
import { DIGEST_CONFIG as C } from "./config";
import { fact, median, pctChange } from "./facts";
import type { Candidate, CostLine, Snapshot } from "./types";

/*
 * Detectors D1–D8 (spec pipeline 5): pure functions of the snapshot, each guarded by a minimum
 * volume so a small shop gets "A steady week" instead of noise (AC8). Every candidate carries one
 * fixed action with an in-app href and the facts its copy needs; nothing here writes text.
 */

const COST_LINES: CostLine[] = [
  "channelFees",
  "blankCost",
  "transferCost",
  "labelCost",
  "packagingCost",
  "laborCost",
  "adsCost",
  "refunds",
];
/** Where each cost line is edited (D3 action). Ads and refunds live on the profit page. */
const COST_LINE_HREF: Record<CostLine, string> = {
  channelFees: "/settings/costs",
  blankCost: "/settings/costs",
  transferCost: "/settings/costs",
  labelCost: "/settings/costs",
  packagingCost: "/settings/costs",
  laborCost: "/settings/costs",
  adsCost: "/analytics/ad-spend",
  refunds: "/analytics/profit?dim=order&days=7",
};

const enc = encodeURIComponent;

function action(
  kind: Candidate["action"]["kind"],
  href: string,
  params: DigestActionParams = {},
): Candidate["action"] {
  return { kind, href, params };
}

/** D1: one row per channel connection that is in error or disconnected (pinned first). */
export function d1DataHealth(s: Snapshot): Candidate[] {
  return s.unhealthyChannels.map((c) => ({
    detector: "D1",
    section: "action",
    fingerprint: `D1:${c.connectionId}`,
    impactCents: null,
    confidence: 1,
    templateKey: "D1 action",
    action: action("reconnect_channel", "/settings/channels", {
      channel: c.channel,
      connectionId: c.connectionId,
    }),
    facts: [fact(`d1.${c.channel}.status`, "text", c.status)],
  }));
}

/** D2: revenue or net moved ≥ 15% and ≥ $100 vs last week and vs the trailing median. */
export function d2Change(s: Snapshot): Candidate[] {
  const out: Candidate[] = [];
  for (const metric of ["net", "revenue"] as const) {
    const cur = s.current[metric];
    const prev = s.previous[metric];
    const trailing = median(metric === "net" ? s.trailingNet : s.trailingRevenue);
    const vsPrev = pctChange(cur, prev);
    const vsTrailing = pctChange(cur, trailing);
    const absPrev = Math.abs(cur - prev);
    const absTrailing = trailing === null ? 0 : Math.abs(cur - trailing);
    if (vsPrev === null || Math.abs(vsPrev) < C.d2.minChangePct) continue;
    if (absPrev < C.d2.minChangeCents) continue;
    if (trailing !== null && s.trailingNet.length >= C.minTrailingWeeks) {
      if (vsTrailing === null || Math.abs(vsTrailing) < C.d2.minChangePct) continue;
      if (absTrailing < C.d2.minChangeCents) continue;
    }
    const top = [...s.byChannel].sort(
      (a, b) =>
        Math.abs(metric === "net" ? b.net - b.previousNet : b.revenue - b.previousRevenue) -
        Math.abs(metric === "net" ? a.net - a.previousNet : a.revenue - a.previousRevenue),
    )[0];
    const facts: DigestFact[] = [
      fact(`d2.${metric}.current`, "cents", cur),
      fact(`d2.${metric}.previous`, "cents", prev),
      fact(`d2.${metric}.changePct`, "pct", Math.round((vsPrev ?? 0) * 10) / 10),
    ];
    if (top) {
      facts.push(fact(`d2.${metric}.topChannel`, "text", top.channel));
      facts.push(
        fact(
          `d2.${metric}.topChannelChange`,
          "cents",
          metric === "net" ? top.net - top.previousNet : top.revenue - top.previousRevenue,
        ),
      );
    }
    // AC-E1f: name the mover `analytics.profitBridge` ranks first for the same period (by design,
    // the bridge's and `explain_profit_change`'s default), not a second ranking of our own.
    const mover = s.trackE?.bridgeTopMover ?? null;
    if (mover) {
      facts.push(fact("d2.topMover", "text", mover.label));
      facts.push(fact("d2.topMoverChange", "cents", mover.change));
    }
    const moverParams: DigestActionParams = mover
      ? {
          designName: mover.label,
          ...(mover.key !== "unmapped" ? { designId: mover.key } : {}),
        }
      : top
        ? { channel: top.channel }
        : {};
    out.push({
      detector: "D2",
      section: "action",
      fingerprint: `D2:${metric}:${cur >= prev ? "up" : "down"}`,
      impactCents: absPrev,
      confidence: s.incompleteOrders > 0 ? 0.6 : 0.8,
      templateKey: mover ? "D2 action.mover" : "D2 action",
      action: action(
        "see_what_changed",
        mover ? "/analytics/profit?view=why&days=7" : "/analytics/profit?dim=channel&days=7",
        moverParams,
      ),
      facts,
    });
    break; // one D2 row: net if it moved, else revenue
  }
  return out;
}

/** D3: margin down ≥ 3 points with ≥ 20 orders; names the cost line that moved most. */
export function d3MarginSlip(s: Snapshot): Candidate[] {
  const cur = s.current.marginPct;
  const prev = s.previous.marginPct;
  if (cur === null || prev === null) return [];
  if (s.current.orders < C.d3.minOrders) return [];
  const drop = prev - cur;
  if (drop < C.d3.minMarginDropPoints) return [];
  // The cost line whose share of revenue grew the most.
  const share = (v: number, rev: number) => (rev > 0 ? v / rev : 0);
  const line = COST_LINES.map((l) => ({
    l,
    delta:
      share(s.costLines.current[l], s.current.revenue) -
      share(s.costLines.previous[l], s.previous.revenue),
  })).sort((a, b) => b.delta - a.delta)[0];
  if (!line) return [];
  return [
    {
      detector: "D3",
      section: "action",
      fingerprint: `D3:${line.l}`,
      impactCents: Math.round((drop / 100) * s.current.revenue),
      confidence: s.incompleteOrders > 0 ? 0.6 : 0.8,
      templateKey: "D3 action",
      action: action("review_costs", COST_LINE_HREF[line.l], { costLine: line.l }),
      facts: [
        fact("d3.marginPct", "pct", Math.round(cur * 10) / 10),
        fact("d3.previousMarginPct", "pct", Math.round(prev * 10) / 10),
        fact("d3.dropPoints", "pct", Math.round(drop * 10) / 10),
        fact("d3.costLine", "text", line.l),
      ],
    },
  ];
}

/** D4: per channel with ad spend: spend up while revenue down, ROAS < 2, or spend with negative net. */
export function d4Ads(s: Snapshot): Candidate[] {
  const out: Candidate[] = [];
  for (const a of s.ads) {
    if (a.spend < C.d4.minSpendCents) continue;
    const upDown = a.spend > a.previousSpend && a.revenue < a.previousRevenue;
    const lowRoas = a.roas !== null && a.roas < C.d4.maxRoas;
    const negative = a.netAfterAds < 0;
    if (!upDown && !lowRoas && !negative) continue;
    out.push({
      detector: "D4",
      section: "action",
      fingerprint: `D4:${a.channel}`,
      impactCents: negative ? Math.min(a.spend, -a.netAfterAds) : Math.round(a.spend / 2),
      confidence: 0.6, // attribution is by channel, not by ad
      templateKey: "D4 action",
      action: action("review_ads", "/analytics/ad-spend", { channel: a.channel }),
      facts: [
        fact(`d4.${a.channel}.spend`, "cents", a.spend),
        fact(`d4.${a.channel}.revenue`, "cents", a.revenue),
        fact(`d4.${a.channel}.roas`, "ratio", a.roas),
        fact(`d4.${a.channel}.netAfterAds`, "cents", a.netAfterAds),
      ],
    });
  }
  return out;
}

/** D5: cross-listing gaps on connected channels, and low-margin designs (≥ 3 units, < 15%). */
export function d5Designs(s: Snapshot): Candidate[] {
  const out: Candidate[] = [];
  for (const g of s.designs.crossListingGaps) {
    const best = g.soldOn[0];
    const missing = g.missingOn[0];
    if (!best || !missing || best.units < C.d5.minUnits) continue;
    const name = g.name ?? "";
    out.push({
      detector: "D5",
      section: "action",
      fingerprint: `D5:gap:${g.designId}:${missing}`,
      impactCents:
        g.netPerUnit !== null ? Math.max(0, Math.round(g.netPerUnit * best.units)) : null,
      confidence: 0.5,
      templateKey: "D5 action",
      action: action("list_design", `/listings/drafts?designId=${enc(g.designId)}&create=true`, {
        designId: g.designId,
        designName: name,
        channel: missing,
      }),
      facts: [
        fact(`d5.${g.designId}.units`, "count", best.units),
        fact(`d5.${g.designId}.soldOn`, "text", best.channel),
        fact(`d5.${g.designId}.missingOn`, "text", missing),
      ],
    });
  }
  for (const d of s.designs.lowMargin) {
    if (d.units < C.d5.minUnits || d.marginPct >= C.d5.lowMarginPct) continue;
    out.push({
      detector: "D5",
      section: "action",
      fingerprint: `D5:price:${d.designId}`,
      impactCents: Math.round(((C.d5.lowMarginPct - d.marginPct) / 100) * d.revenue),
      confidence: 0.7,
      templateKey: "D5 action",
      action: action("review_price", `/catalog/designs/${enc(d.designId)}`, {
        designId: d.designId,
        designName: d.name ?? "",
      }),
      facts: [
        fact(`d5.${d.designId}.marginPct`, "pct", Math.round(d.marginPct * 10) / 10),
        fact(`d5.${d.designId}.units`, "count", d.units),
        fact(`d5.${d.designId}.net`, "cents", d.net),
      ],
    });
  }
  return out;
}

/**
 * D6: overdue open orders now (the action) with each channel's on-time slip as facts; and a
 * reprint spike with its top reason. An on-time slip with nothing overdue has no fixed action,
 * so it only shows in the glance block's on-time row.
 */
export function d6Fulfillment(s: Snapshot): Candidate[] {
  const f = s.fulfillment;
  const out: Candidate[] = [];
  const slipping = f.channels.filter(
    (c) =>
      c.shipped >= C.d6.minShipped &&
      c.onTimeRate !== null &&
      (c.onTimeRate * 100 < C.d6.minOnTimePct ||
        (c.previousOnTimeRate !== null &&
          c.previousShipped >= C.d6.minShipped &&
          (c.previousOnTimeRate - c.onTimeRate) * 100 >= C.d6.maxOnTimeDropPoints)),
  );
  if (f.overdueNow > 0) {
    const worst = [...f.channels].sort((a, b) => b.overdueNow - a.overdueNow)[0];
    const single = f.channels.filter((c) => c.overdueNow > 0).length === 1;
    const facts: DigestFact[] = [fact("d6.overdueNow", "count", f.overdueNow)];
    for (const c of slipping) facts.push(fact(`d6.${c.channel}.onTimeRate`, "ratio", c.onTimeRate));
    const channelQ = single && worst ? `&channel=${enc(worst.channel)}` : "";
    out.push({
      detector: "D6",
      section: "action",
      fingerprint: "D6:overdue",
      impactCents: f.overdueNow * (s.current.avgOrderValue ?? s.previous.avgOrderValue ?? 0),
      confidence: 0.95,
      templateKey: "D6 action",
      action: action("ship_overdue", `/orders?view=overdue${channelQ}`, {
        n: f.overdueNow,
        ...(single && worst ? { channel: worst.channel } : {}),
      }),
      facts,
    });
  }
  const spike =
    f.reprints >= C.d6.minReprints &&
    (f.previousReprints === 0 || f.reprints >= f.previousReprints * C.d6.reprintSpikeRatio);
  if (spike) {
    out.push({
      detector: "D6",
      section: "action",
      fingerprint: "D6:reprints",
      impactCents: f.reprintCostCents,
      confidence: 0.8,
      templateKey: "D6 action",
      action: action("see_reprints", "/production/reprints", { n: f.reprints }),
      facts: [
        fact("d6.reprints", "count", f.reprints),
        fact("d6.previousReprints", "count", f.previousReprints),
        fact("d6.reprintCost", "cents", f.reprintCostCents),
        fact("d6.topReprintReason", "text", f.topReprintReason),
      ],
    });
  }
  return out;
}

/** D7: blanks below their reorder point that the top designs need next week. */
export function d7Stock(s: Snapshot): Candidate[] {
  const linked = s.lowStock.filter((b) => b.forDesign);
  // No sale recorded which blank it used: fall back to every low blank, at lower confidence.
  const rows = linked.length ? linked : s.current.units > 0 ? s.lowStock : [];
  const perUnit = s.current.units > 0 ? s.current.net / s.current.units : 0;
  return rows.map((b) => ({
    detector: "D7",
    section: "action",
    fingerprint: `D7:${b.blankVariantId}`,
    impactCents: b.forDesign ? Math.max(0, Math.round(perUnit * b.designUnits)) : null,
    confidence: b.forDesign ? 0.9 : 0.5,
    templateKey: "D7 action",
    action: action("reorder_blank", "/inventory/stock?low=true", {
      blankVariantId: b.blankVariantId,
      blankName: b.name,
      ...(b.forDesign
        ? { designId: b.forDesign.designId, designName: b.forDesign.name ?? "" }
        : {}),
    }),
    facts: [
      fact(`d7.${b.blankVariantId}.available`, "count", b.available),
      fact(`d7.${b.blankVariantId}.reorderPoint`, "count", b.reorderPoint),
    ],
  }));
}

/** D8 wins: best net week in N weeks; record on-time rate. */
export function d8Wins(s: Snapshot): Candidate[] {
  const out: Candidate[] = [];
  const history = s.trailingNet.slice(0, C.trailingWeeks);
  if (
    s.current.net > 0 &&
    history.length >= C.d8.bestNetWeeks &&
    history.every((n) => s.current.net > n)
  ) {
    out.push({
      detector: "D8",
      section: "win",
      fingerprint: "D8:bestNet",
      impactCents: s.current.net,
      confidence: 0.9,
      templateKey: "D8 win",
      action: action("none", "/analytics/profit?dim=day&days=7"),
      facts: [
        fact("d8.net", "cents", s.current.net),
        fact("d8.weeks", "count", history.length + 1),
      ],
    });
  }
  const f = s.fulfillment;
  if (
    f.onTimeRate !== null &&
    f.shipped >= C.d8.onTimeRecordMinShipped &&
    f.bestTrailingOnTimeRate !== null &&
    f.onTimeRate > f.bestTrailingOnTimeRate
  ) {
    out.push({
      detector: "D8",
      section: "win",
      fingerprint: "D8:onTime",
      impactCents: null,
      confidence: 0.9,
      templateKey: "D8 win",
      action: action("none", "/orders?view=all"),
      facts: [fact("d8.onTimeRate", "ratio", f.onTimeRate)],
    });
  }
  return out;
}

/*
 * Track E detectors (T-A9, spec business-analytics-v2 AC-E1..E1e). Inputs come from the
 * `analytics.*` services through `snapshot.trackE`; without it none of them fires.
 */

const PROFIT_VIEW = "/analytics/profit";
const INVENTORY_VIEW = "/analytics/inventory";

/** D9: shipping loss per labeled order ≥ $0.50 worse than the channel's 4-week median. */
export function d9ShippingLoss(s: Snapshot): Candidate[] {
  const out: Candidate[] = [];
  for (const c of s.trackE?.shipping ?? []) {
    if (c.labeledOrders < C.d9.minLabeledOrders || c.marginPerOrder === null) continue;
    if (c.trailing.length < C.d9.trailingWeeks) continue;
    const base = median(c.trailing.slice(0, C.d9.trailingWeeks));
    if (base === null) continue;
    const worse = Math.round(base - c.marginPerOrder);
    // A loss (margin below 0) that got worse; a smaller profit is not a shipping loss.
    if (c.marginPerOrder >= 0 || worse < C.d9.minWorseCents) continue;
    out.push({
      detector: "D9",
      section: "action",
      fingerprint: `D9:${c.channel}`,
      impactCents: worse * c.labeledOrders,
      confidence: 0.8,
      templateKey: "D9 action",
      action: action(
        "review_shipping_prices",
        `${PROFIT_VIEW}?view=shipping&days=28&channel=${enc(c.channel)}`,
        { channel: c.channel, deltaCents: -worse, n: c.labeledOrders },
      ),
      facts: [
        fact(`d9.${c.channel}.marginPerOrder`, "cents", c.marginPerOrder),
        fact(`d9.${c.channel}.medianMarginPerOrder`, "cents", Math.round(base)),
        fact(`d9.${c.channel}.labeledOrders`, "count", c.labeledOrders),
      ],
    });
  }
  return out;
}

/** D10: losing orders above 5% of orders, with ≥ 30 orders. */
export function d10LosingOrders(s: Snapshot): Candidate[] {
  const l = s.trackE?.losing;
  if (!l || l.ordersWithProfitLine < C.d10.minOrders || l.losingPct === null) return [];
  if (l.losingPct <= C.d10.minLosingPct) return [];
  return [
    {
      detector: "D10",
      section: "action",
      fingerprint: "D10:losing",
      impactCents: Math.abs(l.lossCents),
      confidence: 0.8,
      templateKey: "D10 action",
      action: action("review_losing_orders", `${PROFIT_VIEW}?view=losing&days=7`, {
        n: l.losingOrders,
        points: l.losingPct,
      }),
      facts: [
        fact("d10.losingOrders", "count", l.losingOrders),
        fact("d10.orders", "count", l.ordersWithProfitLine),
        fact("d10.losingPct", "pct", l.losingPct),
        fact("d10.loss", "cents", l.lossCents),
      ],
    },
  ];
}

/**
 * D11: dead stock above 15% of stock value (one action naming the largest dead style × color),
 * and each size at or below −15 points of its sales share with under 14 days of cover.
 */
export function d11StockHealth(s: Snapshot): Candidate[] {
  const inv = s.trackE?.inventory;
  if (!inv) return [];
  const out: Candidate[] = [];
  if (
    inv.deadPctOfStockValue !== null &&
    inv.deadPctOfStockValue > C.d11.maxDeadPct &&
    inv.topDead
  ) {
    const d = inv.topDead;
    out.push({
      detector: "D11",
      section: "action",
      fingerprint: `D11:dead:${d.blankVariantId}`,
      impactCents: inv.deadValue,
      confidence: 0.6,
      templateKey: "D11 action.dead",
      action: action("review_dead_stock", INVENTORY_VIEW, {
        style: d.style,
        color: d.color,
        blankVariantId: d.blankVariantId,
        points: inv.deadPctOfStockValue,
      }),
      facts: [
        fact("d11.deadPct", "pct", inv.deadPctOfStockValue),
        fact("d11.deadValue", "cents", inv.deadValue),
        fact("d11.deadVariants", "count", inv.deadVariants),
      ],
    });
  }
  const perUnit = s.current.units > 0 ? s.current.net / s.current.units : 0;
  const gaps = inv.gaps
    .filter((g) => g.gapPts <= C.d11.maxGapPts && g.coverDays < C.d11.maxCoverDays)
    .sort((a, b) => a.gapPts - b.gapPts || a.style.localeCompare(b.style))
    .slice(0, C.d11.maxGaps);
  for (const [i, g] of gaps.entries()) {
    // Units short over the next 14 days at the window's sales rate, at this week's net per unit.
    const daily = g.unitsSold / inv.days;
    const short = Math.max(0, daily * C.d11.maxCoverDays - g.onHand);
    const id = `${g.style}:${g.color}:${g.size}`;
    out.push({
      detector: "D11",
      section: "action",
      fingerprint: `D11:gap:${id}`.slice(0, 128),
      impactCents: Math.max(0, Math.round(short * perUnit)),
      confidence: 0.7,
      templateKey: "D11 action.gap",
      action: action("restock_size_gap", INVENTORY_VIEW, {
        style: g.style,
        color: g.color,
        size: g.size,
        points: g.gapPts,
      }),
      facts: [
        fact(`d11.gap${i}.gapPts`, "pct", g.gapPts),
        fact(`d11.gap${i}.coverDays`, "count", Math.round(g.coverDays * 10) / 10),
      ],
    });
  }
  return out;
}

/** D12: a supplier's unit cost for a style ≥ 5% above its cost 3 months earlier. */
export function d12BlankCost(s: Snapshot): Candidate[] {
  const out: Candidate[] = [];
  for (const [i, r] of (s.trackE?.supplierCosts ?? []).entries()) {
    const rise = pctChange(r.unitCost, r.baseUnitCost);
    if (rise === null || rise < C.d12.minRisePct) continue;
    const delta = Math.round(r.unitCost - r.baseUnitCost);
    const id = `${r.supplierName}:${r.style}`;
    out.push({
      detector: "D12",
      section: "action",
      fingerprint: `D12:${id}`.slice(0, 128),
      // Margin impact: the rise on the units bought in the latest month.
      impactCents: Math.max(0, Math.round((r.unitCost - r.baseUnitCost) * r.units)),
      confidence: 0.7,
      templateKey: "D12 action",
      action: action("review_blank_cost", INVENTORY_VIEW, {
        supplierName: r.supplierName,
        style: r.style,
        points: Math.round(rise * 10) / 10,
        deltaCents: delta,
      }),
      facts: [
        fact(`d12.${i}.unitCost`, "cents", Math.round(r.unitCost)),
        fact(`d12.${i}.baseUnitCost`, "cents", Math.round(r.baseUnitCost)),
        fact(`d12.${i}.risePct`, "pct", Math.round(rise * 10) / 10),
      ],
    });
  }
  return out;
}

/** D13: fixed costs set, ≥ 30 orders in 4 weeks, and the monthly pace is below break-even. */
export function d13BreakEven(s: Snapshot): Candidate[] {
  const b = s.trackE?.breakEven;
  if (!b?.fixedCostsSet || !b.hasEnoughOrders || b.operatingProfitPace === null) return [];
  if (b.operatingProfitPace >= 0) return [];
  // The monthly shortfall, scaled to one week so it ranks against weekly impacts.
  const weekly = Math.round((-b.operatingProfitPace * 7) / 30);
  return [
    {
      detector: "D13",
      section: "action",
      fingerprint: "D13:breakEven",
      impactCents: weekly,
      confidence: 0.7,
      templateKey: "D13 action",
      action: action("see_break_even", `${PROFIT_VIEW}?view=breakeven`, {
        deltaCents: b.operatingProfitPace,
        ...(b.breakEvenOrders !== null ? { n: b.breakEvenOrders } : {}),
      }),
      facts: [
        fact("d13.operatingProfitPace", "cents", b.operatingProfitPace),
        fact("d13.pace", "count", b.pace),
        fact("d13.breakEvenOrders", "count", b.breakEvenOrders),
      ],
    },
  ];
}

/** Most of the week's orders have no final fees yet: money-based findings would be wrong. */
export function profitUnreliable(s: Snapshot): boolean {
  const all = s.current.orders + s.incompleteOrders;
  return all > 0 && s.incompleteOrders / all > C.maxIncompleteShare;
}

/** Every detector, in spec order (D10 and D13 read profit lines: silent when fees are unreliable). */
export function detect(s: Snapshot): Candidate[] {
  const unreliable = profitUnreliable(s);
  const money = (cs: Candidate[]) => (unreliable ? [] : cs);
  return [
    ...d1DataHealth(s),
    ...money(d2Change(s)),
    ...money(d3MarginSlip(s)),
    ...money(d4Ads(s)),
    ...d5Designs(s).filter((c) => !unreliable || c.action.kind === "list_design"),
    ...d6Fulfillment(s),
    ...d7Stock(s),
    ...d8Wins(s).filter((c) => !unreliable || c.fingerprint !== "D8:bestNet"),
    ...d9ShippingLoss(s),
    ...money(d10LosingOrders(s)),
    ...d11StockHealth(s),
    ...d12BlankCost(s),
    ...money(d13BreakEven(s)),
  ];
}
