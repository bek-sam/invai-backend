import type {
  Channel,
  ConfidenceBand,
  MarketAction,
  MarketRule,
  RecommendationParams,
} from "@invai/contracts";
import type { RecSource } from "../../db/schema";
import { bandAtLeast } from "./confidence";
import { MARKET_CONFIG } from "./config";
import type { ActBy } from "./signals";

/*
 * The five recommendation rules (spec step 5), pure. Each fires only on signals of band medium or
 * better (R5: high), produces one fixed action with fixed params (no free text except the
 * trademark-screened R4 ideas the caller passes in), and carries the evidence it rests on.
 */

export type Scored = {
  confidence: number;
  band: ConfidenceBand;
  sources: RecSource[];
  signalIds: string[];
};

export type ChannelFacts = {
  channel: Channel;
  currentPriceCents: number | null;
  margin: (Scored & { marginPct: number; floorPriceCents: number | null }) | null;
  price:
    | (Scored & {
        priceBand: "low" | "market" | "premium";
        n: number;
        medianCents: number;
      })
    | null;
};

export type DesignFacts = {
  designId: string;
  designName: string;
  /** Connected channels (API or CSV) and the channels the design is already listed or sold on. */
  connectedChannels: Channel[];
  listedChannels: Channel[];
  blank: { id: string; name: string; belowReorderPoint: boolean } | null;
  season:
    | (Scored & {
        peakMonths: number[];
        offMonths: number[];
        actBy: ActBy | null;
        expectedUnits: number | null;
      })
    | null;
  ownTrend: (Scored & { trend: "rising" | "falling" | "flat" | "insufficient" }) | null;
  channels: ChannelFacts[];
  /** Shop-local calendar month now, 1..12. */
  currentMonth: number;
  /** Shop-local date now (YYYY-MM-DD): R1 never emits an act-by date before it (wave 20). */
  today: string;
  /** The design's own primary niche key, for R1's "peak under way" copy (`params.niche`). */
  niche: string | null;
};

export type NicheFacts = {
  niche: string;
  outsideTrend: (Scored & { trend: "rising" | "falling" | "flat" | "insufficient" }) | null;
  designsInNiche: number;
  /** 1–2 ideas, already through the trademark screen. */
  ideas: string[];
};

export type RecommendationDraft = {
  rule: MarketRule;
  action: MarketAction;
  dedupeKey: string;
  designId: string | null;
  niche: string | null;
  channel: Channel | null;
  params: RecommendationParams;
  confidence: number;
  band: ConfidenceBand;
  mock: boolean;
  sources: RecSource[];
  evidenceSignalIds: string[];
};

function merge(...parts: Scored[]): { sources: RecSource[]; signalIds: string[]; mock: boolean } {
  const seen = new Set<string>();
  const sources: RecSource[] = [];
  for (const p of parts) {
    for (const s of p.sources) {
      const k = `${s.source}|${s.asOf}`;
      if (seen.has(k)) continue;
      seen.add(k);
      sources.push(s);
    }
  }
  return {
    sources,
    signalIds: [...new Set(parts.flatMap((p) => p.signalIds))],
    mock: sources.some((s) => s.mock),
  };
}

function weakest(...parts: Scored[]): { confidence: number; band: ConfidenceBand } {
  const w = parts.reduce((m, p) => (p.confidence < m.confidence ? p : m));
  return { confidence: w.confidence, band: w.band };
}

const R = MARKET_CONFIG.rules;

/**
 * R1 timing on read (wave 20): an R1 item is past its peak on `refYmd` (shop-local today, or the
 * digest week's end) when its act-by date is before it, or, for a "peak under way" item (no
 * act-by date), when `refYmd` is no longer in the peak month. Other rules are never past peak.
 */
export function r1PastPeak(
  r: { rule: MarketRule; params: Pick<RecommendationParams, "actByDate" | "peakMonth"> },
  refYmd: string,
): boolean {
  if (r.rule !== "R1") return false;
  if (r.params.actByDate) return r.params.actByDate < refYmd;
  return r.params.peakMonth !== undefined && r.params.peakMonth !== Number(refYmd.slice(5, 7));
}

