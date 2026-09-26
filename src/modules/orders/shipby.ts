import { CHANNEL_RULES, type Channel } from "@invai/contracts";

/*
 * Ship-by when the channel sends none: placed + N business days in the shop's timezone, due at
 * the end of that day. N = the connection's processingDays (Etsy's processing time for CSV
 * shops), else the CHANNEL_RULES default. Business days skip Sundays, Saturdays (unless the shop
 * ships on Saturdays) and USPS postal holidays. Orders placed on a non-business day count from
 * the next business day. A ship-by the channel sends is the channel's own promise: kept as is.
 */

/**
 * Days USPS post offices are closed (T-7-4, B-26). Source: USPS Employee and Labor Relations
 * Manual 518.1 (https://about.usps.com/manuals/elm/html/elmc5_008.htm) for the 11 holidays and
 * the weekend rule, and the USPS newsroom holiday list for 2026
 * (https://about.usps.com/newsroom/events/, checked 2026-09-26). ELM 518 moves a Saturday holiday
 * to Friday for pay only: USPS said "Post Offices will be open, and deliveries will occur as
 * normal on Friday, July 3" 2026 and closed Saturday, July 4
 * (https://about.usps.com/newsroom/national-releases/2026/0626-usps-will-be-closed-in-observance-of-independence-day-july-4.htm).
 * So a Saturday holiday closes that Saturday and a Sunday holiday closes the Monday after.
 * 2027 follows the same rules; USPS hadn't published its 2027 list yet. Extend this before 2028.
 */
export const USPS_HOLIDAYS: ReadonlySet<string> = new Set([
  // 2026
  "2026-01-01", // New Year's Day (Thu)
  "2026-01-19", // Martin Luther King Jr. Day
  "2026-02-16", // Washington's Birthday
  "2026-05-25", // Memorial Day
  "2026-06-19", // Juneteenth (Fri)
  "2026-07-04", // Independence Day (Sat; post offices open Fri 7/3)
  "2026-09-07", // Labor Day
  "2026-10-12", // Columbus Day
  "2026-11-11", // Veterans Day (Wed)
  "2026-11-26", // Thanksgiving Day
  "2026-12-25", // Christmas Day (Fri)
  // 2027
  "2027-01-01", // New Year's Day (Fri)
  "2027-01-18", // Martin Luther King Jr. Day
  "2027-02-15", // Washington's Birthday
  "2027-05-31", // Memorial Day
  "2027-06-19", // Juneteenth (Sat)
  "2027-07-05", // Independence Day (Sun 7/4, observed Mon)
  "2027-09-06", // Labor Day
  "2027-10-11", // Columbus Day
  "2027-11-11", // Veterans Day (Thu)
  "2027-11-25", // Thanksgiving Day
  "2027-12-25", // Christmas Day (Sat)
]);

export type ShipDays = {
  /** The shop hands packages to the carrier on Saturdays (company settings). Default: no. */
  shipsSaturday?: boolean;
  /** Closed days as YYYY-MM-DD; default USPS_HOLIDAYS. */
  holidays?: ReadonlySet<string>;
};

/** Wall-clock parts of `date` in `timeZone`. */
function zonedParts(date: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** UTC offset (ms) of `timeZone` at `date`. */
function tzOffset(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** The instant of `y-m-d hh:mm:ss.999` wall-clock time in `timeZone`. */
function zonedInstant(y: number, m: number, d: number, timeZone: string, endOfDay = true) {
  const guess = endOfDay
    ? new Date(Date.UTC(y, m - 1, d, 23, 59, 59, 999))
    : new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0));
  const offset = tzOffset(guess, timeZone);
  return new Date(guess.getTime() - offset);
}

export function addBusinessDays(
  placedAt: Date,
  days: number,
  timeZone = "America/Phoenix",
  shipDays: ShipDays = {},
): Date {
  const p = zonedParts(placedAt, timeZone);
  const holidays = shipDays.holidays ?? USPS_HOLIDAYS;
  // Walk calendar days at noon UTC to avoid DST edges; weekday comes from the UTC date itself.
  const cursor = new Date(Date.UTC(p.year, p.month - 1, p.day, 12));
  const closed = (d: Date) =>
    d.getUTCDay() === 0 ||
    (d.getUTCDay() === 6 && !shipDays.shipsSaturday) ||
    holidays.has(d.toISOString().slice(0, 10));
  while (closed(cursor)) cursor.setUTCDate(cursor.getUTCDate() + 1);
  let left = days;
  while (left > 0) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    if (!closed(cursor)) left--;
  }
  return zonedInstant(
    cursor.getUTCFullYear(),
    cursor.getUTCMonth() + 1,
    cursor.getUTCDate(),
    timeZone,
  );
}

export function computeShipBy(input: {
  channel: Channel;
  placedAt: Date;
  channelShipBy: Date | null;
  processingDays: number | null;
  timeZone?: string;
  shipDays?: ShipDays;
}): Date {
  const c = input.channelShipBy;
  if (c && !Number.isNaN(c.getTime())) {
    // A date-only ship-by (CSV exports) arrives as 12:00:00.000Z: due by the end of that day.
    const dateOnly =
      c.getUTCHours() === 12 &&
      c.getUTCMinutes() === 0 &&
      c.getUTCSeconds() === 0 &&
      c.getUTCMilliseconds() === 0;
    return dateOnly
      ? zonedInstant(
          c.getUTCFullYear(),
          c.getUTCMonth() + 1,
          c.getUTCDate(),
          input.timeZone ?? "America/Phoenix",
        )
      : c;
  }
  const days = input.processingDays ?? CHANNEL_RULES[input.channel].shipBy.defaultDays;
  return addBusinessDays(input.placedAt, days, input.timeZone, input.shipDays);
}

/** Start and end of "today" in the shop's timezone. */
export function todayRange(timeZone = "America/Phoenix", now = new Date()) {
  const p = zonedParts(now, timeZone);
  return {
    start: zonedInstant(p.year, p.month, p.day, timeZone, false),
    end: zonedInstant(p.year, p.month, p.day, timeZone),
  };
}
