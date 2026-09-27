import { describe, expect, it } from "vitest";
import { agreement, band, combine, freshness, isStale, sampleFactor } from "./confidence";
import { designTokens, mapDesign, stemMatches, stemNiches } from "./mapper";
import { CANONICAL_QUERIES, NICHES, nicheLabel } from "./niches";
import { type DesignFacts, designRules, type NicheFacts, nicheRules, type Scored } from "./rules";
import {
  actBy,
  breakEvenCents,
  type CostBasis,
  candidatePrices,
  completeWeeks,
  filterComparables,
  fitTrend,
  floorPriceCents,
  isoWeekOf,
  leadTimeWeeks,
  marginPctAt,
  netAt,
  pricePercentile,
  priceResponse,
  priceStats,
  quantile,
  roundToEnding,
  seasonalityIndex,
  terciles,
  weeklyToMonthly,
  yearOverYear,
} from "./signals";

/* Pure engine tests on fixed series (spec steps 2–5). No database, no SQL. */

describe("taxonomy data file", () => {
  it("has the 69 niches of product/market-niches.md with en/es labels and 3–5 queries", () => {
    expect(NICHES.length).toBe(69);
    expect(new Set(NICHES.map((n) => n.key)).size).toBe(69);
    for (const n of NICHES) {
      expect(n.labelEn && n.labelEs).toBeTruthy();
      expect(n.queries.length).toBeGreaterThanOrEqual(3);
      expect(n.queries.length).toBeLessThanOrEqual(5);
    }
    expect(nicheLabel("teacher", "es")).toBe("Maestros");
    expect(nicheLabel("nope", "en")).toBe("nope");
    expect(CANONICAL_QUERIES.has("teacher shirt")).toBe(true);
  });
});

describe("calendar", () => {
  it("ISO weeks: 2026-09-15 is W38, 2021-01-03 is 2020-W53", () => {
    expect(isoWeekOf("2026-09-15")).toBe("2026-W38");
    expect(isoWeekOf("2021-01-03")).toBe("2020-W53");
  });

  it("complete weeks stop before the local week in progress (shop time zone)", () => {
    // 2026-09-14 03:00 UTC is still Sunday 13th in Phoenix: the last complete week is W36.
    const w = completeWeeks(new Date("2026-09-14T03:00:00Z"), "America/Phoenix", 3);
    expect(w.map((x) => x.key)).toEqual(["2026-W34", "2026-W35", "2026-W36"]);
    const utc = completeWeeks(new Date("2026-09-14T03:00:00Z"), "UTC", 1);
    expect(utc[0]?.key).toBe("2026-W37");
  });
});

describe("trend (OLS on ln(y+1))", () => {
  it("flat sales read flat", () => {
    const t = fitTrend(Array(30).fill(3));
    expect(t.trend).toBe("flat");
    expect(t.windowWeeks).toBe(26);
    expect(t.g4).toBeCloseTo(0, 9);
  });

  it("+6% a week reads rising (g4 ≈ 26%), −6% reads falling", () => {
    const up = fitTrend(Array.from({ length: 26 }, (_, i) => 100 * 1.06 ** i));
    expect(up.trend).toBe("rising");
    expect(up.g4).toBeGreaterThan(0.2);
    const down = fitTrend(Array.from({ length: 26 }, (_, i) => 100 * 0.94 ** i));
    expect(down.trend).toBe("falling");
  });

  it("a young design (< 26 weeks) uses a 13-week window", () => {
    expect(fitTrend(Array(20).fill(4), { ageWeeks: 20 }).windowWeeks).toBe(13);
  });

  it("fewer than 13 points or mostly zero is insufficient, with the reason", () => {
    expect(fitTrend(Array(10).fill(5)).insufficientReason).toBe("too_few_points");
    const sparse = Array.from({ length: 26 }, (_, i) => (i % 3 === 0 ? 5 : 0));
    expect(fitTrend(sparse).insufficientReason).toBe("mostly_zero");
  });

  it("out-of-stock weeks (null) are dropped from the fit, not read as a demand drop", () => {
    const series: (number | null)[] = Array(26).fill(10);
    series[23] = null;
    series[24] = null;
    series[25] = null;
    const t = fitTrend(series);
    expect(t.windowPoints).toBe(23);
    expect(t.trend).toBe("flat");
  });

  it("deseasonalizes by the index: a seasonal ramp with a matching index is flat", () => {
    const si = Array.from({ length: 26 }, (_, i) => 1 + i * 0.1);
    const y = si.map((s) => 20 * s);
    expect(fitTrend(y).trend).toBe("rising");
    expect(fitTrend(y, { si }).trend).toBe("flat");
  });
});

