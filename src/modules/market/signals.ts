import { MARKET_CONFIG } from "./config";

/*
 * Pure signal math (spec step 3). No DB, no clock except what the caller passes. Unit-tested on
 * fixed series in `signals.test.ts`, never on the SQL that feeds it.
 */

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

/* ---------------------------------- calendar ---------------------------------- */

/** The local calendar date of `at` in `timeZone` as `YYYY-MM-DD`. */
export function localYmd(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

function ymdToUtc(ymd: string): Date {
  return new Date(`${ymd}T00:00:00.000Z`);
}

function utcToYmd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** ISO 8601 week key (`2026-W38`) of a calendar date (`YYYY-MM-DD`). */
export function isoWeekOf(ymd: string): string {
  const d = ymdToUtc(ymd);
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / DAY_MS + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export type WeekSlot = {
  /** ISO week key. */
  key: string;
  /** Monday of the week, `YYYY-MM-DD`. */
  monday: string;
  /** Calendar month (1..12) of the week's Thursday: the month the week belongs to. */
  month: number;
};

/**
 * The last `count` complete ISO weeks before the local week of `now` (oldest first). The week in
 * progress is left out: a partial week would read as a demand drop.
 */
export function completeWeeks(now: Date, timeZone: string, count: number): WeekSlot[] {
  const today = ymdToUtc(localYmd(now, timeZone));
  const dow = today.getUTCDay() || 7;
  const thisMonday = today.getTime() - (dow - 1) * DAY_MS;
  const out: WeekSlot[] = [];
  for (let i = count; i >= 1; i--) {
    const monday = new Date(thisMonday - i * WEEK_MS);
    const thursday = new Date(monday.getTime() + 3 * DAY_MS);
    out.push({
      key: isoWeekOf(utcToYmd(monday)),
      monday: utcToYmd(monday),
      month: thursday.getUTCMonth() + 1,
    });
  }
  return out;
}

/** Month (1..12) of an ISO week key, by its Thursday. */
export function monthOfIsoWeek(key: string): number {
  const [y, w] = key.split("-W").map(Number) as [number, number];
  const jan4 = new Date(Date.UTC(y, 0, 4));
  const dow = jan4.getUTCDay() || 7;
  const week1Monday = jan4.getTime() - (dow - 1) * DAY_MS;
  const thursday = new Date(week1Monday + (w - 1) * WEEK_MS + 3 * DAY_MS);
  return thursday.getUTCMonth() + 1;
}

/* ---------------------------------- statistics ---------------------------------- */

/** Linear-interpolated quantile (type 7) of an ascending array. */
export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return Number.NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo] ?? 0;
  const b = sorted[hi] ?? a;
  return a + (b - a) * (pos - lo);
}

export function median(values: number[]): number {
  return quantile(
    [...values].sort((a, b) => a - b),
    0.5,
  );
}

/** OLS of y on x = 0..n-1: slope, intercept (fitted value at x = 0), its standard error and t. */
export function ols(y: number[]): { slope: number; intercept: number; se: number; t: number } {
  const n = y.length;
  const xm = (n - 1) / 2;
  const ym = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (i - xm) * ((y[i] ?? 0) - ym);
    sxx += (i - xm) ** 2;
  }
  const slope = sxx > 0 ? sxy / sxx : 0;
  const intercept = ym - slope * xm;
  let sse = 0;
  for (let i = 0; i < n; i++) {
    const fit = ym + slope * (i - xm);
    sse += ((y[i] ?? 0) - fit) ** 2;
  }
  const se = n > 2 && sxx > 0 ? Math.sqrt(sse / (n - 2) / sxx) : Number.POSITIVE_INFINITY;
  // A perfect fit (se 0) is as certain as it gets; a flat perfect fit has t 0.
  const t = se === 0 ? (slope === 0 ? 0 : Math.sign(slope) * Number.POSITIVE_INFINITY) : slope / se;
  return { slope, intercept, se, t };
}

