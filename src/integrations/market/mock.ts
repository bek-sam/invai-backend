import { createHash } from "node:crypto";
import type { Channel, Licence, SignalSource } from "@invai/contracts";
import { env } from "../../env";
import { MarketProviderError } from "./http";
import type {
  Comparables,
  DemandProvider,
  DemandSeries,
  PriceObservation,
  PricingProvider,
  SeriesPoint,
} from "./types";

/*
 * Deterministic mock market providers (AC1). Every value is seeded from a sha256 hash of the
 * query/ref: no `Math.random`, no wall clock other than `asOf`/`fetchedAt` (which just record
 * "when the mock ran", the way a real provider's would). Calling `series`/`comparables` twice
 * with the same input, in this process or another one, returns the same numbers, because the
 * hash of the same string is always the same bytes.
 */

function hashBytes(input: string): Buffer {
  return createHash("sha256").update(input).digest();
}

/** A deterministic unsigned integer from a string, `bytes` wide (default 4, i.e. 0..2^32-1). */
function hashInt(input: string, bytes = 4): number {
  const buf = hashBytes(input);
  let n = 0;
  for (let i = 0; i < bytes; i++) n = n * 256 + (buf[i] ?? 0);
  return n;
}

function requestKey(...parts: string[]): string {
  return hashBytes(parts.join("|")).toString("hex").slice(0, 16);
}

/** Throws when `source` is listed in `MARKET_MOCK_FAIL` (AC5; always empty in production). */
function checkMockFail(source: SignalSource) {
  if (env.marketMockFail.has(source)) {
    throw new MarketProviderError(source, `${source} mock is failing (MARKET_MOCK_FAIL)`);
  }
}

/*
 * Seasonal shapes (AC1): four seasonal peaks a DTF/apparel shop actually sees, plus a flat and a
 * declining shape so trend tests have both directions. Each is a multiplier by calendar month
 * (index 0 = January), relative to a flat baseline of 1.0; "declining" instead decays by how far
 * back the point is (independent of month), so it trends down over the whole series.
 */
export const MOCK_SEASONAL_SHAPES = [
  "q4_peak",
  "mothers_day",
  "back_to_school",
  "halloween",
  "flat",
  "declining",
] as const;
export type MockSeasonalShape = (typeof MOCK_SEASONAL_SHAPES)[number];

const MONTH_MULTIPLIER: Record<Exclude<MockSeasonalShape, "declining">, number[]> = {
  q4_peak: [0.7, 0.65, 0.7, 0.75, 0.8, 0.75, 0.8, 0.9, 1.0, 1.3, 1.7, 2.0],
  mothers_day: [0.7, 0.8, 1.1, 1.5, 2.0, 1.0, 0.7, 0.7, 0.7, 0.7, 0.9, 1.0],
  back_to_school: [0.7, 0.7, 0.7, 0.7, 0.8, 1.0, 1.6, 2.0, 1.2, 0.8, 0.8, 0.9],
  halloween: [0.7, 0.65, 0.65, 0.65, 0.65, 0.7, 0.75, 0.9, 1.3, 2.0, 0.9, 0.8],
  flat: Array<number>(12).fill(1.0),
};

function shapeFor(source: SignalSource, query: string): MockSeasonalShape {
  return (
    MOCK_SEASONAL_SHAPES[hashInt(`${source}:${query}:shape`) % MOCK_SEASONAL_SHAPES.length] ??
    "flat"
  );
}

function seasonalMultiplier(
  shape: MockSeasonalShape,
  monthIndex: number,
  chronoIndex: number,
  total: number,
) {
  if (shape === "declining") return Math.max(0.2, 1 - (chronoIndex / Math.max(1, total - 1)) * 0.8);
  return MONTH_MULTIPLIER[shape][monthIndex] ?? 1;
}