describe("year over year", () => {
  it("last 4 weeks ÷ the same 4 weeks a year earlier − 1, only with ≥ 56 weeks and a big enough base", () => {
    const s = Array(60).fill(3);
    for (let i = 56; i < 60; i++) s[i] = 6;
    expect(yearOverYear(s, 10)).toBeCloseTo(1, 9);
    expect(yearOverYear(Array(55).fill(3), 10)).toBeNull();
    expect(yearOverYear(Array(60).fill(2), 10)).toBeNull(); // 8 units last year < 10
  });
});

describe("seasonality index and act-by", () => {
  const halloween = [0.7, 0.65, 0.65, 0.65, 0.65, 0.7, 0.75, 0.9, 1.3, 2.0, 0.9, 0.8];
  const months = (years: number) =>
    Array.from({ length: years * 12 }, (_, i) => ({
      period: `${2023 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`,
      value: 50 * (halloween[i % 12] ?? 1),
    }));

  it("needs 2 full years; peaks ≥ 1.3, off months ≤ 0.8", () => {
    expect(seasonalityIndex(months(1))).toBeNull();
    const si = seasonalityIndex(months(3));
    expect(si?.yearsUsed).toBe(3);
    expect(si?.peakMonths).toEqual([9, 10]);
    expect(si?.offMonths).toContain(3);
    const oct = si?.index.find((x) => x.month === 10)?.index ?? 0;
    expect(oct).toBeCloseTo(2 / (halloween.reduce((a, b) => a + b, 0) / 12), 3);
  });

  it("weekly points roll up to monthly means by each week's Thursday", () => {
    const m = weeklyToMonthly([
      { period: "2026-W36", value: 10 },
      { period: "2026-W37", value: 20 },
      { period: "2026-W01", value: 7 },
    ]);
    expect(m.find((x) => x.period === "2026-09")?.value).toBe(15);
    expect(m.find((x) => x.period === "2026-01")?.value).toBe(7);
  });

  it("lead time is the median paid→shipped hours rounded up to weeks + 3 (48 h → 4)", () => {
    expect(leadTimeWeeks(48)).toBe(4);
    expect(leadTimeWeeks(200)).toBe(5);
    expect(leadTimeWeeks(null)).toBe(4);
  });

  it("act-by = first day of the next peak month − lead time; act now inside 2 weeks of it", () => {
    const now = new Date("2026-09-01T16:00:00Z");
    const a = actBy(now, [10], 4, "UTC");
    expect(a).toMatchObject({ date: "2026-09-03", peakMonth: 10, leadTimeWeeks: 4 });
    expect(a?.weeksToPeak).toBeCloseTo(30 / 7, 3);
    expect(a?.actNow).toBe(true);
    const far = actBy(now, [12], 4, "UTC");
    expect(far?.actNow).toBe(false);
    expect(actBy(now, [], 4, "UTC")).toBeNull();
  });
});

describe("price position", () => {
  const obs = (cents: number[], personalized?: boolean) =>
    cents.map((c) => ({ landedPriceCents: c, isFeatured: false, offerCount: 5, personalized }));

  it("percentile = (#below + 0.5·#equal) ÷ n; bands at 0.25 / 0.75", () => {
    const prices = [1000, 1500, 2000, 2000, 2500, 3000, 3500, 4000];
    // 2 below, 2 equal: (2 + 0.5 × 2) / 8 = 0.375
    expect(pricePercentile(prices, 2000)).toEqual({ percentile: 0.375, band: "market" });
    expect(pricePercentile(prices, 1200).band).toBe("low");
    expect(pricePercentile(prices, 3900).band).toBe("premium");
  });

  it("filters to $5–$80, the same personalization flag, and drops IQR outliers", () => {
    const kept = filterComparables(
      [...obs([400, 9000, 2000, 2100, 2200, 2300, 2400, 2500, 2600, 9900]), ...obs([2000], true)],
      false,
    );
    expect(kept.map((o) => o.landedPriceCents)).toEqual([2000, 2100, 2200, 2300, 2400, 2500, 2600]);
    expect(filterComparables(obs([2000, 2100]), true)).toEqual([]);
    const withOutlier = filterComparables(obs([2000, 2050, 2100, 2150, 2200, 7900]), false);
    expect(withOutlier.map((o) => o.landedPriceCents)).not.toContain(7900);
  });

  it("stats: quartiles by linear interpolation", () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(priceStats(obs([1000, 2000, 3000, 4000, 5000]))).toMatchObject({
      n: 5,
      q1Cents: 2000,
      medianCents: 3000,
      q3Cents: 4000,
    });
  });

  it("density terciles", () => {
    const t = terciles(
      new Map([
        ["a", 1],
        ["b", 5],
        ["c", 9],
      ]),
    );
    expect([t.get("a"), t.get("b"), t.get("c")]).toEqual(["less_crowded", "typical", "crowded"]);
  });
});