/* ---------------------------------- trend ---------------------------------- */

export type TrendClass = "rising" | "falling" | "flat" | "insufficient";
export type InsufficientReason = "too_few_points" | "mostly_zero" | "no_source";

export type TrendFit = {
  trend: TrendClass;
  g4: number | null;
  t: number | null;
  windowWeeks: number;
  /** Weeks in the fit window with data (excluded weeks don't count). */
  windowPoints: number;
  insufficientReason: InsufficientReason | null;
};

/**
 * Trend of a weekly series (oldest first). `null` entries are excluded weeks (the blank was out of
 * stock) or weeks before the subject existed. OLS of ln(y/SI + 1) over the last 26 weeks, or 13
 * when the subject is younger than 26 weeks. `si` is the seasonality index for each week's month.
 */
export function fitTrend(
  series: (number | null)[],
  opts: { ageWeeks?: number; si?: (number | null)[] } = {},
): TrendFit {
  const c = MARKET_CONFIG.trend;
  const age = opts.ageWeeks ?? series.length;
  const windowWeeks = age >= c.windowWeeks ? c.windowWeeks : c.youngWindowWeeks;
  const start = Math.max(0, series.length - windowWeeks);
  const ys: number[] = [];
  let zeros = 0;
  for (let i = start; i < series.length; i++) {
    const v = series[i];
    if (v === null || v === undefined) continue;
    const si = opts.si?.[i];
    const adj = si && si > 0 ? v / si : v;
    if (v === 0) zeros++;
    ys.push(Math.log(adj + 1));
  }
  const base = { windowWeeks, windowPoints: ys.length };
  if (ys.length < c.minPoints)
    return {
      ...base,
      trend: "insufficient",
      g4: null,
      t: null,
      insufficientReason: "too_few_points",
    };
  if (zeros / ys.length > c.maxZeroShare)
    return { ...base, trend: "insufficient", g4: null, t: null, insufficientReason: "mostly_zero" };
  const { slope, t } = ols(ys);
  const g4 = Math.exp(4 * slope) - 1;
  let trend: TrendClass = "flat";
  if (g4 >= c.risingG4 && t >= c.tMin) trend = "rising";
  else if (g4 <= c.fallingG4 && t <= -c.tMin) trend = "falling";
  return { ...base, trend, g4, t: Number.isFinite(t) ? t : null, insufficientReason: null };
}

/**
 * Year over year: the last 4 weeks ÷ the same 4 weeks a year earlier − 1, with at least 56 weeks.
 * `minDenominator` is 10 units for own data, just above 0 for outside interest.
 */
export function yearOverYear(series: (number | null)[], minDenominator: number): number | null {
  const c = MARKET_CONFIG.yoy;
  if (series.length < c.minWeeks) return null;
  const sum = (from: number, to: number) => {
    let s = 0;
    for (let i = from; i < to; i++) s += series[i] ?? 0;
    return s;
  };
  const n = series.length;
  const now = sum(n - c.windowWeeks, n);
  const before = sum(n - 52 - c.windowWeeks, n - 52);
  if (before < minDenominator || before <= 0) return null;
  return now / before - 1;
}

/* ---------------------------------- seasonality ---------------------------------- */

export type MonthPoint = { period: string; value: number };

export type SeasonalityIndex = {
  /** Index per calendar month, 1..12, on detrended data (spec Step 3a). */
  index: { month: number; index: number }[];
  peakMonths: number[];
  offMonths: number[];
  yearsUsed: number;
};