/** ISO 8601 week string ("2026-W38") for a UTC date, per the standard ISO week algorithm. */
function isoWeek(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

type Period = { period: string; monthIndex: number };

/** `count` periods ending at `end` (inclusive), oldest first. */
function periodsEnding(granularity: "week" | "month", count: number, end: Date): Period[] {
  const out: Period[] = [];
  if (granularity === "month") {
    const y = end.getUTCFullYear();
    const m = end.getUTCMonth();
    for (let i = count - 1; i >= 0; i--) {
      const d = new Date(Date.UTC(y, m - i, 1));
      out.push({
        period: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`,
        monthIndex: d.getUTCMonth(),
      });
    }
  } else {
    for (let i = count - 1; i >= 0; i--) {
      const d = new Date(end.getTime() - i * 7 * 86_400_000);
      out.push({ period: isoWeek(d), monthIndex: d.getUTCMonth() });
    }
  }
  return out;
}

/** One deterministic demand series for `query` from `source` (AC1). */
export function mockDemandSeries(
  source: SignalSource,
  licence: Licence,
  query: string,
  granularity: "week" | "month",
  years: number,
): DemandSeries {
  checkMockFail(source);
  const shape = shapeFor(source, query);
  const base = 20 + (hashInt(`${source}:${query}:base`) % 60);
  const count = Math.max(1, Math.round(years * (granularity === "month" ? 12 : 52)));
  const periods = periodsEnding(granularity, count, new Date());
  const points: SeriesPoint[] = periods.map((p, i) => {
    const mult = seasonalMultiplier(shape, p.monthIndex, i, periods.length);
    const noise = (hashInt(`${source}:${query}:${p.period}`) % 11) - 5;
    const value = Math.max(0, Math.min(100, Math.round(base * mult + noise)));
    return { period: p.period, value };
  });
  const now = new Date().toISOString();
  return {
    source,
    licence,
    query,
    geo: "US",
    granularity,
    scale: "relative_0_100",
    points,
    asOf: now,
    fetchedAt: now,
    requestKey: requestKey(source, query, granularity, String(years)),
    mock: true,
  };
}

/** A `DemandProvider` whose `series()` always returns `mockDemandSeries` for each query. */
export function mockDemandProvider(source: SignalSource, licence: Licence): DemandProvider {
  return {
    source,
    mock: true,
    async series({ queries, granularity, years }) {
      return queries.map((query) => mockDemandSeries(source, licence, query, granularity, years));
    },
  };
}

/**
 * A raw competitor offer, the shape a real Amazon/Walmart pricing response would carry (seller
 * name, listing title, a listing URL). `mockComparablesFor` builds these and then drops every
 * identifying field before returning `Comparables` (AC7): this type never leaves this file.
 */
type MockRawOffer = {
  sellerName: string;
  listingTitle: string;
  url: string;
  priceCents: number;
  isFeatured: boolean;
};

function mockRawOffers(source: SignalSource, ownRef: string, keywords: string[]): MockRawOffer[] {
  const n = 3 + (hashInt(`${source}:${ownRef}:count`) % 6); // 3..8 competitor offers
  const baseCents = 1200 + (hashInt(`${source}:${ownRef}:price`) % 2000); // $12.00..$32.00
  const keyword = keywords[0] ?? ownRef;
  return Array.from({ length: n }, (_, i) => {
    const seed = `${source}:${ownRef}:${i}`;
    const deltaCents = (hashInt(`${seed}:delta`) % 801) - 400; // +/- $4.00
    return {
      sellerName: `Sample Seller ${hashInt(`${seed}:seller`) % 9999}`,
      listingTitle: `${keyword} - sample competitor listing ${i + 1}`,
      url: `https://sample-marketplace.test/listing/${hashInt(seed)}`,
      priceCents: Math.max(100, baseCents + deltaCents),
      isFeatured: i === 0,
    };
  });
}

function mockComparablesFor(
  source: SignalSource,
  licence: Licence,
  channel: Channel,
  ownRef: string,
  keywords: string[],
): Comparables {
  checkMockFail(source);
  const offers = mockRawOffers(source, ownRef, keywords);
  const observations: PriceObservation[] = offers.map((o) => ({
    landedPriceCents: o.priceCents,
    isFeatured: o.isFeatured,
    offerCount: offers.length,
  }));
  const now = new Date().toISOString();
  return {
    source,
    licence,
    channel,
    ownRef,
    observations,
    asOf: now,
    fetchedAt: now,
    requestKey: requestKey(source, channel, ownRef),
    mock: true,
  };
}

/** A `PricingProvider` whose `comparables()` returns deterministic, identity-free comparables. */
export function mockPricingProvider(
  source: SignalSource,
  licence: Licence,
  channel: Channel,
): PricingProvider {
  return {
    source,
    mock: true,
    async comparables(_conn, own) {
      return own.map((o) => mockComparablesFor(source, licence, channel, o.ref, o.keywords));
    },
  };
}
