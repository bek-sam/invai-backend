import { CHANNEL_RULES, type Channel } from "@invai/contracts";

/*
 * Ship-by when the channel sends none: placed + N business days (Mon-Fri) in the shop's timezone,
 * due at the end of that day. N = the connection's processingDays, else CHANNEL_RULES default.
 * Orders placed on a weekend count from the next business day.
 */

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

export function addBusinessDays(placedAt: Date, days: number, timeZone = "America/Phoenix"): Date {
  const p = zonedParts(placedAt, timeZone);
  // Walk calendar days at noon UTC to avoid DST edges; weekday comes from the UTC date itself.
  const cursor = new Date(Date.UTC(p.year, p.month - 1, p.day, 12));
  const isWeekend = (d: Date) => d.getUTCDay() === 0 || d.getUTCDay() === 6;
  while (isWeekend(cursor)) cursor.setUTCDate(cursor.getUTCDate() + 1);
  let left = days;
  while (left > 0) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    if (!isWeekend(cursor)) left--;
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
}): Date {
  if (input.channelShipBy && !Number.isNaN(input.channelShipBy.getTime()))
    return input.channelShipBy;
  const days = input.processingDays ?? CHANNEL_RULES[input.channel].shipBy.defaultDays;
  return addBusinessDays(input.placedAt, days, input.timeZone);
}

/** Start and end of "today" in the shop's timezone. */
export function todayRange(timeZone = "America/Phoenix", now = new Date()) {
  const p = zonedParts(now, timeZone);
  return {
    start: zonedInstant(p.year, p.month, p.day, timeZone, false),
    end: zonedInstant(p.year, p.month, p.day, timeZone),
  };
}
