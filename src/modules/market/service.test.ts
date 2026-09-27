import type { Channel } from "@invai/contracts";
import { call } from "@orpc/server";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { anonymousContext, permissionsFor, type TenantContext } from "../../api/context";
import { router } from "../../api/router";
import { withSystem, withTenant } from "../../db/client";
import {
  blankVariants,
  channelConnections,
  companies,
  designs,
  inventoryMovements,
  listings,
  locations,
  marketDesignNiches,
  marketPriceSnapshots,
  marketRecommendations,
  marketSeriesCache,
  marketSignals,
  orderItems,
  orders,
  products,
  profitLines,
  stockLevels,
} from "../../db/schema";
import { env } from "../../env";
import type {
  Comparables,
  DemandProvider,
  DemandSeries,
  PricingProvider,
} from "../../integrations/market";
import { getJob, runJobInline } from "../../lib/queues";
import { createCompany, createUser, tenantContext } from "../../test/fixtures";
import { defaultFeeTable } from "../finance/profit";
import { clearSampleWorkspaceCache } from "../tenancy/demo-flag";
import { mockSourcesAllowed } from "./config";
import { type MarketDeps, setMarketDeps } from "./deps";
import { cacheRows } from "./jobs";
import { CANONICAL_QUERIES, NICHES } from "./niches";
import * as svc from "./service";
import { isoWeekOf } from "./signals";

/*
 * Market module against `invai_test` (RLS on). Outside providers and the AI niche helpers are
 * replaced by deterministic test doubles through `setMarketDeps` (other owners' units), so these
 * tests pin this module's behavior, not the mocks' shapes.
 */

const DAY = 86_400_000;
const WEEK = 7 * DAY;
let seq = 0;
const uniq = () => `${crypto.randomUUID().slice(0, 8)}${(seq++).toString(36)}`;

/* ---------------------------------- test doubles ---------------------------------- */

const HALLOWEEN = [0.7, 0.65, 0.65, 0.65, 0.65, 0.7, 0.75, 0.9, 1.3, 2.0, 0.9, 0.8];

/** Weekly series ending at the week before `now`: Halloween-shaped, rising, or flat. */
function weeklySeries(
  source: DemandSeries["source"],
  query: string,
  now: Date,
  years = 3,
): DemandSeries {
  const n = years * 52;
  const halloween = NICHES.find((x) => x.key === "halloween")?.queries.includes(query);
  const rising = NICHES.find((x) => x.key === "camping")?.queries.includes(query);
  const points = Array.from({ length: n }, (_, i) => {
    const d = new Date(now.getTime() - (n - i) * WEEK);
    const month = d.getUTCMonth();
    const value = halloween
      ? 40 * (HALLOWEEN[month] ?? 1)
      : rising
        ? 10 * 1.05 ** Math.max(0, i - (n - 26))
        : 40;
    return { period: isoWeekOf(d.toISOString().slice(0, 10)), value };
  });
  return {
    source,
    licence: "official_api",
    query,
    geo: "US",
    granularity: "week",
    scale: "relative_0_100",
    points,
    asOf: now.toISOString(),
    fetchedAt: now.toISOString(),
    requestKey: `t:${source}:${query}`,
    mock: true,
  };
}

function demandProvider(
  source: DemandSeries["source"],
  opts: { fail?: boolean; extra?: string; onQueries?: (queries: string[]) => void } = {},
): DemandProvider {
  return {
    source,
    mock: true,
    async series({ queries }) {
      // S-34: record exactly the queries jobs.ts asked this provider to fetch, before any
      // test-only extra is mixed in, so a test can assert it against the full taxonomy.
      opts.onQueries?.([...queries]);
      if (opts.fail) throw new Error(`${source} is down`);
      const now = new Date();
      return [...queries, ...(opts.extra ? [opts.extra] : [])].map((q) =>
        weeklySeries(source, q, now),
      );
    },
  };
}

function censusDouble(): MarketDeps["censusRetailSeries"] {
  return async () => {
    const points = Array.from({ length: 36 }, (_, i) => ({
      period: `${2023 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`,
      value: i % 12 === 11 ? 60_000 : 30_000,
    }));
    return {
      source: "census",
      licence: "public_dataset",
      query: "naics_448_clothing_retail",
      geo: "US",
      granularity: "month",
      scale: "absolute",
      points,
      asOf: new Date().toISOString(),
      fetchedAt: new Date().toISOString(),
      requestKey: "t:census",
      mock: true,
    };
  };
}

/** Comparables: `count` prices spread around `centerCents`, personalization echoed back. */
function pricingDouble(
  count: number,
  centerCents = 1900,
  mock = true,
): MarketDeps["marketPricingProvider"] {
  return (scope) => {
    if (scope.channel !== "amazon" && scope.channel !== "walmart") return null;
    if (scope.connection?.status !== "connected") return null;
    const provider: PricingProvider = {
      source: scope.channel === "amazon" ? "amazon_pricing" : "walmart_pricing",
      mock,
      async comparables(_conn, own) {
        const now = new Date().toISOString();
        return own.map(
          (o): Comparables => ({
            source: scope.channel === "amazon" ? "amazon_pricing" : "walmart_pricing",
            licence: "official_api",
            channel: scope.channel,
            ownRef: o.ref,
            observations: Array.from({ length: count }, (_, i) => ({
              landedPriceCents: centerCents - 300 + i * 60,
              isFeatured: i === 0,
              offerCount: 12,
              personalized: (o as { personalized?: boolean }).personalized ?? false,
            })),
            asOf: now,
            fetchedAt: now,
            requestKey: `t:${o.ref}`,
            mock,
          }),
        );
      },
    };
    return provider;
  };
}

const passScreen: MarketDeps["screen"] = async (_c, terms) => ({ allowed: terms, droppedCount: 0 });

function useDeps(over: Partial<MarketDeps> = {}) {
  setMarketDeps({
    marketDemandProviders: () => [
      demandProvider("census"),
      demandProvider("google_trends"),
      demandProvider("pinterest_trends"),
    ],
    censusRetailSeries: censusDouble(),
    marketPricingProvider: pricingDouble(12),
    classify: () => async () => null,
    screen: passScreen,
    ...over,
  });
}

/** The Postgres error behind drizzle's "Failed query" wrapper. */
async function pgError(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "no error";
  } catch (err) {
    return String((err as { cause?: unknown }).cause ?? err);
  }
}

