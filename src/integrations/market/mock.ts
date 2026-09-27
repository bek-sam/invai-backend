import { createHash } from "node:crypto";
import type { Channel, Licence, SignalSource } from "@invai/contracts";
import { env } from "../../env";
import { NICHES } from "../../modules/market/niches";
import { MarketProviderError } from "./http";
import { isoWeek, seriesAsOf } from "./period";
import type {
  Comparables,
  DemandProvider,
  DemandSeries,
  PriceObservation,
  PricingProvider,
  SeriesPoint,
} from "./types";

/*
 * Deterministic mock market providers (AC1). Every value is seeded from a sha256 hash of the
 * query/ref: no `Math.random`, no wall clock other than `asOf`/`fetchedAt` (which just record
 * "when the mock ran", the way a real provider's would). Calling `series`/`comparables` twice
 * with the same input, in this process or another one, returns the same numbers, because the
 * hash of the same string is always the same bytes.
 */

function hashBytes(input: string): Buffer {
  return createHash("sha256").update(input).digest();
}

/** A deterministic unsigned integer from a string, `bytes` wide (default 4, i.e. 0..2^32-1). */
function hashInt(input: string, bytes = 4): number {
  const buf = hashBytes(input);
  let n = 0;
  for (let i = 0; i < bytes; i++) n = n * 256 + (buf[i] ?? 0);
  return n;
}

function requestKey(...parts: string[]): string {
  return hashBytes(parts.join("|")).toString("hex").slice(0, 16);
}

/** Throws when `source` is listed in `MARKET_MOCK_FAIL` (AC5; always empty in production). */
function checkMockFail(source: SignalSource) {
  if (env.marketMockFail.has(source)) {
    throw new MarketProviderError(source, `${source} mock is failing (MARKET_MOCK_FAIL)`);
  }
}

/*
 * Round 2b (cross-card finding, wave.md "Cross-card findings routed"): the mock must follow the
 * *real* taxonomy niche's `peakMonths` (`src/modules/market/niches.ts`, read-only here per the
 * round's instruction), not a hash-picked shape -- a Halloween query has to peak in October, not
 * whichever of six fixed curves its hash happened to land on. A query the taxonomy doesn't know
 * about (an ad hoc test string, or a niche with no seasonal prior) instead gets a rising, falling
 * or flat trend, still by hash, so trend/disagreement/stale tests keep both directions.
 */

/** Canonical taxonomy query -> its niche's `peakMonths`, built once from the read-only taxonomy.
 * Only queries whose niche actually has a seasonal prior are in this map (AC1: "flat and
 * declining shapes" still exist, for niches -- and non-taxonomy strings -- with none). */
const QUERY_PEAK_MONTHS: ReadonlyMap<string, readonly number[]> = new Map(
  NICHES.flatMap((n) =>
    n.peakMonths.length > 0 ? n.queries.map((q) => [q, n.peakMonths] as const) : [],
  ),
);

/**
 * Canonical taxonomy query -> its niche's `key`, for every niche (round 2b follow-up, T-18-3/
 * T-18-4 live run finding): `src/modules/market/compute.ts`'s `nicheSeries` computes a niche's
 * outside demand as the **mean of its queries** per source and week. A niche's 3-5 queries
 * hashing to *independent* trend directions would average toward flat almost every time (two
 * rising, two falling cancels out), so an acceptance test walking the first 24 niches looking for
 * one whose mock trend is rising or falling found none. Grouping every non-seasonal niche's
 * queries onto one shared trend direction (and anchor) keeps the niche-level average clean.
 */
const QUERY_NICHE_KEY: ReadonlyMap<string, string> = new Map(
  NICHES.flatMap((n) => n.queries.map((q) => [q, n.key] as const)),
);

/** The key that trend shape/anchor hash on: a taxonomy query's niche (so every query in the same
 * niche moves together), or the query itself for a non-taxonomy string (a test's ad hoc query
 * has no niche to share with, so it keeps its own independent direction). */
function trendGroupKey(query: string): string {
  return QUERY_NICHE_KEY.get(query) ?? query;
}

/** Circular distance in months (0..6) between two calendar months (1-based). */
function monthDistance(a: number, b: number): number {
  const d = Math.abs(a - b);
  return Math.min(d, 12 - d);
}

/** Peak ~2.0x baseline, trough ~0.65x -- the same magnitude the hand-tuned v1 curves used. */
const PEAK_DISTANCE_CURVE = [2.0, 1.5, 1.1, 0.85, 0.75, 0.68, 0.65];

/** An earlier-listed peak month (see below) is real but never the standout: damped so it can
 * never reach the primary peak's own multiplier, even at zero distance. */
