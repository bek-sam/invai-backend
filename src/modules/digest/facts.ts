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

export function fact(id: string, unit: FactUnit, value: number | string | null): DigestFact {
  return {
    id,
    unit,
    value,
    formatted: { en: formatValue(unit, value, "en"), es: formatValue(unit, value, "es") },
  };
}

/** A relative change as a fact (`pct`, signed). Null when the base is zero. */
export function changeFact(id: string, changePct: number | null): DigestFact | null {
  if (changePct === null) return null;
  const v = Math.round(changePct * 10) / 10;
  return {
    id,
    unit: "pct",
    value: v,
    formatted: { en: signedPct("en", v), es: signedPct("es", v) },
  };
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