describe("margin at price (hand calculation)", () => {
  // Fixture: $2.00 shipping charged per unit, unit cost $12.10, ads $2.00 a unit, 2% refunds,
  // fees 9.5% of (price + shipping) + 45¢.
  const basis: CostBasis = {
    shippingChargedCents: 200,
    unitCostCents: 1210,
    adsPerUnitCents: 200,
    refundRate: 0.02,
    fees: (p) => Math.round((p + 200) * 0.095) + 45,
  };

  it("net(p) and margin % match the hand calculation", () => {
    // p = 2499: fees = round(2699 × 0.095) + 45 = 256 + 45 = 301; refunds 0.02 × 2499 = 49.98
    // net = 2499 + 200 − 301 − 1210 − 200 − 49.98 = 938.02 → 938
    expect(netAt(2499, basis)).toBe(938);
    expect(marginPctAt(2499, basis)).toBeCloseTo((938 / 2699) * 100, 3);
    // p = 2749 (p0 × 1.10): fees = round(2949 × 0.095) + 45 = 280 + 45 = 325; refunds 54.98
    // net = 2749 + 200 − 325 − 1210 − 200 − 54.98 = 1159.02 → 1159
    expect(netAt(2749, basis)).toBe(1159);
  });

  it("break-even and the 15% floor on the 5¢ grid, rounded up to the shop's ending", () => {
    const be = breakEvenCents(basis);
    expect(be).not.toBeNull();
    expect(netAt(be as number, basis)).toBeGreaterThanOrEqual(0);
    expect(netAt((be as number) - 5, basis)).toBeLessThan(0);
    const floor = floorPriceCents(basis, "99", 15) as number;
    expect(floor % 100).toBe(99);
    expect(marginPctAt(floor, basis)).toBeGreaterThanOrEqual(15);
    expect(marginPctAt(floor - 100, basis)).toBeLessThan(15);
  });

  it("rounds to .99 / .00 / the 5¢ grid", () => {
    expect(roundToEnding(2624, "99")).toBe(2599);
    expect(roundToEnding(2680, "99")).toBe(2699);
    expect(roundToEnding(2624, "99", "up")).toBe(2699);
    expect(roundToEnding(2640, "00")).toBe(2600);
    expect(roundToEnding(2642, "grid")).toBe(2640);
  });

  it("candidates: current, ±5/10% at the ending, comparables' quartiles, requested as given", () => {
    const c = candidatePrices({
      currentCents: 2499,
      requested: [2749],
      comparables: { q1Cents: 1990, medianCents: 2310, q3Cents: 2890 },
    });
    expect(c.map((x) => x.priceCents)).toEqual([
      1999, 2199, 2299, 2399, 2499, 2599, 2699, 2749, 2899,
    ]);
    expect(c.find((x) => x.priceCents === 2749)?.origin).toBe("requested");
    expect(c.find((x) => x.priceCents === 2499)?.origin).toBe("current");
    expect(c.length).toBeLessThanOrEqual(20);
  });

  it("price response only with ≥ 2 price points of ≥ 30 units; clamped to [−4, 0]", () => {
    expect(priceResponse([{ priceCents: 2000, units: 100, weeks: 10 }])).toBeNull();
    expect(
      priceResponse([
        { priceCents: 2000, units: 100, weeks: 10 },
        { priceCents: 2200, units: 20, weeks: 10 },
      ]),
    ).toBeNull();
    const e = priceResponse([
      { priceCents: 2000, units: 100, weeks: 10 },
      { priceCents: 2200, units: 80, weeks: 10 },
    ]);
    // dq = (8 − 10) / 9 = −0.2222; dp = 200 / 2100 = 0.0952 → ε = −2.333
    expect(e?.elasticity).toBeCloseTo(-2.3333, 3);
    const steep = priceResponse([
      { priceCents: 2000, units: 100, weeks: 10 },
      { priceCents: 2020, units: 30, weeks: 10 },
    ]);
    expect(steep?.elasticity).toBe(-4);
  });
});