const clearCache = () => withSystem((tx) => tx.delete(marketSeriesCache));

/* ---------------------------------- fixture shop ---------------------------------- */

type Shop = { id: string; owner: TenantContext; etsy: typeof channelConnections.$inferSelect };

async function connection(companyId: string, channel: Channel, status: "connected" | "csv_only") {
  const [row] = await withSystem((tx) =>
    tx
      .insert(channelConnections)
      .values({
        companyId,
        channel,
        name: `${channel} ${uniq()}`,
        status,
        mode: status === "connected" ? "api" : "csv",
        provider: "mock",
        connectedAt: status === "connected" ? new Date() : null,
      })
      .returning(),
  );
  if (!row) throw new Error("connection insert failed");
  return row;
}

/**
 * The shared fixtures build slugs and emails from Date.now(): run them on the real clock so a
 * frozen test clock can't repeat one from an earlier run.
 */
async function onRealClock<T>(fn: () => Promise<T>): Promise<T> {
  const frozen = vi.isFakeTimers() ? new Date() : null;
  if (frozen) vi.useRealTimers();
  try {
    return await fn();
  } finally {
    if (frozen) freeze(frozen.toISOString());
  }
}

const newUser = (companyId: string, role: Parameters<typeof createUser>[1]) =>
  onRealClock(() => createUser(companyId, role));

async function shop(): Promise<Shop> {
  const { c, u } = await onRealClock(async () => {
    const c = await createCompany({ name: `Market Test ${crypto.randomUUID().slice(0, 8)}` });
    return { c, u: await createUser(c.id, "owner") };
  });
  return {
    id: c.id,
    owner: tenantContext(c.id, u.id, "owner"),
    etsy: await connection(c.id, "etsy", "csv_only"),
  };
}

async function design(companyId: string, name: string, tags: string[], personalized = false) {
  const [row] = await withSystem((tx) =>
    tx
      .insert(designs)
      .values({
        companyId,
        code: `D-${uniq()}`,
        name,
        tags,
        personalizationTemplateId: personalized ? crypto.randomUUID() : null,
      })
      .returning(),
  );
  if (!row) throw new Error("design insert failed");
  return row;
}

async function product(
  companyId: string,
  designId: string,
  prices: { channel: Channel; price: number }[],
) {
  await withSystem((tx) =>
    tx.insert(products).values({
      companyId,
      designId,
      brand: "Gildan",
      styleCode: "G640",
      name: `P ${uniq()}`,
      prices,
    }),
  );
}

async function listing(
  companyId: string,
  conn: typeof channelConnections.$inferSelect,
  designId: string,
) {
  await withSystem((tx) =>
    tx.insert(listings).values({
      companyId,
      connectionId: conn.id,
      channel: conn.channel,
      channelListingId: `L-${uniq()}`,
      title: "tee",
      state: "active",
      designId,
    }),
  );
}

async function blank(companyId: string, onHand: number, reorderPoint: number) {
  return withSystem(async (tx) => {
    const [v] = await tx
      .insert(blankVariants)
      .values({
        companyId,
        brand: "Gildan",
        style: "64000",
        styleCode: "G640",
        styleName: "Softstyle Tee",
        color: "Black",
        colorCode: "BLK",
        size: "L",
        sizeCode: "L",
        sku: `G640-${uniq()}`,
        costCents: 385,
        reorderPoint,
      })
      .returning();
    const [loc] = await tx
      .insert(locations)
      .values({ companyId, name: `Main ${uniq()}`, isDefault: true })
      .returning();
    if (!v || !loc) throw new Error("blank insert failed");
    await tx.insert(stockLevels).values({
      companyId,
      blankVariantId: v.id,
      locationId: loc.id,
      onHand,
      available: onHand,
      reorderPoint,
    });
    return { variant: v, locationId: loc.id };
  });
}

/** Sales at mid-week (Wednesday of the week `weeksAgo` complete weeks back), `leadHours` to ship. */
async function sales(
  s: { id: string },
  conn: typeof channelConnections.$inferSelect,
  designId: string,
  series: number[],
  now: Date,
  opts: {
    priceCents?: number;
    blankVariantId?: string;
    leadHours?: number;
    state?: "shipped" | "cancelled";
    reprint?: boolean;
  } = {},
) {
  const monday = new Date(`${now.toISOString().slice(0, 10)}T12:00:00Z`);
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() || 7) - 1));
  for (let i = 0; i < series.length; i++) {
    const units = series[i] ?? 0;
    if (units <= 0) continue;
    const weeksAgo = series.length - i;
    const placedAt = new Date(monday.getTime() - weeksAgo * WEEK + 2 * DAY);
    const price = opts.priceCents ?? 2499;
    await withSystem(async (tx) => {
      const [o] = await tx
        .insert(orders)
        .values({
          companyId: s.id,
          connectionId: conn.id,
          channel: conn.channel,
          channelOrderId: `co-${uniq()}`,
          orderNo: uniq(),
          status: opts.state === "cancelled" ? "cancelled" : "shipped",
          placedAt,
          shipBy: new Date(placedAt.getTime() + 3 * DAY),
          itemCount: units,
          subtotalCents: price * units,
          totalCents: price * units,
          shippedAt:
            opts.state === "cancelled"
              ? null
              : new Date(placedAt.getTime() + (opts.leadHours ?? 48) * 3_600_000),
        })
        .returning();
      if (!o) throw new Error("order insert failed");
      const items = await tx
        .insert(orderItems)
        .values(
          Array.from({ length: units }, (_, u) => ({
            companyId: s.id,
            orderId: o.id,
            unitNo: u + 1,
            unitsInLine: units,
            unitPriceCents: price,
            shipBy: o.shipBy,
            state: opts.state ?? ("shipped" as const),
            designId,
            blankVariantId: opts.blankVariantId,
            isReprint: opts.reprint ?? false,
          })),
        )
        .returning();
      if (opts.state !== "cancelled" && !opts.reprint)
        await tx.insert(profitLines).values(
          items.map((it) => ({
            companyId: s.id,
            orderId: o.id,
            orderItemId: it.id,
            channel: conn.channel,
            designId,
            revenueCents: price,
            channelFeesCents: 0,
            blankCostCents: 385,
            transferCostCents: 210,
            labelCostCents: 450,
            packagingCostCents: 45,
            laborCostCents: 120,
            adsCostCents: 0,
            netCents: price - 1210,
            placedAt,
          })),
        );
    });
  }
}
const flat = (n: number, u: number) => Array.from({ length: n }, () => u);