/**
 * Seasonality index on **detrended** monthly data (spec Step 3a, B-131). A month mean of raw
 * values confounds trend with season: in a genuinely rising niche, later calendar months are on
 * average higher simply because they fall later in the trend, not because they're seasonally
 * busier — which then makes Trend's `y / SI` deseasonalization cancel the real trend back out.
 *
 * Fix: fit one OLS regression of ln(y+1) on the month index over the whole series (its full
 * available history, not a windowed slice), take the ratio of each actual point to that trend fit
 * (ŷ_t), average the ratios by calendar month across every year present, then normalize the 12
 * values to a mean of 1.
 *
 * Needs ≥ 2 full years (24 points) with ≥ 2 observed years for every calendar month (so each
 * month's average is over at least 2 ratios); `null` otherwise, or when the series is all zero.
 */
export function seasonalityIndex(months: MonthPoint[]): SeasonalityIndex | null {
  const c = MARKET_CONFIG.seasonality;
  const sorted = [...months].sort((a, b) => a.period.localeCompare(b.period));
  if (sorted.length < c.minYears * 12) return null;
  // An all-zero (or otherwise undetrendable) series fits a flat ln(y+1) = 0 trend, so every
  // ratio comes out to exactly 1 and `overall` is 1, not <= 0 — the `overall <= 0` guard below
  // never catches it. Without this check this returned a flat SI (all months index 1.0) instead
  // of `null`, which let a niche with no real signal (for example a near-zero-interest Trends
  // series) short-circuit the own → outside → Census source-priority fallback (`compute.ts`)
  // before Census ever ran.
  if (sorted.every((p) => p.value === 0)) return null;
  const { slope, intercept } = ols(sorted.map((p) => Math.log(p.value + 1)));
  const sums = new Array<number>(12).fill(0);
  const counts = new Array<number>(12).fill(0);
  sorted.forEach((p, i) => {
    const fitted = Math.exp(intercept + slope * i) - 1;
    const ratio = (p.value + 1) / (fitted + 1);
    const m = Number(p.period.slice(5, 7)) - 1;
    sums[m] = (sums[m] ?? 0) + ratio;
    counts[m] = (counts[m] ?? 0) + 1;
  });
  if (counts.some((n) => n < c.minYears)) return null;
  const siRaw = sums.map((s, i) => s / (counts[i] ?? 1));
  const overall = siRaw.reduce((a, b) => a + b, 0) / 12;
  if (overall <= 0) return null;
  const index = siRaw.map((v, i) => ({ month: i + 1, index: round4(v / overall) }));
  return {
    index,
    peakMonths: index.filter((x) => x.index >= c.peakIndex).map((x) => x.month),
    offMonths: index.filter((x) => x.index <= c.offIndex).map((x) => x.month),
    yearsUsed: Math.floor(sorted.length / 12),
  };
}

/** Weekly points to monthly means (by the week's Thursday month); for relative-scale series. */
export function weeklyToMonthly(points: { period: string; value: number }[]): MonthPoint[] {
  const by = new Map<string, { s: number; n: number }>();
  for (const p of points) {
    const [y, w] = p.period.split("-W").map(Number) as [number, number];
    const month = monthOfIsoWeek(p.period);
    // A week-53 or early-January week can belong to the neighbouring year's month.
    const year = month === 12 && w <= 2 ? y - 1 : month === 1 && w >= 52 ? y + 1 : y;
    const key = `${year}-${String(month).padStart(2, "0")}`;
    const cur = by.get(key) ?? { s: 0, n: 0 };
    cur.s += p.value;
    cur.n += 1;
    by.set(key, cur);
  }
  return [...by.entries()].map(([period, v]) => ({ period, value: v.s / v.n }));
}

export type ActBy = {
  date: string;
  peakMonth: number;
  weeksToPeak: number;
  leadTimeWeeks: number;
  actNow: boolean;
};

/** Lead time in weeks: median paid→shipped hours rounded up to weeks, plus the listing ramp. */
export function leadTimeWeeks(medianLeadHours: number | null): number {
  const c = MARKET_CONFIG.seasonality;
  const hours = medianLeadHours ?? c.defaultLeadHours;
  return Math.max(1, Math.ceil(hours / 168)) + c.listingRampWeeks;
}

