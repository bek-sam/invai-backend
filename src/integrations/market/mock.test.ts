import { Timestamp } from "@invai/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { env } from "../../env";
import { NICHES } from "../../modules/market/niches";
import { MarketProviderError } from "./http";
import {
  MOCK_TREND_SHAPES,
  mockDemandProvider,
  mockDemandSeries,
  mockPricingProvider,
  THIN_TEST_SUFFIX,
} from "./mock";

/** The value of `query`'s series for calendar month `"YYYY-MM"`, within its last 3 years. */
function monthlyValue(query: string, ymPeriod: string): number {
  const s = mockDemandSeries("google_trends", "official_api", query, "month", 3);
  return s.points.find((p) => p.period === ymPeriod)?.value ?? Number.NaN;
}

describe("mockDemandSeries (AC1: deterministic)", () => {
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

  it("weekly granularity produces about 52 points per year", () => {
    const s = mockDemandSeries("google_trends", "official_api", "halloween shirt", "week", 1);
    expect(s.points.length).toBe(52);
    expect(s.points[0]?.period).toMatch(/^\d{4}-W\d{2}$/);
  });
});

describe("mockDemandSeries seasonal shapes follow the real taxonomy niche (round 2b, cross-card finding)", () => {
  // Every value stays a valid relative_0_100 point, seasonal or not.
  it("every seasonal and non-seasonal query stays within 0..100", () => {
    for (const n of NICHES) {
      for (const q of n.queries) {
        const s = mockDemandSeries("google_trends", "official_api", q, "month", 3);
        for (const p of s.points) {
          expect(p.value).toBeGreaterThanOrEqual(0);
          expect(p.value).toBeLessThanOrEqual(100);
        }
      }
    }
  });

  // 2025 dates: always inside the 3-year window ending at "now", whatever "now" is (unlike a
  // 2026 date, which may not exist yet -- `mockDemandSeries` never generates a future period).
  it("'halloween shirt' (peakMonths [9, 10]) peaks in October, clearly above September and July", () => {
    const oct = monthlyValue("halloween shirt", "2025-10");
    const sep = monthlyValue("halloween shirt", "2025-09");
    const jul = monthlyValue("halloween shirt", "2025-07");
    expect(oct).toBeGreaterThan(sep);
    expect(oct).toBeGreaterThan(jul * 1.5);
  });

  it("'christmas shirt' (peakMonths [11, 12]) peaks in December, clearly above November and June", () => {
    const dec = monthlyValue("christmas shirt", "2025-12");
    const nov = monthlyValue("christmas shirt", "2025-11");
    const jun = monthlyValue("christmas shirt", "2025-06");
    expect(dec).toBeGreaterThan(nov);
    expect(dec).toBeGreaterThan(jun * 1.5);
  });

  it("'mothers day shirt' (peakMonths [4, 5]) peaks in May, clearly above April and November", () => {
    const may = monthlyValue("mothers day shirt", "2025-05");
    const apr = monthlyValue("mothers day shirt", "2025-04");
    const nov = monthlyValue("mothers day shirt", "2025-11");
    expect(may).toBeGreaterThan(apr);
    expect(may).toBeGreaterThan(nov * 1.5);
  });

  it("'back to school shirt' (peakMonths [7, 8]) peaks in August, clearly above July and February", () => {
    const aug = monthlyValue("back to school shirt", "2025-08");
    const jul = monthlyValue("back to school shirt", "2025-07");
    const feb = monthlyValue("back to school shirt", "2025-02");
    expect(aug).toBeGreaterThan(jul);
    expect(aug).toBeGreaterThan(feb * 1.5);
  });

  it("a niche with two distant peaks ('teacher', May and August) shows both, with August (the last-listed, primary) higher than May", () => {
    const aug = monthlyValue("teacher shirt", "2025-08");
    const may = monthlyValue("teacher shirt", "2025-05");
    const feb = monthlyValue("teacher shirt", "2025-02");
    expect(aug).toBeGreaterThan(may);
    expect(may).toBeGreaterThan(feb); // May is still a real, elevated secondary peak, not flat baseline
  });
});