const job = (name: string) => {
  const j = getJob(name);
  if (!j) throw new Error(`${name} not registered`);
  return j;
};
async function runAll(companyId: string) {
  await runJobInline(job("market.refreshDemand"), {});
  await runJobInline(job("market.refreshPricing"), { companyId });
  return runJobInline(job("market.computeSignals"), { companyId });
}
const count = async (
  table: typeof marketSignals | typeof marketRecommendations | typeof marketPriceSnapshots,
  companyId: string,
) =>
  (
    await withSystem((tx) =>
      tx
        .select({ n: sql<number>`count(*)::int` })
        .from(table)
        .where(eq(table.companyId, companyId)),
    )
  )[0]?.n ?? 0;

function freeze(at: string) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(at));
  return new Date(at);
}

beforeAll(async () => {
  await import("./jobs");
  await clearCache();
});
afterEach(() => useDeps());
afterAll(async () => {
  vi.useRealTimers();
  setMarketDeps({});
  // The cache is global: leave it empty for other test files.
  await clearCache();
});

/* ---------------------------------- tests ---------------------------------- */

describe("global demand cache (ADR 0015)", () => {
  it("has no shop column; the app role can read but never write it", async () => {
    const cols = await withSystem((tx) =>
      tx.execute<{ c: string }>(
        sql`select column_name as c from information_schema.columns where table_name = 'market_series_cache'`,
      ),
    );
    expect(cols.rows.map((r) => r.c)).not.toContain("company_id");
    const s = await shop();
    expect(
      await pgError(
        withTenant(s.id, (tx) =>
          tx.insert(marketSeriesCache).values({
            source: "google_trends",
            query: "teacher shirt",
            granularity: "week",
            period: "2026-W01",
            value: 1,
            asOf: new Date(),
            fetchedAt: new Date(),
            licence: "official_api",
            mock: true,
          }),
        ),
      ),
    ).toMatch(/permission denied/);
    await withTenant(s.id, (tx) => tx.select().from(marketSeriesCache).limit(1));
  });

  it("refreshDemand stores only taxonomy queries, is idempotent, and a failing source keeps its last good rows", async () => {
    freeze("2026-09-15T16:00:00Z");
    await clearCache();
    // S-34: refreshDemand must fetch the whole fixed taxonomy every run, never a subset derived
    // from which niches any tenant uses (that would let a cache row's presence/freshness leak a
    // low-fidelity cross-tenant signal). Capture the exact `queries` each provider's `series()`
    // is called with, so a future narrowing to tenant-used niches fails this test.
    const fetchedQueries: Record<string, string[]> = {};
    useDeps({
      marketDemandProviders: () => [
        demandProvider("google_trends", {
          extra: "N1ke brand tee",
          onQueries: (qs) => {
            fetchedQueries.google_trends = qs;
          },
        }),
        demandProvider("census", {
          onQueries: (qs) => {
            fetchedQueries.census = qs;
          },
        }),
      ],
    });
    const first = (await runJobInline(job("market.refreshDemand"), {})) as {
      sources: { source: string; refused?: number }[];
    };
    expect(first.sources.find((s) => s.source === "google_trends")?.refused).toBe(1);
    // The fetched set must equal the taxonomy's exactly (not a subset and not a superset):
    // census bypasses `series()` (jobs.ts calls `censusRetailSeries()` instead), so only
    // google_trends' capture applies here.
    expect(fetchedQueries.census).toBeUndefined();
    expect(new Set(fetchedQueries.google_trends)).toEqual(CANONICAL_QUERIES);
    const qs = await withSystem((tx) =>
      tx
        .selectDistinct({ q: marketSeriesCache.query, s: marketSeriesCache.source })
        .from(marketSeriesCache),
    );
    for (const r of qs) if (r.s !== "census") expect(CANONICAL_QUERIES.has(r.q), r.q).toBe(true);
    // Stored rows must also cover exactly the canonical set (not merely be a subset of it), so
    // a narrowed fetch would be caught here too even if some other test doubled up the assertion.
    expect(new Set(qs.filter((r) => r.s === "google_trends").map((r) => r.q))).toEqual(
      CANONICAL_QUERIES,
    );
    const n1 = (
      await withSystem((tx) => tx.select({ n: sql<number>`count(*)::int` }).from(marketSeriesCache))
    )[0]?.n;
    // Same day again: fresh, skipped; one effect.
    await runJobInline(job("market.refreshDemand"), {});
    const n2 = (
      await withSystem((tx) => tx.select({ n: sql<number>`count(*)::int` }).from(marketSeriesCache))
    )[0]?.n;
    expect(n2).toBe(n1);
    // 8 days later Google Trends is down: its rows stay, Pinterest still refreshes.
    vi.setSystemTime(new Date("2026-09-23T16:00:00Z"));
    useDeps({
      marketDemandProviders: () => [
        demandProvider("google_trends", { fail: true }),
        demandProvider("pinterest_trends"),
      ],
    });
    const out = (await runJobInline(job("market.refreshDemand"), {})) as {
      sources: { source: string; failed?: string; rows?: number }[];
    };
    expect(out.sources.find((s) => s.source === "google_trends")?.failed).toMatch(/down/);
    expect(out.sources.find((s) => s.source === "pinterest_trends")?.rows).toBeGreaterThan(0);
    const g = await withSystem((tx) =>
      tx
        .select({ at: sql<Date>`max(${marketSeriesCache.fetchedAt})` })
        .from(marketSeriesCache)
        .where(eq(marketSeriesCache.source, "google_trends")),
    );
    expect(new Date(g[0]?.at as Date).toISOString()).toBe("2026-09-15T16:00:00.000Z");
    vi.useRealTimers();
  });

  it("cacheRows refuses a series whose query is not a canonical taxonomy query", () => {
    const now = new Date("2026-09-15T00:00:00Z");
    const { rows, refused } = cacheRows([
      weeklySeries("google_trends", "some shop free text", now, 1),
    ]);
    expect(refused).toBe(1);
    expect(rows).toEqual([]);
  });
});

