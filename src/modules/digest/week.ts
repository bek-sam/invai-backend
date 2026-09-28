import { sql } from "drizzle-orm";
import type { Tx } from "../../db/client";

/*
 * ISO weeks in shop time. Calendar arithmetic on dates (YYYY-MM-DD) is time-zone free; turning a
 * local midnight into an instant, and "now" into shop-local time, is done in Postgres
 * (`AT TIME ZONE`), so DST comes from the database's tz data (spec pipeline 1, AC3).
 */

const DAY_MS = 86_400_000;

const toDate = (ymd: string) => new Date(`${ymd}T00:00:00Z`);
const ymdOf = (d: Date) => d.toISOString().slice(0, 10);

export function addDays(ymd: string, n: number): string {
  return ymdOf(new Date(toDate(ymd).getTime() + n * DAY_MS));
}

/** ISO weekday 1 (Monday) .. 7 (Sunday). */
export function isoWeekday(ymd: string): number {
  const d = toDate(ymd).getUTCDay();
  return d === 0 ? 7 : d;
}

export function mondayOf(ymd: string): string {
  return addDays(ymd, 1 - isoWeekday(ymd));
}

/** `2026-W39` for any date in that ISO week (week 1 holds 4 January). */
export function isoWeekKey(ymd: string): string {
  const thursday = toDate(addDays(ymd, 4 - isoWeekday(ymd)));
  const year = thursday.getUTCFullYear();
  const jan1 = Date.UTC(year, 0, 1);
  const week = Math.floor((thursday.getTime() - jan1) / DAY_MS / 7) + 1;
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** The Monday (YYYY-MM-DD) that starts an ISO week key. */
export function mondayOfWeekKey(weekKey: string): string {
  const m = /^(\d{4})-W(\d{2})$/.exec(weekKey);
  if (!m) throw new Error(`bad week key ${weekKey}`);
  const year = Number(m[1]);
  const week = Number(m[2]);
  const week1Monday = mondayOf(ymdOf(new Date(Date.UTC(year, 0, 4))));
  const monday = addDays(week1Monday, (week - 1) * 7);
  if (isoWeekKey(monday) !== weekKey) throw new Error(`bad week key ${weekKey}`);
  return monday;
}

export type LocalNow = { ymd: string; hour: number; minute: number };

/** Shop-local date and time of an instant, computed in the database. */
export async function localNow(tx: Tx, timezone: string, at: Date): Promise<LocalNow> {
  const rows = await tx.execute<{ ymd: string; hour: number; minute: number }>(sql`
    select to_char(${at.toISOString()}::timestamptz at time zone ${timezone}, 'YYYY-MM-DD') as ymd,
           extract(hour from ${at.toISOString()}::timestamptz at time zone ${timezone})::int as hour,
           extract(minute from ${at.toISOString()}::timestamptz at time zone ${timezone})::int as minute`);
  const r = rows.rows[0];
  if (!r) throw new Error("localNow: no row");
  return { ymd: r.ymd, hour: Number(r.hour), minute: Number(r.minute) };
}

/** Local midnights of `ymds` as instants (DST-safe), in the same order. */
export async function localMidnights(tx: Tx, timezone: string, ymds: string[]): Promise<Date[]> {
  const rows = await tx.execute<{ i: number; at: string }>(sql`
    select i::int as i, ((d::date)::timestamp at time zone ${timezone}) as at
    from unnest(${`{${ymds.join(",")}}`}::text[]) with ordinality as t(d, i)
    order by i`);
  return rows.rows.map((r) => new Date(r.at));
}

/** The last complete ISO week before the week containing `localYmd`. */
export function lastCompleteWeek(localYmd: string) {
  const thisMonday = mondayOf(localYmd);
  const weekStart = addDays(thisMonday, -7);
  return { weekKey: isoWeekKey(weekStart), weekStart, weekEnd: thisMonday };
}