const SECONDARY_PEAK_DAMPING = 0.7;

/**
 * Seasonal multiplier for a niche's `peakMonths` (round 2b): the *last* listed month (peakMonths
 * are ascending, spec/taxonomy convention) is the primary peak and always gets the undamped
 * curve -- this is what makes "Halloween -> October" (`peakMonths: [9, 10]`), "Christmas ->
 * December" (`[11, 12]`), "Mother's Day -> May" (`[4, 5]`) and "back to school -> August" (`[7,
 * 8]`) each land unambiguously on the cross-card finding's own named month, never tied with the
 * ramp-up month before it. Every earlier listed month (`teacher`'s May, alongside its primary
 * August peak) still gets its own, smaller bump from the damped curve, so a niche with two
 * distant peaks (not just a ramp into one) shows both -- just never as high as the primary.
 */
function peakMonthMultiplier(month1: number, peakMonths: readonly number[]): number {
  const curve = (dist: number) =>
    PEAK_DISTANCE_CURVE[Math.min(dist, PEAK_DISTANCE_CURVE.length - 1)] ?? 0.65;
  const primary = peakMonths[peakMonths.length - 1] ?? month1;
  let best = curve(monthDistance(month1, primary));
  for (const pm of peakMonths.slice(0, -1)) {
    const secondary = curve(monthDistance(month1, pm)) * SECONDARY_PEAK_DAMPING;
    if (secondary > best) best = secondary;
  }
  return best;
}

/** Non-seasonal trend buckets (round 2b): a hash-picked direction, not a seasonal curve. */
export const MOCK_TREND_SHAPES = ["rising", "falling", "flat"] as const;
export type MockTrendShape = (typeof MOCK_TREND_SHAPES)[number];

function trendShapeFor(source: SignalSource, groupKey: string): MockTrendShape {
  return (
    MOCK_TREND_SHAPES[hashInt(`${source}:${groupKey}:trend`) % MOCK_TREND_SHAPES.length] ?? "flat"
  );
}

/**
 * Live-run finding (round 2b, second pass): `fitTrend` (`src/modules/market/signals.ts`)
 * deseasonalizes its 26-week OLS window by a `seasonalityIndex` computed from the *whole*
 * requested history (3 years, `MARKET_CONFIG.demand.years`) -- naive month-of-year averaging,
 * with no detrending. A trend confined to one contiguous 26-week (6 calendar month) block reads
 * as "those 6 months are seasonally high", and dividing by that index cancels most of the trend
 * signal right back out (measured: a +20% raw g4 fell to +10% after deseasonalization, below the
 * +15% bound). A shorter window (`TREND_WINDOW`) touches fewer calendar months less severely, and
 * a bigger rate survives the dilution with margin; tuned empirically against the real
 * `seasonalityIndex`/`fitTrend` pipeline (not just this file's own math) until a solid share of
 * non-seasonal niches came back "rising"/"falling" after deseasonalization, not only before it.
 */
const TREND_WINDOW = 16;
/** +13%/period compounds to +65.5%/4 periods; -13%/period to -43.6%/4 periods -- large enough to
 * still clear the spec's +-15%/4-week bounds (research 14; `signals.ts`'s `g4`) after the
 * deseasonalization dilution above, not just before it. */
const TREND_RATE: Record<Exclude<MockTrendShape, "flat">, number> = {
  rising: 0.13,
  falling: -0.13,
};

type Period = { period: string; monthIndex: number };