describe("happy path on a fixture shop (AC1, AC3) with shaped test providers", () => {
  let s: Shop;
  let pumpkin: typeof designs.$inferSelect;
  let teacher: typeof designs.$inferSelect;
  const NOW = "2026-09-01T16:00:00.000Z";

  beforeAll(async () => {
    const now = freeze(NOW);
    await clearCache();
    useDeps();
    s = await shop();
    await connection(s.id, "amazon", "connected");
    pumpkin = await design(s.id, "Spooky Pumpkin Ghost", ["halloween", "ghost"]);
    teacher = await design(s.id, "Best Teacher Ever", ["teacher", "classroom"]);
    const b = await blank(s.id, 4, 24);
    await product(s.id, pumpkin.id, [{ channel: "etsy", price: 2499 }]);
    await listing(s.id, s.etsy, pumpkin.id);
    await sales(s, s.etsy, pumpkin.id, flat(30, 3), now, {
      blankVariantId: b.variant.id,
      leadHours: 48,
    });
    await sales(s, s.etsy, teacher.id, flat(30, 2), now);
    await runAll(s.id);
  }, 120_000);
  afterAll(() => vi.useRealTimers());

  it("maps niches by stems and computes own and outside signals with provenance", async () => {
    const n = await withTenant(s.id, (tx) =>
      svc.getDesignNiches(tx, s.owner, { designId: teacher.id }),
    );
    expect(n).toMatchObject({ niches: ["teacher"], source: "stems" });
    const t = await withTenant(s.id, (tx) =>
      svc.getTrendSignal(tx, s.owner, { designId: pumpkin.id }),
    );
    const own = t.readings.find((r) => r.provenance.source === "own");
    expect(own?.n).toBe(30);
    expect(own?.trend).toBe("flat");
    expect(own?.provenance.licence).toBe("first_party");
    expect(
      t.readings.some((r) => r.provenance.source === "google_trends" && r.provenance.mock),
    ).toBe(true);
    expect(t.mock).toBe(true);
    expect(t.stale).toBe(false);
  });

  it("seasonality: October peak from outside demand, act-by from the 48 h lead time (4 weeks)", async () => {
    const season = await withTenant(s.id, (tx) =>
      svc.getSeasonalitySignal(tx, s.owner, { designId: pumpkin.id }),
    );
    expect(season.indexSource).toBe("outside");
    expect(season.peakMonths).toContain(10);
    expect(season.actBy?.leadTimeWeeks).toBe(4);
    expect(season.band).not.toBe("low");
    const niche = await withTenant(s.id, (tx) =>
      svc.getSeasonalitySignal(tx, s.owner, { niche: "christmas" }),
    );
    expect(niche.index.length).toBe(12);
  });

  it("R1 lists on the missing connected channel and names the blank below its reorder point", async () => {
    const recs = await withTenant(s.id, (tx) =>
      svc.listRecommendations(tx, s.owner, { designId: pumpkin.id }),
    );
    const r1 = recs.find((r) => r.rule === "R1");
    expect(r1?.action).toBe("list_and_stock");
    expect(r1?.params.channels).toEqual(["amazon"]);
    expect(r1?.params.blankName).toMatch(/G640/);
    expect(r1?.params.blankBelowReorderPoint).toBe(true);
    expect(r1?.params.peakMonth).toBe(9);
    expect(r1?.mock).toBe(true);
  });

  it("running every job again changes nothing (one effect)", async () => {
    const before = [
      await count(marketSignals, s.id),
      await count(marketRecommendations, s.id),
      await count(marketPriceSnapshots, s.id),
    ];
    const sig = await withSystem((tx) =>
      tx
        .select({ v: marketSignals.value })
        .from(marketSignals)
        .where(eq(marketSignals.companyId, s.id))
        .orderBy(marketSignals.id),
    );
    await runAll(s.id);
    await runJobInline(job("market.trackRecommendations"), { companyId: s.id });
    await runJobInline(job("market.trackRecommendations"), { companyId: s.id });
    const after = [
      await count(marketSignals, s.id),
      await count(marketRecommendations, s.id),
      await count(marketPriceSnapshots, s.id),
    ];
    expect(after).toEqual(before);
    const sig2 = await withSystem((tx) =>
      tx
        .select({ v: marketSignals.value })
        .from(marketSignals)
        .where(eq(marketSignals.companyId, s.id))
        .orderBy(marketSignals.id),
    );
    expect(sig2).toEqual(sig);
  });

  it("the Census prior is labelled when no niche data exists", async () => {
    const odd = await design(s.id, "Zorbnak Quux", ["zorbnak"]);
    await runJobInline(job("market.computeSignals"), { companyId: s.id, designIds: [odd.id] });
    const season = await withTenant(s.id, (tx) =>
      svc.getSeasonalitySignal(tx, s.owner, { designId: odd.id }),
    );
    expect(season.indexSource).toBe("census_prior");
    expect(season.peakMonths).toEqual([12]);
  });
});

