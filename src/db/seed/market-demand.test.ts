import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createCompany } from "../../test/fixtures";
import { withSystem } from "../client";
import { marketSeriesCache } from "../schema";
import { seedMarketDemand } from "./market-demand";

/*
 * T-23-10: the seed calls `seedMarketDemand` for the demo shop so `market_series_cache` has
 * outside (`mock: true`) rows right after a fresh seed, the way the hourly `market.sweep` job
 * would once it found the shop due. `refreshDemand()` is global (not scoped to one company), so
 * this proves both that it writes `mock: true` rows and that calling the whole thing twice
 * (AC2: a second `pnpm db:seed`-style run) doesn't duplicate them or throw for a company with no
 * designs yet.
 *
 * `market_series_cache` is shared by every test file (it's the global demand cache, ADR 0015),
 * and other `src/modules/market/**` suites (read-only to this card) write to it under frozen
 * past dates without always clearing it afterwards, so a leftover row can outlive its own file's
 * freshness TTL relative to the real clock this test runs under. Clearing it first, the way
 * those suites' own `clearCache()` helper does, keeps this test's outcome about `seedMarketDemand`
 * only, not about which other files happened to run first in this invocation (found the hard way:
 * this test was flaky under `pnpm test src/db/seed src/modules/market` before this fix).
 */
describe("seedMarketDemand", () => {
  it("writes mock outside-demand rows and is a no-op on a second call", async () => {
    await withSystem((tx) => tx.delete(marketSeriesCache));
    const company = await createCompany();

    const first = await seedMarketDemand(company.id);
    expect(first.demand.sources.length).toBeGreaterThan(0);
    // Every configured demand source ran for real (no error, no "fresh" skip on an empty cache).
    expect(first.demand.sources.every((s) => !s.failed && !s.skipped)).toBe(true);

    const rows = await withSystem((tx) =>
      tx
        .select({ n: sql<number>`count(*)`.mapWith(Number), mock: marketSeriesCache.mock })
        .from(marketSeriesCache)
        .groupBy(marketSeriesCache.mock),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.mock)).toBe(true); // no real key is ever set locally (AC5)

    const [{ n: countAfterFirst }] = (await withSystem((tx) =>
      tx.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(marketSeriesCache),
    )) as [{ n: number }];

    const second = await seedMarketDemand(company.id);
    expect(second.signals.designs).toBe(0); // a fresh company has no designs yet
    expect(second.demand.sources.every((s) => !s.failed)).toBe(true);

    const [{ n: countAfterSecond }] = (await withSystem((tx) =>
      tx.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(marketSeriesCache),
    )) as [{ n: number }];
    expect(countAfterSecond).toBe(countAfterFirst); // no duplicate rows (AC2)
  });
});
