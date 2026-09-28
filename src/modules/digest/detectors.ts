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
    out.push({
      detector: "D2",
      section: "action",
      fingerprint: `D2:${metric}:${cur >= prev ? "up" : "down"}`,
      impactCents: absPrev,
      confidence: s.incompleteOrders > 0 ? 0.6 : 0.8,
      templateKey: "D2 action",
      action: action("see_what_changed", "/analytics/profit?dim=channel&days=7", {
        ...(top ? { channel: top.channel } : {}),
      }),
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

/** Most of the week's orders have no final fees yet: money-based findings would be wrong. */
export function profitUnreliable(s: Snapshot): boolean {
  const all = s.current.orders + s.incompleteOrders;
  return all > 0 && s.incompleteOrders / all > C.maxIncompleteShare;
}

/** Every detector, in spec order. */
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
  ];
}