/** `count` periods ending at `end` (inclusive), oldest first. */
function periodsEnding(granularity: "week" | "month", count: number, end: Date): Period[] {
  const out: Period[] = [];
  if (granularity === "month") {
    const y = end.getUTCFullYear();
    const m = end.getUTCMonth();
    for (let i = count - 1; i >= 0; i--) {
      const d = new Date(Date.UTC(y, m - i, 1));
      out.push({
        period: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`,
        monthIndex: d.getUTCMonth(),
      });
    }
  } else {
    for (let i = count - 1; i >= 0; i--) {
      const d = new Date(end.getTime() - i * 7 * 86_400_000);
      out.push({ period: isoWeek(d), monthIndex: d.getUTCMonth() });
    }
  }
  return out;
}

/**
 * One deterministic demand series for `query` from `source` (AC1). Seasonal when `query` is a
 * real taxonomy query whose niche has `peakMonths` (round 2b); otherwise a hash-picked rising,
 * falling or flat trend, so every direction stays available on mocks.
 */
export function mockDemandSeries(
  source: SignalSource,
  licence: Licence,
  query: string,
  granularity: "week" | "month",
  years: number,
): DemandSeries {
  checkMockFail(source);
  const peakMonths = QUERY_PEAK_MONTHS.get(query);
  const base = 20 + (hashInt(`${source}:${query}:base`) % 60);
  const count = Math.max(1, Math.round(years * (granularity === "month" ? 12 : 52)));
  const periods = periodsEnding(granularity, count, new Date());

  let points: SeriesPoint[];
  if (peakMonths && peakMonths.length > 0) {
    // Kept low (30..49, not the general 20..79) so a 2.0x primary peak (max ~98) never clips at
    // the 0..100 ceiling and swallows its distinction from a 1.4x secondary/ramp month (round 2b:
    // the peak month must be the taxonomy's own peak, visibly higher than any other month, not
    // tied with it at the clamp).
    const seasonalBase = 30 + (hashInt(`${source}:${query}:base`) % 20);
    points = periods.map((p) => {
      const mult = peakMonthMultiplier(p.monthIndex + 1, peakMonths);
      const noise = (hashInt(`${source}:${query}:${p.period}`) % 11) - 5;
      const value = Math.max(0, Math.min(100, Math.round(seasonalBase * mult + noise)));
      return { period: p.period, value };
    });
  } else {
    // Grouped by niche, not by query (see `trendGroupKey`): `nicheSeries` in
    // `src/modules/market/compute.ts` averages a niche's queries per week, so every query in the
    // same non-seasonal niche must share one direction and anchor or the average cancels to flat.
    const groupKey = trendGroupKey(query);
    const shape = trendShapeFor(source, groupKey);
    const windowLen = Math.min(TREND_WINDOW, periods.length);
    // rising starts near 0 and falling starts near 100, so the whole (short) window can move at
    // the tuned rate above without saturating at the 0..100 clamp partway through.
    const anchor =
      shape === "rising"
        ? 1 + (hashInt(`${source}:${groupKey}:anchor`) % 5) // 1..5
        : shape === "falling"
          ? 95 + (hashInt(`${source}:${groupKey}:anchor`) % 5) // 95..99
          : base;
    points = periods.map((p, i) => {
      const noise = (hashInt(`${source}:${query}:${p.period}`) % 11) - 5;
      const distFromEnd = periods.length - 1 - i;
      const raw =
        shape === "flat" || distFromEnd >= windowLen
          ? anchor + noise
          : anchor * (1 + TREND_RATE[shape]) ** (windowLen - 1 - distFromEnd) + noise;
      return { period: p.period, value: Math.max(0, Math.min(100, Math.round(raw))) };
    });
  }

  const now = new Date().toISOString();
  return {
    source,
    licence,
    query,
    geo: "US",
    granularity,
    scale: "relative_0_100",
    points,
    asOf: seriesAsOf(points, granularity, now),
    fetchedAt: now,
    requestKey: requestKey(source, query, granularity, String(years)),
    mock: true,
  };
}

/** A `DemandProvider` whose `series()` always returns `mockDemandSeries` for each query. */
export function mockDemandProvider(source: SignalSource, licence: Licence): DemandProvider {
  return {
    source,
    mock: true,
    async series({ queries, granularity, years }) {
      return queries.map((query) => mockDemandSeries(source, licence, query, granularity, years));
    },
  };
}

/**
 * A raw competitor offer, the shape a real Amazon/Walmart pricing response would carry (seller
 * name, listing title, a listing URL). `mockComparablesFor` builds these and then drops every
 * identifying field before returning `Comparables` (AC7): this type never leaves this file.
 */
type MockRawOffer = {
  sellerName: string;
  listingTitle: string;
  url: string;
  priceCents: number;
  isFeatured: boolean;
  personalized: boolean;
  garmentClass: string;
};

/** Spec Step 1.1's garment classes (round 2, QA finding: comparables must carry one). */
const GARMENT_CLASSES = ["tee", "hoodie", "sweatshirt", "tank", "kids", "other"] as const;

/** A garment class that is never `own`, so the "other" group is a genuine mismatch, not luck. */
function differentGarmentClass(own: string): string {
  const idx = GARMENT_CLASSES.indexOf(own as (typeof GARMENT_CLASSES)[number]);
  return GARMENT_CLASSES[(idx < 0 ? 0 : idx) + 1] ?? GARMENT_CLASSES[0];
}

/**
 * QA finding (wave.md "QA findings routed" 1): whether `ownRef` gets the "normal" comparable
 * count (spec minimum n = 8; the mock targets 10-24 after `filterComparables`'s personalization
 * match) or a deliberately thin one (< 8, so "too few comparables" stays testable).
 *
 * Only one thing makes a ref thin: it ends in the reserved suffix `"-THIN-TEST"`
 * (case-sensitive). Every other ref -- including a random design UUID, which is what every real
 * shop and every other test in this codebase passes as `ref` -- always gets the normal count.
 * An earlier draft also made ~1 ref in 10 thin by hash, so "too few comparables" would show up
 * unasked; that made recommendation generation flaky for *any* new design (about 1 in 10 designs
 * would randomly lose its R2 with no visible cause), which is worse than the problem it solved.
 * A caller that wants the thin case asks for it, with this suffix.
 */
export const THIN_TEST_SUFFIX = "-THIN-TEST";
function isThinRegime(_source: SignalSource, ownRef: string): boolean {
  return ownRef.endsWith(THIN_TEST_SUFFIX);
}

/**
 * Raw competitor offers for `ownRef`. Two groups (QA finding 2, AC19): offers whose `personalized`
 * *and* `garmentClass` match the shop's own values -- the group `filterComparables`
 * (`src/modules/market/signals.ts`) keeps -- sized per `isThinRegime`, and a second group with the
 * opposite personalized flag *and* a different garment class that's always filtered out (proof
 * that the mix, not luck, is why filtering does something). Prices sit in a tight $2 band around
 * a per-ref base, all inside the spec's $5-$80 comparable window, so the IQR outlier trim never
 * removes a matching offer: the final count is the matching group's size, exactly.
 */
function mockRawOffers(
  source: SignalSource,
  ownRef: string,
  keywords: string[],
  personalized: boolean,
  garmentClass: string,
): MockRawOffer[] {
  const thin = isThinRegime(source, ownRef);
  const matchCount = thin
    ? 2 + (hashInt(`${source}:${ownRef}:thin_n`) % 4) // 2..5 (< 8)
    : 10 + (hashInt(`${source}:${ownRef}:normal_n`) % 15); // 10..24
  const otherCount = 3 + (hashInt(`${source}:${ownRef}:other_n`) % 6); // 3..8, always dropped
  const baseCents = 1200 + (hashInt(`${source}:${ownRef}:price`) % 2000); // $12.00..$32.00
  const keyword = keywords[0] ?? ownRef;
  const otherClass = differentGarmentClass(garmentClass);
  const offer = (i: number, matches: boolean): MockRawOffer => {
    const seed = `${source}:${ownRef}:${matches ? "m" : "o"}:${i}`;
    const deltaCents = (hashInt(`${seed}:delta`) % 401) - 200; // +/- $2.00: tight, so IQR keeps every match
    return {
      sellerName: `Sample Seller ${hashInt(`${seed}:seller`) % 9999}`,
      listingTitle: `${keyword} - sample competitor listing ${i + 1}`,
      url: `https://sample-marketplace.test/listing/${hashInt(seed)}`,
      priceCents: Math.max(100, baseCents + deltaCents),
      isFeatured: matches && i === 0,
      personalized: matches ? personalized : !personalized,
      garmentClass: matches ? garmentClass : otherClass,
    };
  };
  const matches = Array.from({ length: matchCount }, (_, i) => offer(i, true));
  const others = Array.from({ length: otherCount }, (_, i) => offer(i, false));
  return [...matches, ...others];
}

function mockComparablesFor(
  source: SignalSource,
  licence: Licence,
  channel: Channel,
  ownRef: string,
  keywords: string[],
  personalized: boolean,
  garmentClass: string,
): Comparables {
  checkMockFail(source);
  const offers = mockRawOffers(source, ownRef, keywords, personalized, garmentClass);
  const observations: PriceObservation[] = offers.map((o) => ({
    landedPriceCents: o.priceCents,
    isFeatured: o.isFeatured,
    offerCount: offers.length,
    personalized: o.personalized,
    garmentClass: o.garmentClass,
  }));
  const now = new Date().toISOString();
  return {
    source,
    licence,
    channel,
    ownRef,
    observations,
    asOf: now,
    fetchedAt: now,
    requestKey: requestKey(source, channel, ownRef),
    mock: true,
  };
}

/** A `PricingProvider` whose `comparables()` returns deterministic, identity-free comparables. */
export function mockPricingProvider(
  source: SignalSource,
  licence: Licence,
  channel: Channel,
): PricingProvider {
  return {
    source,
    mock: true,
    async comparables(_conn, own) {
      return own.map((o) =>
        mockComparablesFor(
          source,
          licence,
          channel,
          o.ref,
          o.keywords,
          o.personalized,
          o.garmentClass,
        ),
      );
    },
  };
}