/**
 * Act-by date for the next peak month (from the current month on, so a peak in progress counts):
 * the peak month's first day minus the lead time. "Act now" when ≤ 2 weeks are left and the peak
 * is ≤ 10 weeks away.
 */
export function actBy(
  now: Date,
  peakMonths: number[],
  leadWeeks: number,
  timeZone: string,
): ActBy | null {
  if (!peakMonths.length) return null;
  const c = MARKET_CONFIG.seasonality;
  const today = ymdToUtc(localYmd(now, timeZone));
  const y = today.getUTCFullYear();
  const m0 = today.getUTCMonth();
  for (let k = 0; k < 12; k++) {
    const month = ((m0 + k) % 12) + 1;
    if (!peakMonths.includes(month)) continue;
    const start = new Date(Date.UTC(y, m0 + k, 1));
    const weeksToPeak = Math.max(0, (start.getTime() - today.getTime()) / WEEK_MS);
    const date = new Date(start.getTime() - leadWeeks * WEEK_MS);
    const weeksLeft = weeksToPeak - leadWeeks;
    return {
      date: utcToYmd(date),
      peakMonth: month,
      weeksToPeak: round4(weeksToPeak),
      leadTimeWeeks: leadWeeks,
      actNow: weeksLeft <= c.actNowWeeks && weeksToPeak <= c.peakHorizonWeeks,
    };
  }
  return null;
}

/* ---------------------------------- price position ---------------------------------- */

export type Observation = {
  landedPriceCents: number;
  isFeatured: boolean;
  offerCount: number | null;
  personalized?: boolean;
};

/**
 * Comparable filter (spec step 2.5): landed $5–$80, the same personalization flag (an observation
 * without the flag counts as not personalized), then drop outliers outside Q1 − 1.5·IQR .. Q3 +
 * 1.5·IQR. The provider already scoped channel, marketplace, garment class and condition.
 */
export function filterComparables(obs: Observation[], personalized: boolean): Observation[] {
  const c = MARKET_CONFIG.price;
  const kept = obs.filter(
    (o) =>
      o.landedPriceCents >= c.landedMinCents &&
      o.landedPriceCents <= c.landedMaxCents &&
      (o.personalized ?? false) === personalized,
  );
  if (kept.length < 4) return kept;
  const prices = kept.map((o) => o.landedPriceCents).sort((a, b) => a - b);
  const q1 = quantile(prices, 0.25);
  const q3 = quantile(prices, 0.75);
  const iqr = q3 - q1;
  return kept.filter(
    (o) => o.landedPriceCents >= q1 - 1.5 * iqr && o.landedPriceCents <= q3 + 1.5 * iqr,
  );
}

export type PriceStats = {
  n: number;
  q1Cents: number;
  medianCents: number;
  q3Cents: number;
  featuredCents: number | null;
  offerCount: number | null;
};

export function priceStats(obs: Observation[]): PriceStats | null {
  if (!obs.length) return null;
  const prices = obs.map((o) => o.landedPriceCents).sort((a, b) => a - b);
  const featured = obs.find((o) => o.isFeatured);
  const offers = obs.map((o) => o.offerCount).filter((x): x is number => x !== null);
  return {
    n: obs.length,
    q1Cents: Math.round(quantile(prices, 0.25)),
    medianCents: Math.round(quantile(prices, 0.5)),
    q3Cents: Math.round(quantile(prices, 0.75)),
    featuredCents: featured ? featured.landedPriceCents : null,
    offerCount: offers.length ? Math.max(...offers) : null,
  };
}

/** Percentile P = (#below + 0.5·#equal) ÷ n, and the band (low < 0.25, premium > 0.75). */
export function pricePercentile(
  prices: number[],
  ownCents: number,
): { percentile: number; band: "low" | "market" | "premium" } {
  const c = MARKET_CONFIG.price;
  const below = prices.filter((p) => p < ownCents).length;
  const equal = prices.filter((p) => p === ownCents).length;
  const percentile = prices.length ? (below + 0.5 * equal) / prices.length : 0.5;
  const band =
    percentile < c.lowPercentile ? "low" : percentile > c.premiumPercentile ? "premium" : "market";
  return { percentile: round4(percentile), band };
}

