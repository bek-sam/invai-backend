import { describe, expect, it } from "vitest";
import { planSortAt, SORT_ANCHOR_MS, utcStartOfDay } from "./plan-order";

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** Plans the way the builder makes them: some `now - age`, some pinned to today's midnight. */
function orderAt(nowMs: number) {
  const today = utcStartOfDay(nowMs);
  const plans = [
    { name: "recent-a", placedAt: nowMs - 2 * DAY - 3 * HOUR, rel: true },
    { name: "recent-b", placedAt: nowMs - 2 * DAY - 9 * HOUR, rel: true },
    { name: "recent-c", placedAt: nowMs - 1 * DAY, rel: true },
    { name: "due-1", placedAt: today + 17 * HOUR - 2 * DAY - 4 * HOUR, rel: false },
    { name: "due-2", placedAt: today + 17 * HOUR - 3 * DAY - 6 * HOUR, rel: false },
  ];
  return plans
    .map((p) => ({ ...p, sortAt: planSortAt(p.placedAt, nowMs, p.rel) }))
    .sort((a, b) => a.sortAt - b.sortAt)
    .map((p) => p.name);
}

describe("seed plan order (B-249)", () => {
  it("is the same at any time of the same UTC day", () => {
    const midnight = Date.UTC(2026, 9, 1);
    const early = orderAt(midnight + 1 * HOUR);
    for (const h of [3, 9, 12, 15.5, 20, 23.9]) expect(orderAt(midnight + h * HOUR)).toEqual(early);
  });

  it("would differ by time of day if sorted by the real placedAt (the bug it fixes)", () => {
    const midnight = Date.UTC(2026, 9, 1);
    const byPlacedAt = (nowMs: number) => {
      const today = utcStartOfDay(nowMs);
      return [
        { n: "recent", t: nowMs - 2 * DAY },
        { n: "due", t: today + 17 * HOUR - 2 * DAY - 4 * HOUR },
      ]
        .sort((a, b) => a.t - b.t)
        .map((p) => p.n);
    };
    expect(byPlacedAt(midnight + 1 * HOUR)).not.toEqual(byPlacedAt(midnight + 22 * HOUR));
  });

  it("keeps pinned plans at their real time and shifts relative ones onto the anchor", () => {
    const now = Date.UTC(2026, 9, 1, 7, 30);
    expect(planSortAt(1234, now, false)).toBe(1234);
    expect(planSortAt(now - DAY, now, true)).toBe(Date.UTC(2026, 9, 1) + SORT_ANCHOR_MS - DAY);
    expect(utcStartOfDay(Date.UTC(2026, 9, 1, 23, 59))).toBe(Date.UTC(2026, 9, 1));
  });
});