describe("confidence", () => {
  it("s·f·r·a with bands at 0.70 / 0.40", () => {
    expect(sampleFactor(13, 26)).toBe(0.5);
    expect(freshness("own", new Date("2026-09-01"), new Date("2026-09-08"))).toBeCloseTo(0.5, 9);
    expect(combine({ s: 1, f: 1, r: 0.8, a: 1 })).toBe(0.8);
    expect(band(0.7)).toBe("high");
    expect(band(0.69)).toBe("medium");
    expect(band(0.39)).toBe("low");
  });

  it("stale after 2× the source TTL (Census 30 days, own 7)", () => {
    const at = new Date("2026-09-01T00:00:00Z");
    expect(isStale("census", at, new Date("2026-10-30T00:00:00Z"))).toBe(false);
    expect(isStale("census", at, new Date("2026-11-01T00:00:00Z"))).toBe(true);
    expect(isStale("own", at, new Date("2026-09-16T00:00:00Z"))).toBe(true);
  });

  it("agreement: 1.0 agree, 0.7 single, 0.4 disagree (flagged)", () => {
    expect(agreement(["rising", "rising"])).toEqual({ a: 1, disagreement: false });
    expect(agreement(["rising", "insufficient"])).toEqual({ a: 0.7, disagreement: false });
    expect(agreement(["rising", "falling", "rising"])).toEqual({ a: 0.4, disagreement: true });
  });
});

describe("niche mapper", () => {
  it("stems: short stems match whole tokens, long stems prefixes, accents stripped", () => {
    expect(stemMatches("mom", "mom")).toBe(true);
    expect(stemMatches("mom", "moment")).toBe(false);
    expect(stemMatches("teach", "teachers")).toBe(true);
    expect(designTokens("Maestría Día", ["dog mom"])).toEqual(
      new Set(["maestria", "dia", "maestriadia", "dog", "mom", "dogmom"]),
    );
  });

  it("keeps the 2 niches with the most matched stems", () => {
    expect(stemNiches("Best Teacher Ever", ["teacher", "classroom"])).toEqual(["teacher"]);
    const dm = stemNiches("Dog Mom Life", ["dog mom", "fur mama"]);
    expect(dm[0]).toBe("dog-mom");
    expect(dm.length).toBeLessThanOrEqual(2);
    expect(stemNiches("Spooky Pumpkin Ghost", ["halloween"])).toContain("halloween");
  });

  it("falls back to the model only at ≥ 0.7; no credits (null) leaves it unclassified", async () => {
    const d = { id: "d1", name: "Zorbnak Quux", tags: ["zorbnak"] };
    expect(await mapDesign(d, async () => ({ niche: "gaming", confidence: 0.82 }))).toEqual({
      niches: ["gaming"],
      source: "model",
      confidence: 0.82,
    });
    expect((await mapDesign(d, async () => ({ niche: "gaming", confidence: 0.6 }))).source).toBe(
      "unclassified",
    );
    expect((await mapDesign(d, async () => null)).source).toBe("unclassified");
    expect(
      (await mapDesign(d, async () => ({ niche: "made-up", confidence: 0.9 }))).niches,
    ).toEqual([]);
    expect((await mapDesign(d, null)).source).toBe("unclassified");
  });
});

/* ---------------------------------- rules ---------------------------------- */

const src = (source: "own" | "amazon_pricing" | "google_trends", mock = false) => ({
  source,
  licence: source === "own" ? ("first_party" as const) : ("official_api" as const),
  asOf: "2026-09-01T00:00:00.000Z",
  fetchedAt: "2026-09-01T00:00:00.000Z",
  mock,
});
const scored = (confidence: number, s = src("own")): Scored => ({
  confidence,
  band: band(confidence),
  sources: [s],
  signalIds: ["00000000-0000-4000-8000-000000000001"],
});

function facts(over: Partial<DesignFacts> = {}, conf = 0.8): DesignFacts {
  return {
    designId: "11111111-1111-4111-8111-111111111111",
    designName: "Spooky Pumpkin Ghost",
    connectedChannels: ["etsy", "amazon"],
    listedChannels: ["etsy"],
    blank: {
      id: "22222222-2222-4222-8222-222222222222",
      name: "Gildan G640 Softstyle",
      belowReorderPoint: true,
    },
    season: {
      ...scored(conf),
      peakMonths: [10],
      offMonths: [3],
      actBy: {
        date: "2026-09-03",
        peakMonth: 10,
        weeksToPeak: 4.3,
        leadTimeWeeks: 4,
        actNow: true,
      },
      expectedUnits: null,
    },
    ownTrend: { ...scored(conf), trend: "flat" },
    channels: [
      {
        channel: "amazon",
        currentPriceCents: 1299,
        margin: { ...scored(conf), marginPct: 19, floorPriceCents: 1399 },
        price: {
          ...scored(conf, src("amazon_pricing", true)),
          priceBand: "low",
          n: 12,
          medianCents: 1799,
        },
      },
    ],
    currentMonth: 9,
    ...over,
  };
}

