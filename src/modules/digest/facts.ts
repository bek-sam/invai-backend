import type { DigestFact, FactUnit } from "@invai/contracts";

/*
 * Facts: every number the digest shows is a `DigestFact` with a stable id, the raw value and the
 * formatted strings in both languages. Money stays USD in Spanish too (AC13): `es-US` formats
 * cents as `$1,234.56`, the same symbol and grouping the English page uses.
 */

export type Lang = "en" | "es";
export const LANGS: readonly Lang[] = ["en", "es"];
const LOCALE: Record<Lang, string> = { en: "en-US", es: "es-US" };

const money = (lang: Lang, cents: number) =>
  new Intl.NumberFormat(LOCALE[lang], { style: "currency", currency: "USD" }).format(cents / 100);
const count = (lang: Lang, n: number) => new Intl.NumberFormat(LOCALE[lang]).format(n);
/** A percent number (6.5 → "6.5%"), at most one decimal. */
const pct = (lang: Lang, p: number) =>
  new Intl.NumberFormat(LOCALE[lang], { style: "percent", maximumFractionDigits: 1 }).format(
    p / 100,
  );
/** A signed percent change (15 → "+15%", -3.2 → "-3.2%"). */
const signedPct = (lang: Lang, p: number) =>
  new Intl.NumberFormat(LOCALE[lang], {
    style: "percent",
    maximumFractionDigits: 1,
    signDisplay: "exceptZero",
  }).format(p / 100);
const hours = (lang: Lang, h: number) =>
  `${new Intl.NumberFormat(LOCALE[lang], { maximumFractionDigits: 1 }).format(h)} h`;
const dateOnly = (lang: Lang, ymd: string) =>
  new Intl.DateTimeFormat(LOCALE[lang], {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${ymd}T00:00:00Z`));

export function formatValue(unit: FactUnit, value: number | string | null, lang: Lang): string {
  if (value === null) return "—";
  if (typeof value === "string") return unit === "date" ? dateOnly(lang, value) : value;
  switch (unit) {
    case "cents":
      return money(lang, value);
    case "count":
      return count(lang, value);
    case "pct":
      return pct(lang, value);
    case "ratio":
      return pct(lang, value * 100);
    case "hours":
      return hours(lang, value);
    default:
      return String(value);
  }
}

/**
 * A date fact in the short "week ending" form ("Sep 27" / "27 sep"; market-signals.md
 * `source.weekEnding`). `es-MX` gives the approved "sep" abbreviation (`es-US` writes "sept").
 */
const SHORT_DATE_LOCALE: Record<Lang, string> = { en: "en-US", es: "es-MX" };
export function shortDateFact(id: string, ymd: string | null): DigestFact {
  const fmt = (lang: Lang) =>
    ymd === null
      ? "—"
      : new Intl.DateTimeFormat(SHORT_DATE_LOCALE[lang], {
          month: "short",
          day: "numeric",
          timeZone: "UTC",
        }).format(new Date(`${ymd}T00:00:00Z`));
  return { id, unit: "date", value: ymd, formatted: { en: fmt("en"), es: fmt("es") } };
}

export function fact(id: string, unit: FactUnit, value: number | string | null): DigestFact {
  return {
    id,
    unit,
    value,
    formatted: { en: formatValue(unit, value, "en"), es: formatValue(unit, value, "es") },
  };
}

/** Zero change on any metric (weekly-digest.md "Change wording"): never "0%" or "+0.0 pts". */
const UNCHANGED: Record<Lang, string> = { en: "unchanged", es: "sin cambio" };

/**
 * A signed point difference, one decimal ("+6.9 pts" in both languages; spec copy `change.pts`).
 * Uses `es-US` like every other digest number, so Spanish keeps the decimal point (PM decision,
 * specs/weekly-digest.md).
 */
const signedPts = (lang: Lang, p: number) =>
  `${new Intl.NumberFormat(LOCALE[lang], {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
    signDisplay: "exceptZero",
  }).format(p)} pts`;

/**
 * A change as a fact (`pct`, signed), rounded to one decimal. `kind: "relative"` (default) is a
 * relative percent change ("+15%"); `kind: "points"` is a percentage-point difference for a
 * metric that is itself a percent (margin, on-time rate). A change that rounds to zero reads
 * "unchanged". Null when there is no change to show (no previous value, or a zero base).
 */
export function changeFact(
  id: string,
  change: number | null,
  kind: "relative" | "points" = "relative",
): DigestFact | null {
  if (change === null) return null;
  const v = Math.round(change * 10) / 10;
  const fmt = (lang: Lang) =>
    v === 0 ? UNCHANGED[lang] : kind === "points" ? signedPts(lang, v) : signedPct(lang, v);
  return { id, unit: "pct", value: v === 0 ? 0 : v, formatted: { en: fmt("en"), es: fmt("es") } };
}

/** Relative change in percent (15 = +15%); null when `prev` is 0 or missing. */
export function pctChange(cur: number, prev: number | null | undefined): number | null {
  if (prev === null || prev === undefined || prev === 0) return null;
  return ((cur - prev) / Math.abs(prev)) * 100;
}

export function median(xs: readonly number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}