describe("price position, simulate_price, R2/R3 (AC4–AC6, AC19)", () => {
  let s: Shop;
  let amazon: typeof channelConnections.$inferSelect;
  let tee: typeof designs.$inferSelect;
  let custom: typeof designs.$inferSelect;
  const NOW = "2026-09-15T16:00:00.000Z";

  beforeAll(async () => {
    const now = freeze(NOW);
    useDeps();
    s = await shop();
    amazon = await connection(s.id, "amazon", "connected");
    tee = await design(s.id, "Retro Camping Bear", ["camping"]);
    await product(s.id, tee.id, [
      { channel: "amazon", price: 1299 },
      { channel: "etsy", price: 1299 },
    ]);
    await listing(s.id, amazon, tee.id);
    await sales(s, amazon, tee.id, flat(30, 4), now, { priceCents: 1299 });
    custom = await design(s.id, "Custom Name Dog Mom", ["dog mom"], true);
    await product(s.id, custom.id, [{ channel: "amazon", price: 1999 }]);
    await sales(s, amazon, custom.id, flat(20, 2), now, { priceCents: 1999 });
    await runAll(s.id);
  }, 120_000);
  afterAll(() => vi.useRealTimers());

  it("Etsy has no compliant source, Walmart isn't connected, Amazon answers from ≥ 8 comparables", async () => {
    const at = (channel: Channel, designId = tee.id) =>
      withTenant(s.id, (tx) => svc.getPricePosition(tx, s.owner, { designId, channel }));
    expect(await at("etsy")).toMatchObject({ available: false, reason: "no_compliant_source" });
    expect(await at("walmart")).toMatchObject({ available: false, reason: "not_connected" });
    const pos = await at("amazon");
    expect(pos.available).toBe(true);
    if (pos.available) {
      expect(pos.n).toBe(12);
      expect(pos.priceBand).toBe("low");
      expect(pos.mock).toBe(true);
      expect(pos.sources[0]?.source).toBe("amazon_pricing");
    }
  });

  it("a personalized design only compares with personalized comparables", async () => {
    const [snap] = await withSystem((tx) =>
      tx
        .select()
        .from(marketPriceSnapshots)
        .where(
          and(
            eq(marketPriceSnapshots.companyId, s.id),
            eq(marketPriceSnapshots.designId, custom.id),
          ),
        ),
    );
    expect(snap?.personalized).toBe(true);
    expect(snap?.observations.every((o) => o.personalized === true)).toBe(true);
    // Only plain comparables for a personalized design → none usable.
    useDeps({
      marketPricingProvider: (scope) => {
        const p = pricingDouble(12)(scope);
        if (!p) return null;
        return {
          ...p,
          async comparables(conn, own) {
            const res = await p.comparables(conn, own);
            return res.map((c) => ({
              ...c,
              // Every competing offer is a plain (not personalized) listing.
              observations: c.observations.map((o) => ({ ...o, personalized: false })),
            }));
          },
        };
      },
    });
    await withSystem((tx) =>
      tx.delete(marketPriceSnapshots).where(eq(marketPriceSnapshots.companyId, s.id)),
    );
    await runJobInline(job("market.refreshPricing"), { companyId: s.id, day: "other" });
    await runJobInline(job("market.computeSignals"), { companyId: s.id, day: "other" });
    const pos = await withTenant(s.id, (tx) =>
      svc.getPricePosition(tx, s.owner, { designId: custom.id, channel: "amazon" }),
    );
    expect(pos).toMatchObject({ available: false, reason: "too_few_comparables", n: 0 });
    useDeps();
    await runJobInline(job("market.refreshPricing"), { companyId: s.id, day: "again" });
    await runJobInline(job("market.computeSignals"), { companyId: s.id, day: "again" });
  });

  it("simulate_price equals a hand calculation from the fixture's cost lines (cents)", async () => {
    const sim = await withTenant(s.id, (tx) =>
      svc.simulatePrice(tx, s.owner, { designId: tee.id, channel: "etsy", prices: [1299, 1429] }),
    );
    expect(sim.incomplete).toBe(false);
    expect(sim.costBasis).toMatchObject({
      unitCostCents: 1210,
      shippingChargedCents: 0,
      adsPerUnitCents: 0,
      refundRate: 0,
    });
    const f = defaultFeeTable("etsy");
    const hand = (p: number) => {
      const fees =
        Math.round((p * f.transactionPct) / 100) +
        Math.round((p * f.paymentPct) / 100 + f.paymentFixedCents) +
        f.perOrderCents +
        f.listingFeeCents;
      return p - fees - 1210;
    };
    for (const p of [1299, 1429]) {
      const c = sim.candidates.find((x) => x.priceCents === p);
      expect(c?.netPerUnitCents, `net at ${p}`).toBe(hand(p));
      expect(c?.marginPct).toBeCloseTo((hand(p) / p) * 100, 3);
    }
    expect(sim.candidates.find((x) => x.priceCents === 1429)?.origin).toBe("requested");
    expect(sim.floorPriceCents).not.toBeNull();
    const floor = sim.floorPriceCents as number;
    expect((hand(floor) / floor) * 100).toBeGreaterThanOrEqual(15);
    expect(sim.priceResponse).toBeNull();
    expect(sim.sources.map((x) => x.source)).toEqual(["own"]);
  });

  it("simulate_price is incomplete (not an error) when the design has no cost data", async () => {
    const fresh = await design(s.id, "No Sales Yet", ["camping"]);
    await product(s.id, fresh.id, [{ channel: "etsy", price: 2000 }]);
    const sim = await withTenant(s.id, (tx) =>
      svc.simulatePrice(tx, s.owner, { designId: fresh.id, channel: "etsy" }),
    );
    expect(sim.incomplete).toBe(true);
    expect(sim.missing).toEqual(["unit_cost", "shipping", "ads", "refunds"]);
    expect(sim.floorPriceCents).toBeNull();
  });

  it("R2: a low price with a thin margin tests p0 × 1.05–1.10 under the median; R3 fires under 15%", async () => {
    const recs = await withTenant(s.id, (tx) =>
      svc.listRecommendations(tx, s.owner, { designId: tee.id }),
    );
    const r2 = recs.find((r) => r.rule === "R2");
    expect(r2?.mock).toBe(true);
    expect(r2?.params.testPriceMinCents).toBeGreaterThanOrEqual(Math.round(1299 * 1.05));
    expect(r2?.params.testPriceMaxCents).toBeLessThanOrEqual(r2?.params.comparableMedianCents ?? 0);
    const r3 = recs.find((r) => r.rule === "R3" && r.target.channel === "etsy");
    expect(r3?.params.floorPriceCents).toBeGreaterThan(1299);
    expect(r3?.band).not.toBe("low");
  });
});

