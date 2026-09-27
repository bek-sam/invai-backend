import type { ConfidenceBand, SignalSource } from "@invai/contracts";
import { MARKET_CONFIG } from "./config";

/*
 * Confidence = s · f · r · a, each in [0, 1] (spec step 4). s, r and a are stored with the signal;
 * f is applied when the signal is read, so an old signal loses confidence without a re-run.
 */

const DAY_MS = 86_400_000;

export function sampleFactor(n: number, target: number): number {
  if (target <= 0) return 1;
  return Math.max(0, Math.min(1, n / target));
}

export function sourceConfig(source: SignalSource) {
  return MARKET_CONFIG.sources[source];
}

/** f = 0.5^(age / half-life); age from the date the data describes. */
export function freshness(source: SignalSource, asOf: Date, now: Date): number {
  const ageDays = Math.max(0, (now.getTime() - asOf.getTime()) / DAY_MS);
  return 0.5 ** (ageDays / sourceConfig(source).halfLifeDays);
}

/** Older than 2× the source's TTL. */
export function isStale(source: SignalSource, asOf: Date, now: Date): boolean {
  const ageDays = (now.getTime() - asOf.getTime()) / DAY_MS;
  return ageDays > 2 * sourceConfig(source).ttlDays;
}

/** r for a source, times the mapper's confidence when the niche came from the model. */
export function reliability(source: SignalSource, mapperConfidence: number | null = null): number {
  const r = sourceConfig(source).reliability;
  return mapperConfidence === null ? r : r * mapperConfidence;
}

export type Direction = "rising" | "falling" | "flat" | "insufficient";

/**
 * Agreement a over the directional readings: 1.0 when two or more agree, 0.7 with a single
 * source (or a mix of flat and one direction), 0.4 when some rise and some fall. The flag is
 * stated to the user; the readings are never averaged into one.
 */
export function agreement(directions: Direction[]): { a: number; disagreement: boolean } {
  const c = MARKET_CONFIG.confidence.agreement;
  const d = directions.filter((x) => x !== "insufficient");
  if (d.includes("rising") && d.includes("falling")) return { a: c.disagree, disagreement: true };
  if (d.length >= 2 && new Set(d).size === 1) return { a: c.agree, disagreement: false };
  return { a: c.single, disagreement: false };
}

export function band(confidence: number): ConfidenceBand {
  const c = MARKET_CONFIG.confidence;
  if (confidence >= c.high) return "high";
  if (confidence >= c.medium) return "medium";
  return "low";
}

const BAND_RANK: Record<ConfidenceBand, number> = { low: 0, medium: 1, high: 2 };

export function bandAtLeast(b: ConfidenceBand, min: ConfidenceBand): boolean {
  return BAND_RANK[b] >= BAND_RANK[min];
}

/** s · f · r · a, clamped to [0, 1] and rounded to 4 places. */
export function combine(parts: { s: number; f: number; r: number; a: number }): number {
  const c = parts.s * parts.f * parts.r * parts.a;
  return Math.round(Math.max(0, Math.min(1, c)) * 10_000) / 10_000;
}
