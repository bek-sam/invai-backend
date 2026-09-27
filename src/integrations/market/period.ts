/*
 * One shared `asOf` shape for every market provider (AC6, reviewer round-1 finding 3): an ISO
 * datetime (UTC, with a `Z`/numeric offset so `@invai/contracts`'s `Timestamp` --
 * `z.iso.datetime({ offset: true })` -- parses it) for the *end* of the last point's period, not
 * the moment the call happened. A bare period string ("2025-12", "2026-W38") is never a valid
 * `asOf`: it fails `Timestamp.parse`, and `new Date("2026-W38")` is an Invalid Date.
 */

export type Granularity = "week" | "month";

/** ISO 8601 week string ("2026-W38") for a UTC date, per the standard ISO week algorithm. */
export function isoWeek(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** The last UTC instant (23:59:59.999) inside the ISO month `"YYYY-MM"`. */
function endOfMonthIso(period: string): string {
  const [year, month] = period.split("-").map(Number);
  if (!year || !month) throw new Error(`period not in "YYYY-MM" form: ${period}`);
  // Date.UTC(year, month, 0) is "day 0 of month+1" (0-based), i.e. the last day of `month`
  // (1-based) -- JS's own month-rollover arithmetic, not a manual days-in-month table.
  return new Date(Date.UTC(year, month, 0, 23, 59, 59, 999)).toISOString();
}

/** The last UTC instant (Sunday 23:59:59.999) inside the ISO week `"YYYY-Www"`. */
function endOfIsoWeekIso(period: string): string {
  const match = /^(\d{4})-W(\d{2})$/.exec(period);
  if (!match) throw new Error(`period not in "YYYY-Www" form: ${period}`);
  const year = Number(match[1]);
  const week = Number(match[2]);
  // Standard ISO-week-to-date algorithm: week N's Thursday is the Nth Thursday-anchored week of
  // the year; walk back/forward from a rough guess to the Monday, then add 6 days for Sunday.
  const rough = new Date(Date.UTC(year, 0, 1 + (week - 1) * 7));
  const dow = rough.getUTCDay() || 7; // Monday=1 .. Sunday=7
  const monday = new Date(rough);
  monday.setUTCDate(rough.getUTCDate() - dow + 1);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  sunday.setUTCHours(23, 59, 59, 999);
  return sunday.toISOString();
}

/** `asOf` for a period string at the given granularity (AC6: one format for every provider). */
export function periodEndIso(period: string, granularity: Granularity): string {
  return granularity === "month" ? endOfMonthIso(period) : endOfIsoWeekIso(period);
}

/** `asOf` for a series: the end of its last point's period, or `fallbackIso` when there are none. */
export function seriesAsOf(
  points: { period: string }[],
  granularity: Granularity,
  fallbackIso: string,
): string {
  const last = points.at(-1);
  return last ? periodEndIso(last.period, granularity) : fallbackIso;
}