describe("mock visibility rule (AC29, AC22)", () => {
  const prodEnv = { isProd: true, allowMocks: false };
  let saved: { isProd: boolean; allowMocks: boolean };
  const setEnv = (e: { isProd: boolean; allowMocks: boolean }) => {
    Object.assign(env as { isProd: boolean; allowMocks: boolean }, e);
  };

  beforeAll(() => {
    saved = { isProd: env.isProd, allowMocks: env.allowMocks };
  });
  afterAll(() => setEnv(saved));

  it("the predicate: dev yes; production real shop no; ALLOW_MOCKS yes; sample workspace yes", async () => {
    const s = await shop();
    clearSampleWorkspaceCache();
    expect(await mockSourcesAllowed(s.id, { isProd: false, allowMocks: false })).toBe(true);
    expect(await mockSourcesAllowed(s.id, prodEnv)).toBe(false);
    expect(await mockSourcesAllowed(s.id, { isProd: true, allowMocks: true })).toBe(true);
    await withSystem((tx) =>
      tx
        .update(companies)
        .set({ settings: { demoRetiredAt: new Date().toISOString() } })
        .where(eq(companies.id, s.id)),
    );
    clearSampleWorkspaceCache();
    expect(await mockSourcesAllowed(s.id, prodEnv)).toBe(true);
  });

  it("production, real shop: no mock-sourced signal, price position unavailable, no R2/R4 stored; own data still works", async () => {
    const now = freeze("2026-09-15T16:00:00Z");
    useDeps();
    await clearCache();
    const s = await shop();
    const amazon = await connection(s.id, "amazon", "connected");
    const d = await design(s.id, "Retro Camping Bear", ["camping"]);
    const d2 = await design(s.id, "Camping Crew", ["camping", "tent"]);
    await product(s.id, d.id, [{ channel: "amazon", price: 1299 }]);
    await sales(s, amazon, d.id, flat(30, 4), now, { priceCents: 1299 });
    await sales(s, amazon, d2.id, flat(30, 2), now, { priceCents: 1299 });
    clearSampleWorkspaceCache();
    setEnv(prodEnv);
    try {
      await runAll(s.id);
      const snaps = await count(marketPriceSnapshots, s.id);
      expect(snaps).toBe(0);
      const mockSignals = await withSystem((tx) =>
        tx
          .select({ n: sql<number>`count(*)::int` })
          .from(marketSignals)
          .where(and(eq(marketSignals.companyId, s.id), eq(marketSignals.mock, true))),
      );
      expect(mockSignals[0]?.n).toBe(0);
      const t = await withTenant(s.id, (tx) => svc.getTrendSignal(tx, s.owner, { designId: d.id }));
      expect(t.sources.every((p) => !p.mock)).toBe(true);
      expect(t.readings.find((r) => r.provenance.source === "own")?.n).toBe(30);
      expect(
        await withTenant(s.id, (tx) =>
          svc.getPricePosition(tx, s.owner, { designId: d.id, channel: "amazon" }),
        ),
      ).toMatchObject({
        available: false,
        reason: "no_compliant_source",
      });
      const recs = await withTenant(s.id, (tx) => svc.listRecommendations(tx, s.owner, {}));
      expect(recs.some((r) => r.rule === "R2" || r.rule === "R4")).toBe(false);
      expect(recs.every((r) => !r.mock)).toBe(true);
      const all = await withSystem((tx) =>
        tx.select().from(marketRecommendations).where(eq(marketRecommendations.companyId, s.id)),
      );
      expect(all.every((r) => !r.mock)).toBe(true);
    } finally {
      setEnv(saved);
      vi.useRealTimers();
    }
  });
});

describe("niches, corrections, credits, trademark screen (AC12, AC21, AC25)", () => {
  it("a correction wins over re-runs; clearing it lets the mapper decide again; unknown key refused", async () => {
    useDeps();
    const s = await shop();
    const d = await design(s.id, "Best Teacher Ever", ["teacher"]);
    await runJobInline(job("market.computeSignals"), { companyId: s.id, designIds: [d.id] });
    const set = await withTenant(s.id, (tx) =>
      svc.setDesignNiches(tx, s.owner, { designId: d.id, niches: ["retirement"] }),
    );
    expect(set).toMatchObject({ niches: ["retirement"], source: "correction" });
    await runJobInline(job("market.computeSignals"), { companyId: s.id, day: "rerun" });
    expect(
      await withTenant(s.id, (tx) => svc.getDesignNiches(tx, s.owner, { designId: d.id })),
    ).toMatchObject({
      niches: ["retirement"],
      source: "correction",
    });
    await expect(
      withTenant(s.id, (tx) =>
        svc.setDesignNiches(tx, s.owner, { designId: d.id, niches: ["not-a-niche"] }),
      ),
    ).rejects.toMatchObject({ code: "UNKNOWN_NICHE" });
    const cleared = await withTenant(s.id, (tx) =>
      svc.setDesignNiches(tx, s.owner, { designId: d.id, niches: [] }),
    );
    expect(cleared).toMatchObject({ niches: [], source: "unclassified" });
    await runJobInline(job("market.computeSignals"), { companyId: s.id, day: "rerun2" });
    expect(
      (await withTenant(s.id, (tx) => svc.getDesignNiches(tx, s.owner, { designId: d.id }))).niches,
    ).toEqual(["teacher"]);
  });

  it("model fallback at ≥ 0.7; no credits leaves it unclassified and own signals still compute", async () => {
    const now = freeze("2026-09-15T16:00:00Z");
    const s = await shop();
    const a = await design(s.id, "Zorbnak Quux", ["zorbnak"]);
    await sales(s, s.etsy, a.id, flat(14, 2), now);
    useDeps({ classify: () => async () => null });
    await runJobInline(job("market.computeSignals"), { companyId: s.id });
    expect(
      await withTenant(s.id, (tx) => svc.getDesignNiches(tx, s.owner, { designId: a.id })),
    ).toMatchObject({
      niches: [],
      source: "unclassified",
    });
    const t = await withTenant(s.id, (tx) => svc.getTrendSignal(tx, s.owner, { designId: a.id }));
    expect(t.readings.find((r) => r.provenance.source === "own")?.n).toBe(14);
    const b = await design(s.id, "Blorp Glorp", ["blorp"]);
    useDeps({ classify: () => async () => ({ niche: "gaming", confidence: 0.8 }) });
    await runJobInline(job("market.computeSignals"), { companyId: s.id, designIds: [b.id] });
    expect(
      await withTenant(s.id, (tx) => svc.getDesignNiches(tx, s.owner, { designId: b.id })),
    ).toMatchObject({
      niches: ["gaming"],
      source: "model",
      confidence: 0.8,
    });
    vi.useRealTimers();
  });

  it("a niche whose label the trademark screen drops is never mapped or queried", async () => {
    const s = await shop();
    const d = await design(s.id, "Best Teacher Ever", ["teacher"]);
    useDeps({
      screen: async (_c, terms) => ({
        allowed: terms.filter((t) => t !== "Teachers"),
        droppedCount: 1,
      }),
    });
    const res = (await runJobInline(job("market.computeSignals"), { companyId: s.id })) as {
      droppedTerms: number;
    };
    expect(res.droppedTerms).toBe(1);
    expect(
      (await withTenant(s.id, (tx) => svc.getDesignNiches(tx, s.owner, { designId: d.id }))).niches,
    ).not.toContain("teacher");
    const rows = await withSystem((tx) =>
      tx
        .select()
        .from(marketSignals)
        .where(and(eq(marketSignals.companyId, s.id), eq(marketSignals.subjectId, "teacher"))),
    );
    expect(rows).toEqual([]);
  });
});