export function designRules(f: DesignFacts): RecommendationDraft[] {
  const out: RecommendationDraft[] = [];

  // R1 seasonal prep: a peak ≤ 10 weeks away with seasonality at medium or better. Timing
  // (wave 20, market-signals.md "R1 timing"): while today is inside the peak month the peak is
  // under way (no act-by date, "season is on now" copy); otherwise an act-by date already
  // before today means the design missed that peak, and R1 stays silent.
  const s = f.season;
  const underWay = s?.actBy?.peakMonth === f.currentMonth;
  if (
    s?.actBy &&
    s.actBy.weeksToPeak <= R.r1PeakWeeks &&
    bandAtLeast(s.band, "medium") &&
    (underWay || s.actBy.date >= f.today)
  ) {
    const listed = new Set(f.listedChannels);
    const m = merge(s);
    out.push({
      rule: "R1",
      action: "list_and_stock",
      dedupeKey: `R1:${f.designId}`,
      designId: f.designId,
      niche: null,
      channel: null,
      params: {
        designName: f.designName,
        channels: f.connectedChannels.filter((c) => !listed.has(c)),
        ...(f.blank
          ? {
              blankVariantId: f.blank.id,
              blankName: f.blank.name,
              blankBelowReorderPoint: f.blank.belowReorderPoint,
            }
          : {}),
        peakMonth: s.actBy.peakMonth,
        ...(underWay ? {} : { actByDate: s.actBy.date }),
        ...(f.niche ? { niche: f.niche } : {}),
        expectedUnits: s.expectedUnits,
      },
      confidence: s.confidence,
      band: s.band,
      mock: m.mock,
      sources: m.sources,
      evidenceSignalIds: m.signalIds,
    });
  }

  for (const ch of f.channels) {
    const margin = ch.margin;
    const price = ch.price;
    // R2 price test up: low band among ≥ 8 comparables, margin < 25%, trend not falling.
    if (
      margin &&
      price &&
      ch.currentPriceCents !== null &&
      price.priceBand === "low" &&
      price.n >= MARKET_CONFIG.price.minComparables &&
      margin.marginPct < R.r2MarginBelowPct &&
      f.ownTrend?.trend !== "falling" &&
      bandAtLeast(price.band, "medium") &&
      bandAtLeast(margin.band, "medium")
    ) {
      const p0 = ch.currentPriceCents;
      const min = Math.ceil(p0 * R.r2TestMin);
      const max = Math.min(Math.round(p0 * R.r2TestMax), price.medianCents);
      if (min <= max) {
        const m = merge(price, margin);
        out.push({
          rule: "R2",
          action: "price_test_up",
          dedupeKey: `R2:${f.designId}:${ch.channel}`,
          designId: f.designId,
          niche: null,
          channel: ch.channel,
          params: {
            designName: f.designName,
            channel: ch.channel,
            currentPriceCents: p0,
            testPriceMinCents: min,
            testPriceMaxCents: max,
            comparableMedianCents: price.medianCents,
            marginPct: margin.marginPct,
          },
          ...weakest(price, margin),
          mock: m.mock,
          sources: m.sources,
          evidenceSignalIds: m.signalIds,
        });
      }
    }
    // R3 price floor breach: margin at p0 < 15% (own data only; always allowed).
    if (margin && margin.marginPct < R.r3MarginBelowPct && bandAtLeast(margin.band, "medium")) {
      const m = merge(margin);
      out.push({
        rule: "R3",
        action: "raise_to_floor_or_stop_ads",
        dedupeKey: `R3:${f.designId}:${ch.channel}`,
        designId: f.designId,
        niche: null,
        channel: ch.channel,
        params: {
          designName: f.designName,
          channel: ch.channel,
          ...(ch.currentPriceCents !== null ? { currentPriceCents: ch.currentPriceCents } : {}),
          ...(margin.floorPriceCents !== null ? { floorPriceCents: margin.floorPriceCents } : {}),
          marginPct: margin.marginPct,
        },
        confidence: margin.confidence,
        band: margin.band,
        mock: m.mock,
        sources: m.sources,
        evidenceSignalIds: m.signalIds,
      });
    }
  }

  // R5 drop or rest: own trend falling at high confidence, off-season, margin < 15%.
  const t = f.ownTrend;
  const thin = f.channels
    .filter((c) => c.margin && c.margin.marginPct < R.r5MarginBelowPct)
    .sort((a, b) => (a.margin?.marginPct ?? 0) - (b.margin?.marginPct ?? 0))[0];
  if (
    t?.trend === "falling" &&
    t.band === "high" &&
    s?.offMonths.includes(f.currentMonth) &&
    thin?.margin
  ) {
    const m = merge(t, s, thin.margin);
    out.push({
      rule: "R5",
      action: "pause_ads_and_deprioritize",
      dedupeKey: `R5:${f.designId}`,
      designId: f.designId,
      niche: null,
      channel: thin.channel,
      params: { designName: f.designName, channel: thin.channel, marginPct: thin.margin.marginPct },
      ...weakest(t, thin.margin),
      mock: m.mock,
      sources: m.sources,
      evidenceSignalIds: m.signalIds,
    });
  }
  return out;
}

/** R4 ride a rising niche: outside trend rising at medium or better, the shop has 1–2 designs in it. */
export function nicheRules(n: NicheFacts): RecommendationDraft[] {
  const t = n.outsideTrend;
  if (
    t?.trend !== "rising" ||
    !bandAtLeast(t.band, "medium") ||
    n.designsInNiche < 1 ||
    n.designsInNiche > R.r4MaxDesignsInNiche ||
    !n.ideas.length
  )
    return [];
  const m = merge(t);
  return [
    {
      rule: "R4",
      action: "new_designs_in_niche",
      dedupeKey: `R4:niche:${n.niche}`,
      designId: null,
      niche: n.niche,
      channel: null,
      params: { niche: n.niche, ideas: n.ideas.slice(0, 2) },
      confidence: t.confidence,
      band: t.band,
      mock: m.mock,
      sources: m.sources,
      evidenceSignalIds: m.signalIds,
    },
  ];
}