describe("mockDemandSeries trend (round 2b): non-seasonal queries rise, fall or stay flat, by hash", () => {
  it("MOCK_TREND_SHAPES has a rising, a falling and a flat direction", () => {
    expect(MOCK_TREND_SHAPES).toEqual(["rising", "falling", "flat"]);
  });

  /** The spec's own trend metric (research 14 / `signals.ts`'s g4): last value vs. 4 weeks
   * earlier, as a fraction, on one query's own series. Individual queries sit on a small
   * (1-5 / 95-99) anchor so a multi-year series doesn't saturate before reaching "now" (see
   * `TREND_WINDOW`'s comment in mock.ts); that leaves single-query values noise-sensitive, so
   * `nicheAverageG4` below -- which is what `src/modules/market/compute.ts`'s `nicheSeries`
   * actually reads -- is the metric that matters and the one this suite asserts against. */
  function g4(query: string): number {
    const s = mockDemandSeries("google_trends", "official_api", query, "week", 1);
    const last = s.points.at(-1)?.value ?? 0;
    const fourWeeksAgo = s.points.at(-5)?.value ?? 0;
    return fourWeeksAgo === 0 ? 0 : last / fourWeeksAgo - 1;
  }

  /** The mean of a niche's queries per week (mirrors `nicheSeries` in
   * `src/modules/market/compute.ts`, which averages a niche's queries per source and ISO week). */
  function nicheAverageG4(nicheKey: string): number {
    const niche = NICHES.find((n) => n.key === nicheKey);
    const seriesList = (niche?.queries ?? []).map((q) =>
      mockDemandSeries("google_trends", "official_api", q, "week", 1),
    );
    const n = seriesList[0]?.points.length ?? 0;
    const avgAt = (i: number) =>
      seriesList.reduce((sum, s) => sum + (s.points[i]?.value ?? 0), 0) / seriesList.length;
    return avgAt(n - 1) / avgAt(n - 5) - 1;
  }

  // Documented, deterministic examples: real taxonomy niches with no seasonal prior, hashed
  // against "google_trends", whose niche average clears the +-15%/4-week bound with a wide
  // margin (round 2b second pass: `police` and `firefighter` also survive T-18-3's own
  // `fitTrend`/`seasonalityIndex` deseasonalization, verified against the live pipeline -- see
  // the round's report).
  it("the 'police' niche average clears the spec's +15%/4-week 'rising' bound", () => {
    const police = NICHES.find((n) => n.key === "police");
    expect(police?.peakMonths).toEqual([]);
    expect(nicheAverageG4("police")).toBeGreaterThanOrEqual(0.15);
  });

  it("the 'firefighter' niche average clears the spec's -15%/4-week 'falling' bound", () => {
    const firefighter = NICHES.find((n) => n.key === "firefighter");
    expect(firefighter?.peakMonths).toEqual([]);
    expect(nicheAverageG4("firefighter")).toBeLessThanOrEqual(-0.15);
  });

  it("a deterministic mix of non-taxonomy queries also rises and falls (arbitrary strings fall back to the same trend buckets)", () => {
    const queries = Array.from({ length: 40 }, (_, i) => `taxonomy-query-${i}`);
    const deltas = queries.map((q) => g4(q));
    expect(deltas.some((d) => d >= 0.15)).toBe(true);
    expect(deltas.some((d) => d <= -0.15)).toBe(true);
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

  it("returns only price, featured flag, offer count, personalized and garment class -- never a seller name, title or URL", async () => {
    const provider = mockPricingProvider("amazon_pricing", "official_api", "amazon");
    const [comparables] = await provider.comparables(conn, [
      { ref: "B000TEST1", keywords: ["teacher shirt"], garmentClass: "tee", personalized: false },
    ]);
    expect(comparables).toBeDefined();
    expect(comparables?.observations.length).toBeGreaterThan(0);
    for (const obs of comparables?.observations ?? []) {
      expect(Object.keys(obs).sort()).toEqual(
        ["garmentClass", "isFeatured", "landedPriceCents", "offerCount", "personalized"].sort(),
      );
    }
    const asText = JSON.stringify(comparables);
    expect(asText).not.toMatch(/Sample Seller|sample competitor listing|sample-marketplace\.test/);
  });

  it("is deterministic for the same ref, called twice (compares observations and requestKey, not the wall-clock asOf/fetchedAt)", async () => {
    const provider = mockPricingProvider("walmart_pricing", "official_api", "walmart");
    const own = [
      { ref: "ITEM-1", keywords: ["dog mom shirt"], garmentClass: "tee", personalized: false },
    ];
    const [first] = await provider.comparables(conn, own);
    const [second] = await provider.comparables(conn, own);
    expect(first?.observations).toEqual(second?.observations);
    expect(first?.requestKey).toBe(second?.requestKey);
  });
});

describe("mockPricingProvider comparable counts (QA finding: spec minimum n = 8)", () => {
  const conn = { id: "conn-1", companyId: "company-1", channel: "amazon" as const, cursor: null };
  const provider = mockPricingProvider("amazon_pricing", "official_api", "amazon");

  /** The observations that would survive `filterComparables`'s price-range + personalization
   * match (its IQR outlier trim never removes one here: every matching offer sits within a
   * tight $2 band, see mock.ts). Reimplemented here, not imported, since `src/modules/market` is
   * outside this card's owned/read-only paths. */
  const matching = (
    observations: { landedPriceCents: number; personalized: boolean }[],
    p: boolean,
  ) =>
    observations.filter(
      (o) => o.personalized === p && o.landedPriceCents >= 500 && o.landedPriceCents <= 8000,
    );

  it("a normal ref lands in the spec's 10-24 window after filtering, for either personalization value", async () => {
    for (const ref of ["B0NORMAL1", "ITEM-NORMAL-2", "SKU-42"]) {
      for (const personalized of [true, false]) {
        const [comparables] = await provider.comparables(conn, [
          { ref, keywords: ["teacher shirt"], garmentClass: "tee", personalized },
        ]);
        const kept = matching(comparables?.observations ?? [], personalized);
        expect(kept.length).toBeGreaterThanOrEqual(10);
        expect(kept.length).toBeLessThanOrEqual(24);
      }
    }
  });

  it("an ownRef ending in the documented thin-test suffix always stays below the spec minimum n = 8", async () => {
    for (const personalized of [true, false]) {
      const ref = `B0ANYTHING${THIN_TEST_SUFFIX}`;
      const [comparables] = await provider.comparables(conn, [
        { ref, keywords: ["teacher shirt"], garmentClass: "tee", personalized },
      ]);
      const kept = matching(comparables?.observations ?? [], personalized);
      expect(kept.length).toBeLessThan(8);
    }
  });

  it("mixes personalized and non-personalized offers, so the AC19 filter actually drops some (a personalized design keeps only personalized comparables)", async () => {
    const [comparables] = await provider.comparables(conn, [
      { ref: "B0MIXED1", keywords: ["dog mom shirt"], garmentClass: "tee", personalized: true },
    ]);
    const observations = comparables?.observations ?? [];
    const personalizedCount = observations.filter((o) => o.personalized).length;
    const notPersonalizedCount = observations.filter((o) => !o.personalized).length;
    expect(personalizedCount).toBeGreaterThan(0);
    expect(notPersonalizedCount).toBeGreaterThan(0);
    // The design asked as personalized: true, so its own matching group is the personalized one.
    expect(personalizedCount).toBeGreaterThanOrEqual(10);
  });

  it("mixes garment classes too, so a 'same garment class' filter would also drop some (round 2, QA finding)", async () => {
    const [comparables] = await provider.comparables(conn, [
      { ref: "B0GC1", keywords: ["dog mom shirt"], garmentClass: "hoodie", personalized: false },
    ]);
    const observations = comparables?.observations ?? [];
    const matchingClass = observations.filter((o) => o.garmentClass === "hoodie").length;
    const otherClass = observations.filter((o) => o.garmentClass !== "hoodie").length;
    expect(matchingClass).toBeGreaterThan(0);
    expect(otherClass).toBeGreaterThan(0);
    // The requested garment class is "hoodie", so its own matching group carries it.
    expect(matchingClass).toBeGreaterThanOrEqual(10);
    // Every "other class" offer is a genuinely different class, not luck.
    for (const o of observations)
      if (o.garmentClass !== "hoodie") expect(o.garmentClass).toBe("sweatshirt");
  });
});

describe("asOf is one ISO-datetime format for every provider (AC6, reviewer finding 3)", () => {
  it("a monthly mock series' asOf parses as a Timestamp", () => {
    const s = mockDemandSeries("google_trends", "official_api", "teacher shirt", "month", 1);
    expect(() => Timestamp.parse(s.asOf)).not.toThrow();
  });

  it("a weekly mock series' asOf parses as a Timestamp", () => {
    const s = mockDemandSeries("pinterest_trends", "official_api", "dog mom", "week", 1);
    expect(() => Timestamp.parse(s.asOf)).not.toThrow();
  });

  it("asOf is the end of the last point's period, not the call time", () => {
    const s = mockDemandSeries("jungle_scout", "licensed", "family reunion shirt", "month", 1);
    const lastPeriod = s.points.at(-1)?.period ?? "";
    // "2026-09" -> asOf falls in September 2026, at its last instant (>= the 30th).
    expect(s.asOf.startsWith(lastPeriod)).toBe(true);
    expect(new Date(s.asOf).getUTCDate()).toBeGreaterThanOrEqual(28);
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
