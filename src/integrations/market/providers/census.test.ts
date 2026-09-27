import { Timestamp } from "@invai/contracts";
import { describe, expect, it } from "vitest";
import { env } from "../../../env";
import { censusDemandProvider, censusRetailSeries } from "./census";

describe("censusRetailSeries (AC2: real client, fixture fallback)", () => {
  it("uses the recorded/documented fixture when CENSUS_API_KEY is unset (this test env)", async () => {
    expect(env.mocks.census).toBe(true);
    const series = await censusRetailSeries({ years: 3 });
    expect(series.mock).toBe(true);
    expect(series.source).toBe("census");
    expect(series.licence).toBe("public_dataset");
    expect(series.granularity).toBe("month");
  });

  it("returns exactly years*12 monthly points, oldest first, ending at the fixture's latest month", async () => {
    const series = await censusRetailSeries({ years: 2 });
    expect(series.points).toHaveLength(24);
    const periods = series.points.map((p) => p.period);
    const sorted = [...periods].sort();
    expect(periods).toEqual(sorted);
    expect(series.asOf.startsWith(series.points.at(-1)?.period ?? "")).toBe(true);
  });

  it("carries real-looking retail sales values with a December peak (documented shape)", async () => {
    const series = await censusRetailSeries({ years: 1 });
    const byMonth = new Map(series.points.map((p) => [p.period.slice(5, 7), p.value]));
    const december = byMonth.get("12") ?? 0;
    const january = byMonth.get("01") ?? 0;
    expect(december).toBeGreaterThan(january);
    for (const p of series.points) expect(p.value).toBeGreaterThan(0);
  });

  it("is identical for the same call, twice", async () => {
    const a = await censusRetailSeries({ years: 5 });
    const b = await censusRetailSeries({ years: 5 });
    expect(a.points).toEqual(b.points);
  });

  it("asOf parses as an @invai/contracts Timestamp (AC6, reviewer finding 3)", async () => {
    const series = await censusRetailSeries({ years: 1 });
    expect(() => Timestamp.parse(series.asOf)).not.toThrow();
    expect(series.asOf.startsWith(series.points.at(-1)?.period ?? "")).toBe(true);
  });

  it("censusDemandProvider wraps it as a one-source DemandProvider", async () => {
    const provider = censusDemandProvider();
    expect(provider.source).toBe("census");
    const [series] = await provider.series({
      queries: ["ignored"],
      granularity: "month",
      years: 1,
    });
    expect(series?.points).toHaveLength(12);
  });
});
