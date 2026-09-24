/** Relative periods ("this week", "last 30 days"...) resolved against a fixed `now` (UTC days). */

export type ResolvedPeriod = { from: Date; to: Date; label: string };

const DAY = 86_400_000;

function startOfDay(d: Date) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

const fmt = (d: Date) =>
  d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

export function resolvePeriod(text: string, now = new Date()): ResolvedPeriod {
  const t = text.toLowerCase();
  const today = startOfDay(now);
  const mk = (from: Date, to: Date, label: string) => ({
    from,
    to,
    label: `${label} (${fmt(from)} – ${fmt(new Date(to.getTime() - 1))})`,
  });
  if (/\byesterday\b/.test(t)) return mk(new Date(today.getTime() - DAY), today, "yesterday");
  if (/\btoday\b/.test(t)) return mk(today, new Date(today.getTime() + DAY), "today");
  if (/\blast week\b/.test(t)) {
    const monday = new Date(today.getTime() - ((today.getUTCDay() + 6) % 7) * DAY);
    return mk(new Date(monday.getTime() - 7 * DAY), monday, "last week");
  }
  if (/\bthis week\b|\bweek\b/.test(t)) {
    const monday = new Date(today.getTime() - ((today.getUTCDay() + 6) % 7) * DAY);
    return mk(monday, new Date(today.getTime() + DAY), "this week");
  }
  if (/\blast month\b/.test(t)) {
    const first = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
    const prev = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
    return mk(prev, first, "last month");
  }
  if (/\bthis month\b|\bmonth\b/.test(t)) {
    const first = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
    return mk(first, new Date(today.getTime() + DAY), "this month");
  }
  const days = /\b(?:last|past)\s+(\d{1,3})\s+days?\b/.exec(t);
  const n = days ? Number(days[1]) : 30;
  return mk(
    new Date(today.getTime() - (n - 1) * DAY),
    new Date(today.getTime() + DAY),
    `the last ${n} days`,
  );
}
