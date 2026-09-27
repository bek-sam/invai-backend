import type {
  MarketSeasonality,
  MarketTrend,
  SignalProvenance,
  SignalSubject,
  TrendReading,
} from "@invai/contracts";
import type { marketSignals } from "../../db/schema";
import { agreement, band, combine, freshness, isStale } from "./confidence";
import { MARKET_CONFIG, OUTSIDE_DEMAND_SOURCES } from "./config";
import { actBy, leadTimeWeeks, type TrendFit } from "./signals";

/*
 * Stored signal rows → the contract's MarketTrend / MarketSeasonality. Used by the read service
 * (the assistant tools) and by the compute run (the rules), so both see the same numbers.
 * Freshness is applied here, at read time.
 */

export type SignalRow = typeof marketSignals.$inferSelect;

export function provenanceOf(row: SignalRow): SignalProvenance {
  return {
    source: row.source,
    licence: row.licence,
    asOf: row.asOf.toISOString(),
    fetchedAt: row.fetchedAt.toISOString(),
    mock: row.mock,
  };
}

/** Freshness age runs from the data date; Census (a lagged monthly series) from the fetch. */
function ageAnchor(row: SignalRow): Date {
  return row.source === "census" ? row.fetchedAt : row.asOf;
}

export function rowFreshness(row: SignalRow, now: Date): number {
  return freshness(row.source, ageAnchor(row), now);
}

export function rowStale(row: SignalRow, now: Date): boolean {
  return isStale(row.source, ageAnchor(row), now);
}

function computedAt(rows: SignalRow[], now: Date): string {
  const t = rows.reduce<Date | null>((m, r) => {
    const u = r.updatedAt ?? null;
    return u && (!m || u > m) ? u : m;
  }, null);
  return (t ?? now).toISOString();
}

const RANK: Record<string, number> = Object.fromEntries(
  ["own", ...OUTSIDE_DEMAND_SOURCES].map((s, i) => [s, i]),
);

type TrendValue = TrendFit & { yoy?: number | null };

export function buildTrend(input: {
  own: SignalRow | null;
  outside: SignalRow[];
  mapperConfidence: number | null;
  now: Date;
  subject: SignalSubject;
}): MarketTrend {
  const { now } = input;
  const rows = [...(input.own ? [input.own] : []), ...input.outside].sort(
    (a, b) => (RANK[a.source] ?? 9) - (RANK[b.source] ?? 9),
  );
  const readings: TrendReading[] = rows.map((r) => {
    const v = r.value as TrendValue;
    return {
      provenance: provenanceOf(r),
      trend: v.trend,
      growth4w: v.g4 ?? null,
      yoy: v.yoy ?? null,
      n: r.n,
      insufficientReason: v.insufficientReason ?? null,
    };
  });
  const base = {
    subject: input.subject,
    stale: rows.some((r) => rowStale(r, now)),
    mock: rows.some((r) => r.mock),
    sources: rows.map(provenanceOf),
    asOf: computedAt(rows, now),
    readings,
  };
  const idx = readings.findIndex((r) => r.trend !== "insufficient");
  if (idx < 0) {
    const first = rows[0];
    return {
      ...base,
      confidence: 0,
      band: "low",
      trend: "insufficient",
      growth4w: null,
      yoy: null,
      windowWeeks: first
        ? (first.value as TrendValue).windowWeeks
        : MARKET_CONFIG.trend.windowWeeks,
      disagreement: false,
      insufficientReason: readings[0]?.insufficientReason ?? "no_source",
    };
  }
  const primary = rows[idx] as SignalRow;
  const reading = readings[idx] as TrendReading;
  const { a, disagreement } = agreement(readings.map((r) => r.trend));
  const r =
    primary.source === "own" || input.mapperConfidence === null
      ? primary.reliability
      : primary.reliability * input.mapperConfidence;
  // The combined reading is only as fresh as the evidence it rests on: an outside source that
  // stopped refreshing (outage) lowers the confidence even when own data leads (spec AC20).
  const f = Math.min(
    ...rows
      .filter((_, i) => readings[i]?.trend !== "insufficient")
      .map((x) => rowFreshness(x, now)),
  );
  const confidence = combine({ s: primary.sampleFactor, f, r, a });
  return {
    ...base,
    confidence,
    band: band(confidence),
    trend: reading.trend,
    growth4w: reading.growth4w,
    yoy: reading.yoy,
    windowWeeks: (primary.value as TrendValue).windowWeeks,
    disagreement,
    insufficientReason: null,
  };
}

type SeasonValue = {
  index: { month: number; index: number }[];
  peakMonths: number[];
  offMonths: number[];
  yearsUsed: number;
};

export type SeasonResult = MarketSeasonality & { seasonRow: SignalRow | null };

/** Source priority: own (design, then niche) → outside demand for the niche → Census prior. */
export function buildSeason(input: {
  designOwn: SignalRow | null;
  nicheRows: SignalRow[];
  census: SignalRow | null;
  lead: SignalRow | null;
  mapperConfidence: number | null;
  now: Date;
  timeZone: string;
  subject: SignalSubject;
}): SeasonResult {
  const { now } = input;
  const nicheOwn = input.nicheRows.find((r) => r.source === "own") ?? null;
  const outside = OUTSIDE_DEMAND_SOURCES.map((s) =>
    input.nicheRows.find((r) => r.source === s),
  ).find((r): r is SignalRow => !!r);
  const pick: [SignalRow, "own" | "outside" | "census_prior"] | null = input.designOwn
    ? [input.designOwn, "own"]
    : nicheOwn
      ? [nicheOwn, "own"]
      : outside
        ? [outside, "outside"]
        : input.census
          ? [input.census, "census_prior"]
          : null;
  if (!pick) {
    return {
      subject: input.subject,
      confidence: 0,
      band: "low",
      stale: false,
      mock: false,
      sources: [],
      asOf: now.toISOString(),
      index: [],
      peakMonths: [],
      offMonths: [],
      indexSource: null,
      actBy: null,
      yearsUsed: 0,
      seasonRow: null,
    };
  }
  const [row, indexSource] = pick;
  const v = row.value as SeasonValue;
  const lead =
    (input.lead?.value as { leadTimeWeeks?: number } | undefined)?.leadTimeWeeks ??
    leadTimeWeeks(null);
  const r =
    indexSource === "outside" && input.mapperConfidence !== null
      ? row.reliability * input.mapperConfidence
      : row.reliability;
  const confidence = combine({ s: row.sampleFactor, f: rowFreshness(row, now), r, a: 1 });
  const rows = input.lead ? [row, input.lead] : [row];
  return {
    subject: input.subject,
    confidence,
    band: band(confidence),
    stale: rowStale(row, now),
    mock: rows.some((x) => x.mock),
    sources: [provenanceOf(row)],
    asOf: computedAt(rows, now),
    index: v.index,
    peakMonths: v.peakMonths,
    offMonths: v.offMonths,
    indexSource,
    actBy: actBy(now, v.peakMonths, lead, input.timeZone),
    yearsUsed: v.yearsUsed,
    seasonRow: row,
  };
}
