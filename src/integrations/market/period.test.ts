import { describe, expect, it } from "vitest";
import { periodEndIso } from "./period";

/*
 * An ISO-week implementation independent of `period.ts`'s (which shifts a rough guess to the
 * nearest Thursday). This one uses the ordinal-date formula, so a bug shared by both would have
 * to be a bug in the ISO 8601 definition itself, not in either implementation.
 */

/** Richards' formula: 1 if ISO year `y` has 53 weeks, 0 if it has 52. */
function p(y: number): number {
  return (y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400)) % 7;
}

function weeksInIsoYear(year: number): number {
  return p(year) === 4 || p(year - 1) === 3 ? 53 : 52;
}

/** `{ isoYear, week }` for a UTC date, via the day-of-year formula (not the Thursday-shift one). */
function isoWeekOfIndependent(date: Date): { isoYear: number; week: number } {
  const year = date.getUTCFullYear();
  const midnight = Date.UTC(year, date.getUTCMonth(), date.getUTCDate());
  const jan1 = Date.UTC(year, 0, 1);
  const ordinal = Math.round((midnight - jan1) / 86_400_000) + 1;
  const weekday = date.getUTCDay() || 7; // Monday=1 .. Sunday=7
  const week = Math.floor((ordinal - weekday + 10) / 7);
  if (week < 1) {
    return { isoYear: year - 1, week: weeksInIsoYear(year - 1) };
  }
  if (week > weeksInIsoYear(year)) {
    return { isoYear: year + 1, week: 1 };
  }
  return { isoYear: year, week };
}

function toPeriod(isoYear: number, week: number): string {
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

describe("periodEndIso (week) round-trips through an independent ISO-week function", () => {
  it("2027-W10 -> 2027-03-14T23:59:59.999Z (reviewer round-2 example)", () => {
    expect(periodEndIso("2027-W10", "week")).toBe("2027-03-14T23:59:59.999Z");
  });

  for (let year = 2020; year <= 2030; year++) {
    const weeks = weeksInIsoYear(year);

    it(`every ISO week of ${year} (${weeks} weeks) round-trips and ends on a Sunday`, () => {
      for (let week = 1; week <= weeks; week++) {
        const period = toPeriod(year, week);
        const iso = periodEndIso(period, "week");
        const end = new Date(iso);

        // end must be a Sunday at 23:59:59.999 UTC.
        expect(end.getUTCDay()).toBe(0);
        expect(end.getUTCHours()).toBe(23);
        expect(end.getUTCMinutes()).toBe(59);
        expect(end.getUTCSeconds()).toBe(59);
        expect(end.getUTCMilliseconds()).toBe(999);

        // and it must fall inside the same ISO week it was computed for, per the independent
        // implementation above.
        const { isoYear, week: roundTripWeek } = isoWeekOfIndependent(end);
        expect(toPeriod(isoYear, roundTripWeek)).toBe(period);
      }
    });
  }
});
