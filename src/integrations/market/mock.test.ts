import { afterEach, describe, expect, it } from "vitest";
import { env } from "../../env";
import { MarketProviderError } from "./http";
import {
  MOCK_SEASONAL_SHAPES,
  mockDemandProvider,
  mockDemandSeries,
  mockPricingProvider,
} from "./mock";

describe("mockDemandSeries (AC1: deterministic, seasonal)", () => {
  it("is identical for the same query, called twice, in this or another process", () => {
    const a = mockDemandSeries("google_trends", "official_api", "teacher shirt", "month", 2);
    const b = mockDemandSeries("google_trends", "official_api", "teacher shirt", "month", 2);
    // asOf/fetchedAt are wall-clock; everything else must match byte for byte.
    expect(a.points).toEqual(b.points);
    expect(a.requestKey).toBe(b.requestKey);
    expect(a.query).toBe("teacher shirt");
  });

  it("carries mock: true and full provenance on every result (AC6)", () => {
    const s = mockDemandSeries("pinterest_trends", "official_api", "dog mom", "week", 1);
    expect(s).toMatchObject({
      source: "pinterest_trends",
      licence: "official_api",
      mock: true,
    });
    expect(typeof s.asOf).toBe("string");
    expect(typeof s.fetchedAt).toBe("string");
    expect(typeof s.requestKey).toBe("string");
    expect(s.requestKey.length).toBeGreaterThan(0);
  });

  it("gives different queries different seasonal shapes, in both directions", () => {
    // Enough distinct queries that, by pigeonhole, more than one of the six shapes appears,
    // including at least one that trends down over the series (declining, or the trough side of
    // a seasonal shape) and one that trends up.
    const queries = Array.from({ length: 40 }, (_, i) => `taxonomy-query-${i}`);
    const seriesList = queries.map((q) =>
      mockDemandSeries("census", "public_dataset", q, "month", 3),
    );
    const deltas = seriesList.map((s) => (s.points.at(-1)?.value ?? 0) - (s.points[0]?.value ?? 0));
    expect(deltas.some((d) => d > 0)).toBe(true);
    expect(deltas.some((d) => d < 0)).toBe(true);
    // Every point stays a valid relative_0_100 value.
    for (const s of seriesList) for (const p of s.points) expect(p.value).toBeGreaterThanOrEqual(0);
    for (const s of seriesList) for (const p of s.points) expect(p.value).toBeLessThanOrEqual(100);
  });

  it("has a Q4 peak, a Mother's Day peak, a back-to-school peak, a Halloween peak, a flat and a declining shape available", () => {
    expect(MOCK_SEASONAL_SHAPES).toEqual([
      "q4_peak",
      "mothers_day",
      "back_to_school",
      "halloween",
      "flat",
      "declining",
    ]);
  });

  it("weekly granularity produces about 52 points per year", () => {
    const s = mockDemandSeries("google_trends", "official_api", "halloween shirt", "week", 1);
    expect(s.points.length).toBe(52);
    expect(s.points[0]?.period).toMatch(/^\d{4}-W\d{2}$/);
  });
});

describe("mockDemandProvider", () => {
  it("returns one series per query, all mock: true", async () => {
    const provider = mockDemandProvider("jungle_scout", "licensed");
    expect(provider.mock).toBe(true);
    expect(provider.source).toBe("jungle_scout");
    const series = await provider.series({ queries: ["a", "b"], granularity: "month", years: 1 });
    expect(series).toHaveLength(2);
    expect(series.every((s) => s.mock)).toBe(true);
  });
});

describe("mockPricingProvider (AC7: no other seller's identity leaves the provider)", () => {
  const conn = { id: "conn-1", companyId: "company-1", channel: "amazon" as const, cursor: null };

  it("returns only price, featured flag and offer count -- never a seller name, title or URL", async () => {
    const provider = mockPricingProvider("amazon_pricing", "official_api", "amazon");
    const [comparables] = await provider.comparables(conn, [
      { ref: "B000TEST1", keywords: ["teacher shirt"], garmentClass: "t-shirt" },
    ]);
    expect(comparables).toBeDefined();
    expect(comparables?.observations.length).toBeGreaterThan(0);
    for (const obs of comparables?.observations ?? []) {
      expect(Object.keys(obs).sort()).toEqual(
        ["isFeatured", "landedPriceCents", "offerCount"].sort(),
      );
    }
    const asText = JSON.stringify(comparables);
    expect(asText).not.toMatch(/Sample Seller|sample competitor listing|sample-marketplace\.test/);
  });

  it("is deterministic for the same ref, called twice", async () => {
    const provider = mockPricingProvider("walmart_pricing", "official_api", "walmart");
    const own = [{ ref: "ITEM-1", keywords: ["dog mom shirt"], garmentClass: "t-shirt" }];
    const [first] = await provider.comparables(conn, own);
    const [second] = await provider.comparables(conn, own);
    expect(first).toEqual(second);
  });
});

describe("MARKET_MOCK_FAIL (AC5: outage switch)", () => {
  afterEach(() => {
    env.marketMockFail.clear();
  });

  it("makes only the listed source's mock throw a typed provider error", async () => {
    env.marketMockFail.add("google_trends");
    expect(() => mockDemandSeries("google_trends", "official_api", "x", "month", 1)).toThrow(
      MarketProviderError,
    );
    // Every other source keeps working.
    expect(() =>
      mockDemandSeries("pinterest_trends", "official_api", "x", "month", 1),
    ).not.toThrow();
  });
});