/** Terciles of `values` (keyed): the lowest third `less_crowded`, the top third `crowded`. */
export function terciles<K>(
  values: Map<K, number>,
): Map<K, "less_crowded" | "typical" | "crowded"> {
  const out = new Map<K, "less_crowded" | "typical" | "crowded">();
  const sorted = [...values.values()].sort((a, b) => a - b);
  if (!sorted.length) return out;
  const t1 = quantile(sorted, 1 / 3);
  const t2 = quantile(sorted, 2 / 3);
  for (const [k, v] of values)
    out.set(k, v <= t1 ? "less_crowded" : v <= t2 ? "typical" : "crowded");
  return out;
}

/* ---------------------------------- margin at price ---------------------------------- */

export type CostBasis = {
  /** Average shipping charged per unit (the shipping share of revenue, net of discounts). */
  shippingChargedCents: number;
  unitCostCents: number;
  adsPerUnitCents: number;
  refundRate: number;
  /** Channel fees for one unit sold at `priceCents` (fees apply to price + shipping). */
  fees: (priceCents: number) => number;
};

/** net(p) = p + shipping − fees(p) − unit cost − ads per unit − refundRate·p, in whole cents. */
export function netAt(p: number, b: CostBasis): number {
  return Math.round(
    p + b.shippingChargedCents - b.fees(p) - b.unitCostCents - b.adsPerUnitCents - b.refundRate * p,
  );
}

/** Margin % = net ÷ revenue (price + shipping charged), as on the profit page. */
export function marginPctAt(p: number, b: CostBasis): number {
  const revenue = p + b.shippingChargedCents;
  return revenue > 0 ? round4((netAt(p, b) / revenue) * 100) : 0;
}

/** Lowest price on the 5¢ grid where `ok(p)` holds, searching up to $1,000. */
function lowestOnGrid(ok: (p: number) => boolean): number | null {
  const step = MARKET_CONFIG.margin.gridCents;
  for (let p = step; p <= 100_000; p += step) if (ok(p)) return p;
  return null;
}

export function breakEvenCents(b: CostBasis): number | null {
  return lowestOnGrid((p) => netAt(p, b) >= 0);
}

/** Lowest grid price with margin ≥ `floorPct`, then rounded up to the shop's price ending. */
export function floorPriceCents(
  b: CostBasis,
  ending: PriceEnding,
  floorPct: number,
): number | null {
  const raw = lowestOnGrid((p) => marginPctAt(p, b) >= floorPct);
  if (raw === null) return null;
  let p = roundToEnding(raw, ending, "up");
  // Rounding up keeps the margin (fees can step with a tier); walk up until it holds.
  for (let i = 0; i < 20 && marginPctAt(p, b) < floorPct; i++)
    p = roundToEnding(p + 1, ending, "up");
  return p;
}

export type PriceEnding = "99" | "00" | "grid";

/** The shop's price ending from its current price: .99, .00, or none (5¢ grid). */
export function priceEnding(currentCents: number | null): PriceEnding {
  if (currentCents === null) return "99";
  const cents = currentCents % 100;
  if (cents === 99) return "99";
  if (cents === 0) return "00";
  return "grid";
}

export function roundToEnding(
  p: number,
  ending: PriceEnding,
  mode: "nearest" | "up" = "nearest",
): number {
  if (ending === "grid") {
    const g = MARKET_CONFIG.margin.gridCents;
    return mode === "up" ? Math.ceil(p / g) * g : Math.round(p / g) * g;
  }
  const off = ending === "99" ? 99 : 0;
  // Candidates ...,(k-1)*100+off, k*100+off, ...
  const k = Math.floor((p - off) / 100);
  const lo = k * 100 + off;
  const hi = lo + 100;
  if (lo === p) return p;
  if (mode === "up") return hi;
  const best = p - lo <= hi - p ? lo : hi;
  return Math.max(off === 99 ? 99 : 100, best);
}

