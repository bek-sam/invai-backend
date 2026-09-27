import type { SignalSource } from "@invai/contracts";
import { env } from "../../env";
import { isSampleWorkspace } from "../tenancy/demo-flag";

/**
 * Every market threshold in one object (spec "The algorithm, made concrete": the PM tunes these
 * without a code search). Money in cents, ratios 0..1, percents as `*Pct` numbers.
 */
export const MARKET_CONFIG = {
  history: { weeks: 156 },
  trend: {
    windowWeeks: 26,
    youngWindowWeeks: 13,
    minPoints: 13,
    /** Zero in more than this share of the window's weeks → insufficient. */
    maxZeroShare: 0.5,
    risingG4: 0.15,
    fallingG4: -0.15,
    tMin: 1.7,
  },
  yoy: { minWeeks: 56, windowWeeks: 4, minOwnDenominator: 10 },
  seasonality: {
    peakIndex: 1.3,
    offIndex: 0.8,
    minYears: 2,
    ownMinUnitsPerYear: 100,
    listingRampWeeks: 3,
    defaultLeadHours: 48,
    actNowWeeks: 2,
    peakHorizonWeeks: 10,
  },
  price: {
    minComparables: 8,
    landedMinCents: 500,
    landedMaxCents: 8000,
    lowPercentile: 0.25,
    premiumPercentile: 0.75,
    rawDays: 90,
  },
  margin: {
    periodDays: 90,
    floorMarginPct: 15,
    gridCents: 5,
    maxCandidates: 20,
    maxRequested: 8,
    elasticityMinUnits: 30,
    elasticityMin: -4,
  },
  confidence: {
    high: 0.7,
    medium: 0.4,
    /** Sample-size targets (s = min(1, n / target)). */
    target: { trend: 26, seasonalityYears: 3, comparables: 20, ownUnits: 30, elasticityUnits: 60 },
    agreement: { agree: 1, single: 0.7, disagree: 0.4 },
    mapperMin: 0.7,
  },
  rules: {
    r1PeakWeeks: 10,
    r2MarginBelowPct: 25,
    r2TestMin: 1.05,
    r2TestMax: 1.1,
    r3MarginBelowPct: 15,
    r4MaxDesignsInNiche: 2,
    r5MarginBelowPct: 15,
    maxPerRun: 200,
    /** A recommendation for the same rule and target is not re-created within this many days. */
    reissueAfterDays: 28,
  },
  feedback: {
    priceMovePct: 3,
    priceWindowDays: 14,
    listingWindowDays: 21,
    nicheDesignWindowDays: 30,
    outcomeAfterDays: 28,
    outcomeMinUnits: 10,
    baselineDays: 28,
  },
  retention: { recommendationsDays: 400, cacheYears: 5, rollupYears: 3 },
  /** Freshness half-life, TTL (stale at 2× TTL) and reliability per source (spec step 4, ADR 0015). */
  sources: {
    own: { halfLifeDays: 7, ttlDays: 7, reliability: 1 },
    census: { halfLifeDays: 60, ttlDays: 30, reliability: 0.6 },
    google_trends: { halfLifeDays: 14, ttlDays: 7, reliability: 0.8 },
    pinterest_trends: { halfLifeDays: 14, ttlDays: 7, reliability: 0.7 },
    amazon_pricing: { halfLifeDays: 1, ttlDays: 1, reliability: 0.9 },
    amazon_brand_analytics: { halfLifeDays: 14, ttlDays: 7, reliability: 0.9 },
    walmart_pricing: { halfLifeDays: 1, ttlDays: 1, reliability: 0.9 },
    jungle_scout: { halfLifeDays: 14, ttlDays: 7, reliability: 0.6 },
  } satisfies Record<SignalSource, { halfLifeDays: number; ttlDays: number; reliability: number }>,
  /** Weekly outside series: 3 years (the seasonality sample target); Census monthly: 10 years. */
  demand: { years: 3, censusYears: 10, refreshAfterDays: 7, censusRefreshAfterDays: 30 },
  /** Model fallbacks per shop per run (bounds AI cost; the rest wait for the next run). */
  maxClassificationsPerRun: 200,
  /** Rows per tool / list answer (spec "Scale"). */
  maxRows: 20,
} as const;

/** Outside demand sources in reliability order (the first with enough data wins for seasonality). */
export const OUTSIDE_DEMAND_SOURCES = [
  "google_trends",
  "pinterest_trends",
  "jungle_scout",
] as const;

/**
 * The one mock visibility predicate (wave 18 hard fence, spec AC29, ADR 0015 item 7): mock market
 * sources are used and shown only outside production, when `ALLOW_MOCKS` is set, or in a sample
 * workspace. Otherwise a mock source counts as no source.
 */
export async function mockSourcesAllowed(
  companyId: string,
  e: { isProd: boolean; allowMocks: boolean } = env,
): Promise<boolean> {
  if (!e.isProd || e.allowMocks) return true;
  return isSampleWorkspace(companyId);
}