describe("out-of-stock weeks (AC18)", () => {
  it("weeks the blank was out of stock are left out of the trend fit", async () => {
    const now = freeze("2026-09-15T16:00:00Z");
    useDeps();
    const s = await shop();
    const d = await design(s.id, "Stocky Tee", ["zzz"]);
    const b = await blank(s.id, 20, 5);
    await sales(s, s.etsy, d.id, flat(26, 3), now, { blankVariantId: b.variant.id });
    // Ledger: stock ran to 0 four weeks ago and came back (+20) one week ago.
    const monday = new Date("2026-09-14T12:00:00Z");
    await withSystem(async (tx) => {
      await tx.insert(inventoryMovements).values([
        {
          companyId: s.id,
          blankVariantId: b.variant.id,
          locationId: b.locationId,
          kind: "adjust",
          qty: -20,
          createdAt: new Date(monday.getTime() - 4 * WEEK + DAY),
        },
        {
          companyId: s.id,
          blankVariantId: b.variant.id,
          locationId: b.locationId,
          kind: "receive",
          qty: 20,
          createdAt: new Date(monday.getTime() - 1 * WEEK + DAY),
        },
      ]);
    });
    await runJobInline(job("market.computeSignals"), { companyId: s.id });
    const [row] = await withSystem((tx) =>
      tx
        .select()
        .from(marketSignals)
        .where(
          and(
            eq(marketSignals.companyId, s.id),
            eq(marketSignals.subjectId, d.id),
            eq(marketSignals.signal, "trend"),
          ),
        ),
    );
    const v = (row?.value ?? {}) as { outOfStockWeeks?: number; windowPoints?: number };
    expect(v.outOfStockWeeks).toBe(3);
    expect(v.windowPoints).toBe(23);
    vi.useRealTimers();
  });
});