describe("rules R1–R5", () => {
  it("R1 names the missing channel and the blank below its reorder point", () => {
    const r1 = designRules(facts()).find((r) => r.rule === "R1");
    expect(r1?.action).toBe("list_and_stock");
    expect(r1?.params.channels).toEqual(["amazon"]);
    expect(r1?.params.blankBelowReorderPoint).toBe(true);
    expect(r1?.params.actByDate).toBe("2026-09-03");
  });

  it("R2 tests p0 × 1.05..1.10 capped at the comparables' median; mock comparables flag it", () => {
    const r2 = designRules(facts()).find((r) => r.rule === "R2");
    expect(r2?.params).toMatchObject({
      testPriceMinCents: 1364,
      testPriceMaxCents: 1429,
      channel: "amazon",
    });
    expect(r2?.mock).toBe(true);
    const capped = designRules(
      facts({
        channels: [
          {
            ...facts().channels[0],
            price: { ...scored(0.8), priceBand: "low", n: 12, medianCents: 1400 },
          } as DesignFacts["channels"][number],
        ],
      }),
    ).find((r) => r.rule === "R2");
    expect(capped?.params.testPriceMaxCents).toBe(1400);
    expect(
      designRules(facts({ ownTrend: { ...scored(0.8), trend: "falling" } })).some(
        (r) => r.rule === "R2",
      ),
    ).toBe(false);
  });

  it("R3 fires below 15% margin with the floor price", () => {
    const f = facts();
    const ch = f.channels[0] as DesignFacts["channels"][number];
    const r3 = designRules({
      ...f,
      channels: [{ ...ch, margin: { ...scored(0.8), marginPct: 12, floorPriceCents: 1499 } }],
    }).find((r) => r.rule === "R3");
    expect(r3?.params).toMatchObject({ floorPriceCents: 1499, marginPct: 12 });
  });

  it("R5: own trend falling at high confidence, off-season, margin < 15%", () => {
    const f = facts({ currentMonth: 3, ownTrend: { ...scored(0.9), trend: "falling" } });
    const ch = f.channels[0] as DesignFacts["channels"][number];
    const r5 = designRules({
      ...f,
      channels: [{ ...ch, margin: { ...scored(0.9), marginPct: 10, floorPriceCents: 1499 } }],
    }).find((r) => r.rule === "R5");
    expect(r5?.action).toBe("pause_ads_and_deprioritize");
  });

  it("R4: a rising outside trend in a niche with 1–2 of the shop's designs", () => {
    const n: NicheFacts = {
      niche: "camping",
      outsideTrend: { ...scored(0.6, src("google_trends", true)), trend: "rising" },
      designsInNiche: 2,
      ideas: ["camping shirt"],
    };
    expect(nicheRules(n)[0]?.params).toEqual({ niche: "camping", ideas: ["camping shirt"] });
    expect(nicheRules({ ...n, designsInNiche: 3 })).toEqual([]);
    expect(nicheRules({ ...n, ideas: [] })).toEqual([]);
  });

  it("a low-band signal never produces a recommendation (each rule)", () => {
    const low = 0.3;
    // R1–R3 and R5 from low-band design facts.
    const f = facts({ currentMonth: 3, ownTrend: { ...scored(low), trend: "falling" } }, low);
    const ch = f.channels[0] as DesignFacts["channels"][number];
    const lowAll = designRules({
      ...f,
      channels: [{ ...ch, margin: { ...scored(low), marginPct: 10, floorPriceCents: 1499 } }],
    });
    expect(lowAll).toEqual([]);
    // R5 needs high, not medium.
    const med = facts({ currentMonth: 3, ownTrend: { ...scored(0.6), trend: "falling" } }, 0.6);
    const chm = med.channels[0] as DesignFacts["channels"][number];
    expect(
      designRules({
        ...med,
        channels: [{ ...chm, margin: { ...scored(0.6), marginPct: 10, floorPriceCents: 1499 } }],
      }).some((r) => r.rule === "R5"),
    ).toBe(false);
    // R4.
    expect(
      nicheRules({
        niche: "camping",
        outsideTrend: { ...scored(low, src("google_trends")), trend: "rising" },
        designsInNiche: 1,
        ideas: ["camping shirt"],
      }),
    ).toEqual([]);
  });
});
