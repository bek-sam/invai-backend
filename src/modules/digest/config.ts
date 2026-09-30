import { z } from "zod";

/*
 * Every digest threshold in one object (spec pipeline 5–7, 9; open question 4: the PM confirms
 * the numbers with the first pilot). Detectors, ranking and the scheduler read only from here.
 */
export const DIGEST_CONFIG = {
  schedule: {
    defaultDay: "mon" as const,
    defaultHour: 7,
    minHour: 6,
    maxHour: 10,
    /** No digest email between 20:00 and 07:00 shop time (spec pipeline 3). */
    quietFromHour: 20,
    quietUntilHour: 7,
    /** Shops per sweep page (withSystem read of ids only, then one build job per shop). */
    sweepPageSize: 500,
  },
  /** Trailing window for the "trailing median" comparisons (4 weeks, up to 8 with history). */
  trailingWeeks: 8,
  /**
   * When more than this share of the week's orders has no final fees yet, the revenue-based
   * detectors (D2, D3, D4, D5 low margin, D8 best net) stay silent: their numbers would be wrong.
   */
  maxIncompleteShare: 0.2,
  minTrailingWeeks: 4,
  d2: { minChangePct: 15, minChangeCents: 10_000 },
  d3: { minMarginDropPoints: 3, minOrders: 20 },
  d4: { maxRoas: 2, minSpendCents: 1_000 },
  d5: { minUnits: 3, lowMarginPct: 15 },
  d6: {
    minOnTimePct: 95,
    maxOnTimeDropPoints: 5,
    minShipped: 10,
    reprintSpikeRatio: 1.5,
    minReprints: 3,
  },
  d7: { topDesigns: 5 },
  d8: { bestNetWeeks: 4, onTimeRecordMinShipped: 10 },
  /*
   * Track E (spec business-analytics-v2 AC-E1..E1e). Edges: D9 fires at exactly 50¢ worse and 30
   * labeled orders; D10 above 5% (not at it) with ≥ 30 orders; D11 dead stock above 15%, a size
   * gap at or below −15 points with under 14 days of cover; D12 at 5% or more; D13 only with fixed
   * costs set and a monthly operating-profit pace below zero (pace below break-even).
   */
  d9: { minLabeledOrders: 30, minWorseCents: 50, trailingWeeks: 4 },
  d10: { minOrders: 30, minLosingPct: 5 },
  d11: { maxDeadPct: 15, maxGapPts: -15, maxCoverDays: 14, days: 90, maxGaps: 2 },
  d12: { minRisePct: 5, monthsBack: 3, lookbackDays: 200 },
  d13: { windowWeeks: 4 },
  ranking: {
    maxActions: 3,
    maxMarket: 2,
    /** Severity weights (score = impact × confidence × severity). */
    severity: {
      D1: 100,
      D2: 1,
      D3: 1.2,
      D4: 1.1,
      D5: 0.8,
      D6: 1.5,
      D7: 1.3,
      D8: 1,
      market: 0.6,
      // Track E (T-A9). D11's impact is cash tied up in stock or a sales estimate, and D13's is a
      // monthly shortfall scaled to a week: weighted below the direct-loss detectors.
      D9: 1.2,
      D10: 1,
      D11: 0.5,
      D12: 0.9,
      D13: 0.8,
    },
    /** Impact floor so a detector without a dollar figure still ranks. */
    minImpactCents: 1_000,
    /** Voted down last week: score × this (demoted below equal scores, AC12). */
    votedDownFactor: 0.5,
    /** Shown this many weeks running with no click → out of the top 3 (AC12). */
    maxWeeksShownWithoutAction: 3,
  },
  /** Two `skipped_quiet` weeks in a row → the "paused" line (spec pipeline 7). */
  pausedAfterQuietWeeks: 2,
  preview: { windowSec: 60 },
  /** Today's action panel (T-A9): same detectors, 7 days ending yesterday, up to 5 actions. */
  today: { maxActions: 5, windowDays: 7, retentionDays: 90, backfillDays: 90 },
  /** Stored digests older than this are purged (research 12 §2.7 retention). */
  retentionWeeks: 104,
} as const;

export type DigestConfig = typeof DIGEST_CONFIG;

/*
 * Kill switches (spec pipeline 10): all digests, email only. T-19-4 owns `src/env.ts`; until its
 * switches land these are read from process.env with the same names and defaults, at call time
 * (the same approach T-19-2 took for `DIGEST_SUMMARY_MODE`).
 */
const flag = z
  .enum(["true", "false", "1", "0"])
  .optional()
  .transform((v) => v === undefined || v === "true" || v === "1");
export function digestKillSwitches() {
  return {
    digestsEnabled: flag.catch(true).parse(process.env.DIGEST_ENABLED || undefined),
    emailEnabled: flag.catch(true).parse(process.env.DIGEST_EMAIL_ENABLED || undefined),
  };
}