export type PriceCandidateOrigin =
  | "current"
  | "minus_10"
  | "minus_5"
  | "plus_5"
  | "plus_10"
  | "comparable_q1"
  | "comparable_median"
  | "comparable_q3"
  | "requested";

/**
 * Candidate prices: the current price, ±5% and ±10% rounded to the shop's ending, the comparables'
 * Q1/median/Q3 when present, and the requested prices as given. Deduplicated (first origin wins,
 * in that order), sorted, at most 20.
 */
export function candidatePrices(input: {
  currentCents: number | null;
  requested?: number[];
  comparables?: { q1Cents: number; medianCents: number; q3Cents: number } | null;
}): { priceCents: number; origin: PriceCandidateOrigin }[] {
  const ending = priceEnding(input.currentCents);
  const list: { priceCents: number; origin: PriceCandidateOrigin }[] = [];
  const p0 = input.currentCents;
  if (p0 !== null) list.push({ priceCents: p0, origin: "current" });
  for (const r of input.requested ?? []) list.push({ priceCents: r, origin: "requested" });
  if (p0 !== null) {
    const steps: [number, PriceCandidateOrigin][] = [
      [0.9, "minus_10"],
      [0.95, "minus_5"],
      [1.05, "plus_5"],
      [1.1, "plus_10"],
    ];
    for (const [f, origin] of steps)
      list.push({ priceCents: roundToEnding(Math.round(p0 * f), ending), origin });
  }
  if (input.comparables) {
    list.push({
      priceCents: roundToEnding(input.comparables.q1Cents, ending),
      origin: "comparable_q1",
    });
    list.push({
      priceCents: roundToEnding(input.comparables.medianCents, ending),
      origin: "comparable_median",
    });
    list.push({
      priceCents: roundToEnding(input.comparables.q3Cents, ending),
      origin: "comparable_q3",
    });
  }
  const seen = new Set<number>();
  const out = list.filter((c) => {
    if (c.priceCents <= 0 || seen.has(c.priceCents)) return false;
    seen.add(c.priceCents);
    return true;
  });
  return out
    .sort((a, b) => a.priceCents - b.priceCents)
    .slice(0, MARKET_CONFIG.margin.maxCandidates);
}

/* ---------------------------------- price response ---------------------------------- */

export type PricePoint = { priceCents: number; units: number; weeks: number };

/**
 * Arc elasticity between the two best-supported own price points (≥ 30 units each), clamped to
 * [−4, 0]. `null` ("volume effect unknown") otherwise.
 */
export function priceResponse(
  points: PricePoint[],
): { elasticity: number; pricePointsUsed: number } | null {
  const c = MARKET_CONFIG.margin;
  const ok = points
    .filter((p) => p.units >= c.elasticityMinUnits && p.weeks > 0)
    .sort((a, b) => b.units - a.units);
  if (ok.length < 2) return null;
  const [a, b] = ok as [PricePoint, PricePoint];
  if (a.priceCents === b.priceCents) return null;
  const qa = a.units / a.weeks;
  const qb = b.units / b.weeks;
  const dq = (qb - qa) / ((qa + qb) / 2);
  const dp = (b.priceCents - a.priceCents) / ((a.priceCents + b.priceCents) / 2);
  const e = Math.max(c.elasticityMin, Math.min(0, dq / dp));
  return { elasticity: round4(e), pricePointsUsed: ok.length };
}

/** Q(p) = Q0 · (p / p0)^ε. */
export function unitsAt(q0: number, p0: number, p: number, elasticity: number): number {
  return q0 * (p / p0) ** elasticity;
}

export function round4(x: number): number {
  return Math.round(x * 10_000) / 10_000;
}