describe("recommendations: tenancy, votes, shown, feedback, digest (AC23, AC24, AC26, AC27)", () => {
  let a: Shop;
  let b: Shop;
  let amazon: typeof channelConnections.$inferSelect;
  let bear: typeof designs.$inferSelect;
  const NOW = "2026-09-15T16:00:00.000Z";

  beforeAll(async () => {
    const now = freeze(NOW);
    useDeps();
    a = await shop();
    b = await shop();
    amazon = await connection(a.id, "amazon", "connected");
    bear = await design(a.id, "Retro Camping Bear", ["camping"]);
    await product(a.id, bear.id, [{ channel: "amazon", price: 1299 }]);
    await listing(a.id, amazon, bear.id);
    await sales(a, amazon, bear.id, flat(30, 4), now, { priceCents: 1299 });
    const fox = await design(a.id, "Retro Camping Fox", ["camping"]);
    await sales(a, amazon, fox.id, flat(30, 4), now, { priceCents: 2499 });
    await runAll(a.id);
  }, 120_000);
  afterAll(() => vi.useRealTimers());

  it("another shop sees none of A's market rows and gets NOT_FOUND for A's ids", async () => {
    for (const t of [
      marketSignals,
      marketRecommendations,
      marketPriceSnapshots,
      marketDesignNiches,
    ]) {
      const rows = await withTenant(b.id, (tx) => tx.select().from(t));
      expect(rows).toEqual([]);
    }
    const recs = await withTenant(a.id, (tx) => svc.listRecommendations(tx, a.owner, {}));
    const one = recs[0];
    expect(one).toBeDefined();
    if (!one) return;
    await expect(
      withTenant(b.id, (tx) => svc.voteRecommendation(tx, b.owner, { id: one.id, vote: "done" })),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(
      await withTenant(b.id, (tx) => svc.listRecommendations(tx, b.owner, { ids: [one.id] })),
    ).toEqual([]);
    await expect(
      withTenant(b.id, (tx) => svc.getTrendSignal(tx, b.owner, { designId: bear.id })),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    // A row written with the wrong company inside A's tenant is refused by RLS.
    expect(
      await pgError(
        withTenant(a.id, (tx) =>
          tx
            .insert(marketDesignNiches)
            .values({ companyId: b.id, designId: bear.id, niches: [], source: "unclassified" }),
        ),
      ),
    ).toMatch(/row-level security/);
  });

  it("voting twice stores one vote; a different vote replaces it; shown is recorded once", async () => {
    // Vote on a rule other than R2 (the adoption test below needs an unvoted R2).
    const r = (
      await withTenant(a.id, (tx) => svc.listRecommendations(tx, a.owner, { designId: bear.id }))
    ).find((x) => x.rule !== "R2");
    if (!r) throw new Error("no recommendation");
    const v1 = await withTenant(a.id, (tx) =>
      svc.voteRecommendation(tx, a.owner, { id: r.id, vote: "not_useful" }),
    );
    const v2 = await withTenant(a.id, (tx) =>
      svc.voteRecommendation(tx, a.owner, { id: r.id, vote: "not_useful" }),
    );
    expect(v2.votedAt).toBe(v1.votedAt);
    expect(v2.adoptedAt).toBeNull();
    const s1 = await withTenant(a.id, (tx) =>
      svc.recordRecommendationsShown(tx, a.owner, {
        ids: [r.id],
        shownIn: "assistant",
        refId: "m1",
      }),
    );
    const s2 = await withTenant(a.id, (tx) =>
      svc.recordRecommendationsShown(tx, a.owner, { ids: [r.id], shownIn: "digest" }),
    );
    expect([s1.updated, s2.updated]).toEqual([1, 0]);
    const [after] = await withTenant(a.id, (tx) =>
      svc.listRecommendations(tx, a.owner, { ids: [r.id] }),
    );
    expect(after?.shownIn).toBe("assistant");
    const v3 = await withTenant(a.id, (tx) =>
      svc.voteRecommendation(tx, a.owner, { id: r.id, vote: "done" }),
    );
    expect(v3.vote).toBe("done");
    expect(v3.adoptedAt).not.toBeNull();
  });

  it("adoption: an unvoted R2 is adopted when the price moves ≥ 3% up within 14 days; outcome 28 days later; idempotent", async () => {
    const recs = await withTenant(a.id, (tx) =>
      svc.listRecommendations(tx, a.owner, { designId: bear.id }),
    );
    const r2 = recs.find((r) => r.rule === "R2" && r.vote === null);
    expect(r2, recs.map((r) => `${r.rule}:${r.vote}`).join(",")).toBeDefined();
    if (!r2) return;
    const now = new Date(NOW);
    vi.setSystemTime(new Date(now.getTime() + 3 * DAY));
    await withSystem((tx) =>
      tx
        .update(products)
        .set({ prices: [{ channel: "amazon", price: 1379 }] })
        .where(eq(products.designId, bear.id)),
    );
    vi.setSystemTime(new Date(now.getTime() + 5 * DAY));
    await runJobInline(job("market.trackRecommendations"), { companyId: a.id, day: "d5" });
    let [seen] = await withTenant(a.id, (tx) =>
      svc.listRecommendations(tx, a.owner, { ids: [r2.id] }),
    );
    expect(seen?.adoptedAt).not.toBeNull();
    expect(seen?.outcome).toBeNull();
    vi.setSystemTime(new Date(now.getTime() + 40 * DAY));
    await runJobInline(job("market.trackRecommendations"), { companyId: a.id, day: "d40" });
    [seen] = await withTenant(a.id, (tx) => svc.listRecommendations(tx, a.owner, { ids: [r2.id] }));
    expect(seen?.outcome).toBe("inconclusive"); // no sales after adoption in this fixture
    await runJobInline(job("market.trackRecommendations"), { companyId: a.id, day: "d40b" });
    const [again] = await withTenant(a.id, (tx) =>
      svc.listRecommendations(tx, a.owner, { ids: [r2.id] }),
    );
    expect(again).toEqual(seen);
    vi.setSystemTime(new Date(NOW));
  });

  it("digest items: band ≥ medium, not stale, only this shop's", async () => {
    const items = await withTenant(a.id, (tx) =>
      svc.listDigestMarketItems(tx, a.owner, { asOf: new Date(NOW) }),
    );
    expect(items.length).toBeGreaterThan(0);
    for (const i of items) {
      expect(i.band).not.toBe("low");
      expect(i.stale).toBe(false);
    }
    expect(
      await withTenant(b.id, (tx) =>
        svc.listDigestMarketItems(tx, b.owner, { asOf: new Date(NOW) }),
      ),
    ).toEqual([]);
    const later = await withTenant(a.id, (tx) =>
      svc.listDigestMarketItems(tx, a.owner, {
        asOf: new Date(new Date(NOW).getTime() + 30 * DAY),
      }),
    );
    expect(later).toEqual([]);
  });

  it("router: designer sets niches but is refused recommendations; presser refused everything; cursor pages", async () => {
    const as = async (companyId: string, role: "designer" | "presser" | "owner") => {
      const u = await newUser(companyId, role);
      return {
        ...anonymousContext(new Headers(), null),
        sessionKind: "user" as const,
        user: { id: u.id, name: u.name, email: u.email },
        companyId,
        orgType: "shop" as const,
        role,
        permissions: permissionsFor(role),
      };
    };
    const designer = await as(a.id, "designer");
    const presser = await as(a.id, "presser");
    const ownerA = await as(a.id, "owner");
    const ownerB = await as(b.id, "owner");
    const code = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
        return "OK";
      } catch (e) {
        return (e as { code?: string }).code ?? String(e);
      }
    };
    const m = router.market;
    expect(
      await code(() =>
        call(m.niches.set, { designId: bear.id, niches: ["camping"] }, { context: designer }),
      ),
    ).toBe("OK");
    expect(await code(() => call(m.niches.taxonomy, {}, { context: designer }))).toBe("OK");
    expect(
      await code(() => call(m.recommendations.list, { limit: 5 }, { context: designer })),
    ).toBe("FORBIDDEN");
    expect(
      await code(() =>
        call(
          m.recommendations.vote,
          { id: crypto.randomUUID(), vote: "done" },
          { context: designer },
        ),
      ),
    ).toBe("FORBIDDEN");
    for (const f of [
      () => call(m.niches.taxonomy, {}, { context: presser }),
      () => call(m.niches.get, { designId: bear.id }, { context: presser }),
      () => call(m.niches.set, { designId: bear.id, niches: [] }, { context: presser }),
      () => call(m.recommendations.list, { limit: 5 }, { context: presser }),
    ])
      expect(await code(f)).toBe("FORBIDDEN");
    expect(await code(() => call(m.niches.get, { designId: bear.id }, { context: ownerB }))).toBe(
      "NOT_FOUND",
    );
    const page1 = await call(m.recommendations.list, { limit: 1 }, { context: ownerA });
    expect(page1.items.length).toBe(1);
    if (page1.nextCursor) {
      const page2 = await call(
        m.recommendations.list,
        { limit: 1, cursor: page1.nextCursor },
        { context: ownerA },
      );
      expect(page2.items[0]?.id).not.toBe(page1.items[0]?.id);
    }
    const tax = await call(m.niches.taxonomy, {}, { context: ownerA });
    expect(tax.items.length).toBe(69);
  });
});

describe("read-only by construction (AC16)", () => {
  it("the module writes only market_* tables", async () => {
    const fs = await import("node:fs/promises");
    const dir = new URL("./", import.meta.url);
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".ts") && !f.includes(".test."));
    const targets = new Set<string>();
    for (const f of files) {
      const src = await fs.readFile(new URL(f, dir), "utf8");
      for (const m of src.matchAll(/\.(?:insert|update|delete)\(\s*([A-Za-z]+)\s*\)/g))
        targets.add(m[1] as string);
    }
    expect([...targets].sort()).toEqual(
      [
        "marketDesignNiches",
        "marketPriceSnapshots",
        "marketRecommendations",
        "marketSeriesCache",
        "marketSignals",
      ].filter((t) => targets.has(t)),
    );
    expect([...targets].every((t) => t.startsWith("market"))).toBe(true);
  });
});

describe("permanent failures", () => {
  it("a per-shop job for a company that doesn't exist stops retrying (UnrecoverableError)", async () => {
    const { UnrecoverableError } = await import("bullmq");
    const missing = "00000000-0000-4000-8000-00000000dead";
    for (const name of [
      "market.computeSignals",
      "market.refreshPricing",
      "market.trackRecommendations",
    ])
      await expect(runJobInline(job(name), { companyId: missing })).rejects.toBeInstanceOf(
        UnrecoverableError,
      );
  });
});
