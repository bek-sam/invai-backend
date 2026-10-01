/*
 * B-249: the seed's live-flow plans mix two clocks. Most orders are placed `now - age`, the
 * "due today/tomorrow" ones are pinned to today's UTC midnight (their ship-by is 17:00 UTC).
 * Sorting all of them by the real `placedAt` interleaves the two sets differently at every
 * minute of the day, and because the PRNG draws each order's lines, sizes and quantities in
 * sorted order, two seeds run a few minutes apart got different item counts (shipped 628 vs
 * 638 in T-P5-1). The sort key below moves every now-relative plan onto a fixed time of day,
 * so the order (and with it every count) only depends on the UTC date.
 */

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** Where now-relative plans sit within the UTC day for ordering purposes. */
export const SORT_ANCHOR_MS = 12 * HOUR;

/** UTC midnight of the day `nowMs` falls in. */
export function utcStartOfDay(nowMs: number): number {
  return Math.floor(nowMs / DAY) * DAY;
}

/**
 * Sort key for a seed plan. A plan placed relative to `nowMs` is shifted to the same offset from
 * today's anchor (noon UTC); a plan pinned to today's midnight keeps its real time.
 */
export function planSortAt(placedAtMs: number, nowMs: number, relativeToNow: boolean): number {
  if (!relativeToNow) return placedAtMs;
  return placedAtMs - nowMs + utcStartOfDay(nowMs) + SORT_ANCHOR_MS;
}
