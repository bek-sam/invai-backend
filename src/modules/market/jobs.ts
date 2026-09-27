import type { Channel } from "@invai/contracts";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { withSystem, withTenant } from "../../db/client";
import {
  companies,
  marketDesignNiches,
  marketPriceSnapshots,
  marketSeriesCache,
  marketSignals,
  type PriceObservationRow,
} from "../../db/schema";
import { env } from "../../env";
import type { DemandSeries } from "../../integrations/market";
import { errorData, logger } from "../../lib/log";
import { defineJob, onEvent, queues } from "../../lib/queues";
import { isSampleWorkspace } from "../tenancy/demo-flag";
import { computeSignalsForShop } from "./compute";
import { MARKET_CONFIG, mockSourcesAllowed } from "./config";
import { integrationsMarket } from "./deps";
import { trackRecommendations } from "./feedback";
import {
  activeDesigns,
  activeListings,
  companyInfo,
  connections,
  currentPrices,
  designBlanks,
  garmentClass,
  getOrSet,
} from "./history";
import { CANONICAL_QUERIES, nicheByKey } from "./niches";
import { isoWeekOf, localYmd, priceStats } from "./signals";

const log = logger("market.jobs");
const DAY_MS = 86_400_000;

const utcDay = (d = new Date()) => d.toISOString().slice(0, 10);

/* ------------------------------ nightly global demand refresh ------------------------------ */

function asOfDate(s: string): Date {
  // Census reports a month ("2026-08"): the datum describes that month's last day.
  if (/^\d{4}-\d{2}$/.test(s)) {
    const [y, m] = s.split("-").map(Number) as [number, number];
    return new Date(Date.UTC(y, m, 0));
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

type CacheInsert = typeof marketSeriesCache.$inferInsert;

/** Series → cache rows; any non-taxonomy query is refused (ADR 0015 item 5). */
export function cacheRows(series: DemandSeries[]): { rows: CacheInsert[]; refused: number } {
  const rows: CacheInsert[] = [];
  let refused = 0;
  for (const s of series) {
    if (s.source !== "census" && !CANONICAL_QUERIES.has(s.query)) {
      refused++;
      continue;
    }
    const asOf = asOfDate(s.asOf);
    const fetchedAt = asOfDate(s.fetchedAt);
    for (const p of s.points) {
      if (!Number.isFinite(p.value)) continue;
      rows.push({
        source: s.source,
        query: s.query,
        granularity: s.granularity,
        period: p.period,
        value: p.value,
        asOf,
        fetchedAt,
        licence: s.licence,
        mock: s.mock,
      });
    }
  }
  return { rows, refused };
}

/**
 * One fetch per (canonical query, source) for every shop, into the global cache. Written only
 * here, under `withSystem` (global cache, ADR 0015: the app role cannot write it). A source that
 * fails keeps its last good rows; the others still refresh. A fresh source (TTL) is skipped.
 */
export async function refreshDemand(now = new Date()) {
  const deps = integrationsMarket();
  const queries = [...CANONICAL_QUERIES];
  const out: {
    source: string;
    rows?: number;
    refused?: number;
    skipped?: string;
    failed?: string;
  }[] = [];
  for (const provider of deps.marketDemandProviders()) {
    const census = provider.source === "census";
    const ttlDays = census
      ? MARKET_CONFIG.demand.censusRefreshAfterDays
      : MARKET_CONFIG.demand.refreshAfterDays;
    // global cache, ADR 0015: a read of the shared table's freshness, no tenant data.
    const [last] = await withSystem((tx) =>
      tx
        .select({ at: sql<Date | null>`max(${marketSeriesCache.fetchedAt})` })
        .from(marketSeriesCache)
        .where(eq(marketSeriesCache.source, provider.source)),
    );
    const lastAt = last?.at ? new Date(last.at) : null;
    if (lastAt && now.getTime() - lastAt.getTime() < ttlDays * DAY_MS && lastAt <= now) {
      out.push({ source: provider.source, skipped: "fresh" });
      continue;
    }
    try {
      const series = census
        ? [await deps.censusRetailSeries({ years: MARKET_CONFIG.demand.censusYears })]
        : await provider.series({
            queries,
            granularity: "week",
            years: MARKET_CONFIG.demand.years,
          });
      const { rows, refused } = cacheRows(series);
      if (refused)
        log.warn("market series refused: not a taxonomy query", {
          source: provider.source,
          refused,
        });
      // global cache, ADR 0015: the nightly job is the only writer (owner connection).
      await withSystem(async (tx) => {
        for (let i = 0; i < rows.length; i += 2000) {
          await tx
            .insert(marketSeriesCache)
            .values(rows.slice(i, i + 2000))
            .onConflictDoUpdate({
              target: [
                marketSeriesCache.source,
                marketSeriesCache.query,
                marketSeriesCache.granularity,
                marketSeriesCache.period,
              ],
              set: {
                value: sql`excluded.value`,
                asOf: sql`excluded.as_of`,
                fetchedAt: sql`excluded.fetched_at`,
                licence: sql`excluded.licence`,
                mock: sql`excluded.mock`,
                updatedAt: new Date(),
              },
            });
        }
      });
      out.push({ source: provider.source, rows: rows.length, refused });
    } catch (err) {
      // Outage: record it and keep the last good rows (reads show the older asOf, lower confidence).
      log.warn("market demand source failed; keeping the last good cache", {
        source: provider.source,
        ...errorData(err),
      });
      out.push({
        source: provider.source,
        failed: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // Retention: periods older than 5 years.
  const y = now.getUTCFullYear() - MARKET_CONFIG.retention.cacheYears;
  const weekCut = isoWeekOf(`${y}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`);
  const monthCut = `${y}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  // global cache, ADR 0015: retention purge by the same job.
  await withSystem((tx) =>
    tx.delete(marketSeriesCache).where(
      sql`(${marketSeriesCache.granularity} = 'week' and ${marketSeriesCache.period} < ${weekCut})
          or (${marketSeriesCache.granularity} = 'month' and ${marketSeriesCache.period} < ${monthCut})`,
    ),
  );
  return { sources: out };
}

export const refreshDemandJob = defineJob({
  queue: "reports",
  name: "market.refreshDemand",
  input: z.object({ day: z.string().optional() }).passthrough(),
  jobId: (i) => `market-demand-${i.day ?? utcDay()}`,
  handler: async () => refreshDemand(),
});

/* ------------------------------ daily per-shop pricing refresh ------------------------------ */

type Plan = {
  timeZone: string;
  conns: Awaited<ReturnType<typeof connections>>;
  own: Map<
    Channel,
    {
      designId: string;
      ref: string;
      keywords: string[];
      garmentClass: string;
      personalized: boolean;
    }[]
  >;
};

/**
 * Comparable prices for the shop's own Amazon/Walmart listings (the only compliant sources).
 * Provider calls run outside any transaction; a mock provider is skipped where mocks may not be
 * shown (AC29). Raw rows older than 90 days are rolled up into one month row.
 */
export async function refreshPricing(companyId: string, now = new Date()) {
  const deps = integrationsMarket();
  const allowed = await mockSourcesAllowed(companyId);
  const sample = await isSampleWorkspace(companyId);
  const plan: Plan = await withTenant(companyId, async (tx) => {
    const { timeZone } = await companyInfo(tx, companyId);
    const conns = (await connections(tx, companyId)).filter(
      (c) => (c.channel === "amazon" || c.channel === "walmart") && c.status === "connected",
    );
    const own: Plan["own"] = new Map();
    if (!conns.length) return { timeZone, conns, own };
    const designs = await activeDesigns(tx, companyId);
    const listed = await activeListings(tx, companyId);
    const prices = await currentPrices(tx, companyId);
    const niches = await tx
      .select({ designId: marketDesignNiches.designId, niches: marketDesignNiches.niches })
      .from(marketDesignNiches)
      .where(eq(marketDesignNiches.companyId, companyId));
    const nicheBy = new Map(niches.map((n) => [n.designId, n.niches]));
    const blanks = await designBlanks(tx, companyId, new Date(now.getTime() - 365 * DAY_MS));
    for (const d of designs) {
      for (const ch of ["amazon", "walmart"] as const) {
        const listing = listed.find((l) => l.designId === d.id && l.channel === ch);
        if (!listing && !prices.get(d.id)?.has(ch)) continue;
        const niche = nicheByKey(nicheBy.get(d.id)?.[0] ?? "");
        getOrSet(own, ch, () => []).push({
          designId: d.id,
          ref: listing?.ref ?? d.id,
          // Taxonomy phrases only: no shop free text leaves for a provider.
          keywords: niche ? niche.queries.slice(0, 2) : [],
          garmentClass: garmentClass(blanks.get(d.id)),
          personalized: d.personalized,
        });
      }
    }
    return { timeZone, conns, own };
  });
  const day = localYmd(now, plan.timeZone);
  const results: { channel: Channel; stored?: number; skipped?: string; failed?: string }[] = [];
  for (const conn of plan.conns) {
    const items = plan.own.get(conn.channel) ?? [];
    const provider = deps.marketPricingProvider({
      sampleWorkspace: sample,
      channel: conn.channel,
      connection: { id: conn.id, companyId, status: conn.status, provider: conn.provider },
    });
    if (!provider) {
      results.push({ channel: conn.channel, skipped: "no_compliant_source" });
      continue;
    }
    if (provider.mock && !allowed) {
      results.push({ channel: conn.channel, skipped: "mock_not_allowed" });
      continue;
    }
    if (!items.length) continue;
    const snapshots: (typeof marketPriceSnapshots.$inferInsert)[] = [];
    try {
      for (let i = 0; i < items.length; i += 50) {
        const chunk = items.slice(i, i + 50);
        const res = await provider.comparables(
          { id: conn.id, companyId, channel: conn.channel, cursor: null },
          chunk.map((c) => ({
            ref: c.ref,
            keywords: c.keywords,
            garmentClass: c.garmentClass,
            personalized: c.personalized,
          })),
        );
        for (const c of res) {
          const own = chunk.find((x) => x.ref === c.ownRef);
          if (!own) continue;
          const observations = c.observations.map((o) => ({
            landedPriceCents: o.landedPriceCents,
            isFeatured: o.isFeatured,
            offerCount: o.offerCount,
            ...("personalized" in o
              ? { personalized: Boolean((o as { personalized?: boolean }).personalized) }
              : {}),
          }));
          const stats = priceStats(observations);
          snapshots.push({
            companyId,
            designId: own.designId,
            channel: conn.channel,
            source: c.source,
            granularity: "day",
            period: day,
            observations,
            personalized: own.personalized,
            n: observations.length,
            q1Cents: stats?.q1Cents ?? null,
            medianCents: stats?.medianCents ?? null,
            q3Cents: stats?.q3Cents ?? null,
            featuredCents: stats?.featuredCents ?? null,
            offerCount: stats?.offerCount ?? null,
            licence: c.licence,
            mock: c.mock,
            asOf: new Date(c.asOf),
            fetchedAt: new Date(c.fetchedAt),
          });
        }
      }
    } catch (err) {
      log.warn("market pricing source failed; keeping the last snapshots", {
        companyId,
        channel: conn.channel,
        ...errorData(err),
      });
      results.push({
        channel: conn.channel,
        failed: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    await withTenant(companyId, async (tx) => {
      for (const s of snapshots) {
        await tx
          .insert(marketPriceSnapshots)
          .values(s)
          .onConflictDoUpdate({
            target: [
              marketPriceSnapshots.companyId,
              marketPriceSnapshots.designId,
              marketPriceSnapshots.channel,
              marketPriceSnapshots.source,
              marketPriceSnapshots.granularity,
              marketPriceSnapshots.period,
            ],
            set: {
              observations: s.observations,
              personalized: s.personalized,
              n: s.n,
              q1Cents: s.q1Cents,
              medianCents: s.medianCents,
              q3Cents: s.q3Cents,
              featuredCents: s.featuredCents,
              offerCount: s.offerCount,
              mock: s.mock,
              asOf: s.asOf,
              fetchedAt: s.fetchedAt,
              updatedAt: new Date(),
            },
          });
      }
    });
    results.push({ channel: conn.channel, stored: snapshots.length });
  }
  await withTenant(companyId, (tx) => rollUpSnapshots(tx, companyId, now, plan.timeZone));
  return { channels: results };
}

/** Raw day rows older than 90 days → one month row per design × channel × source (idempotent). */
async function rollUpSnapshots(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  companyId: string,
  now: Date,
  timeZone: string,
) {
  const cutoff = localYmd(new Date(now.getTime() - MARKET_CONFIG.price.rawDays * DAY_MS), timeZone);
  const old = await tx
    .select()
    .from(marketPriceSnapshots)
    .where(
      and(
        eq(marketPriceSnapshots.companyId, companyId),
        eq(marketPriceSnapshots.granularity, "day"),
        lt(marketPriceSnapshots.period, cutoff),
      ),
    );
  if (old.length) {
    const groups = new Map<string, typeof old>();
    for (const r of old)
      getOrSet(
        groups,
        `${r.designId}|${r.channel}|${r.source}|${r.period.slice(0, 7)}`,
        () => [],
      ).push(r);
    for (const rows of groups.values()) {
      const first = rows[0] as (typeof old)[number];
      const month = first.period.slice(0, 7);
      const [existing] = await tx
        .select()
        .from(marketPriceSnapshots)
        .where(
          and(
            eq(marketPriceSnapshots.companyId, companyId),
            eq(marketPriceSnapshots.designId, first.designId),
            eq(marketPriceSnapshots.channel, first.channel),
            eq(marketPriceSnapshots.source, first.source),
            eq(marketPriceSnapshots.granularity, "month"),
            eq(marketPriceSnapshots.period, month),
          ),
        );
      const observations: PriceObservationRow[] = [
        ...(existing?.observations ?? []),
        ...rows.flatMap((r) => r.observations),
      ];
      const stats = priceStats(observations);
      const last = rows.reduce((m, r) => (r.asOf > m.asOf ? r : m));
      const values = {
        observations,
        n: observations.length,
        q1Cents: stats?.q1Cents ?? null,
        medianCents: stats?.medianCents ?? null,
        q3Cents: stats?.q3Cents ?? null,
        featuredCents: stats?.featuredCents ?? null,
        offerCount: stats?.offerCount ?? null,
        mock: rows.some((r) => r.mock) || !!existing?.mock,
        asOf: last.asOf,
        fetchedAt: last.fetchedAt,
      };
      await tx
        .insert(marketPriceSnapshots)
        .values({
          companyId,
          designId: first.designId,
          channel: first.channel,
          source: first.source,
          granularity: "month",
          period: month,
          personalized: first.personalized,
          licence: first.licence,
          ...values,
        })
        .onConflictDoUpdate({
          target: [
            marketPriceSnapshots.companyId,
            marketPriceSnapshots.designId,
            marketPriceSnapshots.channel,
            marketPriceSnapshots.source,
            marketPriceSnapshots.granularity,
            marketPriceSnapshots.period,
          ],
          set: { ...values, updatedAt: new Date() },
        });
    }
    await tx.delete(marketPriceSnapshots).where(
      inArray(
        marketPriceSnapshots.id,
        old.map((r) => r.id),
      ),
    );
  }
  const monthCut = localYmd(
    new Date(now.getTime() - MARKET_CONFIG.retention.rollupYears * 365 * DAY_MS),
    timeZone,
  ).slice(0, 7);
  await tx
    .delete(marketPriceSnapshots)
    .where(
      and(
        eq(marketPriceSnapshots.companyId, companyId),
        eq(marketPriceSnapshots.granularity, "month"),
        lt(marketPriceSnapshots.period, monthCut),
      ),
    );
}

export const refreshPricingJob = defineJob({
  queue: "reports",
  name: "market.refreshPricing",
  input: z.object({ companyId: z.uuid(), day: z.string().optional() }),
  jobId: (i) => `market-pricing-${i.companyId}-${i.day ?? utcDay()}`,
  handler: async ({ companyId }) => refreshPricing(companyId),
});

/* ------------------------------ per-shop signals ------------------------------ */

export const computeSignalsJob = defineJob({
  queue: "reports",
  name: "market.computeSignals",
  input: z.object({
    companyId: z.uuid(),
    designIds: z.array(z.uuid()).max(50).optional(),
    day: z.string().optional(),
  }),
  // One full run per shop per day; a design-scoped run (new design, niche fixed) has its own id.
  jobId: (i) =>
    `market-signals-${i.companyId}-${i.day ?? utcDay()}${i.designIds?.length ? `-${[...i.designIds].sort().join("-")}` : ""}`,
  handler: async ({ companyId, designIds }) => {
    const deps = integrationsMarket();
    const res = await computeSignalsForShop(
      companyId,
      { designIds },
      { classify: deps.classify(companyId), screen: deps.screen },
    );
    log.info("market signals computed", { companyId, ...res });
    return res;
  },
});

// A new or edited design gets its niches and signals without waiting for the nightly run.
onEvent("design.updated", computeSignalsJob, (e) => {
  const designId = (e.payload as { designId?: string }).designId;
  return designId ? { companyId: e.companyId, designIds: [designId] } : null;
});

/* ------------------------------ per-shop feedback ------------------------------ */

export const trackRecommendationsJob = defineJob({
  queue: "reports",
  name: "market.trackRecommendations",
  input: z.object({ companyId: z.uuid(), day: z.string().optional() }),
  jobId: (i) => `market-track-${i.companyId}-${i.day ?? utcDay()}`,
  handler: async ({ companyId }) =>
    withTenant(companyId, (tx) => trackRecommendations(tx, companyId, new Date())),
});

/* ------------------------------ schedulers ------------------------------ */

export const MARKET_SWEEP_EVERY_MS = 60 * 60_000;

/**
 * Hourly sweep (cross-tenant: owner connection, ids only): shops with no signals for their
 * local today get the day's pricing refresh, signal run and feedback pass, after the demand cache
 * is refreshed when stale. So a freshly seeded stack has signals within one tick (≤ 1 hour).
 */
export async function marketSweep(now = new Date()) {
  const shops = await withSystem((tx) =>
    tx
      .select({ id: companies.id, timeZone: companies.timezone })
      .from(companies)
      .where(eq(companies.type, "shop")),
  );
  const done = await withSystem((tx) =>
    tx
      .selectDistinct({ companyId: marketSignals.companyId, day: marketSignals.computedOn })
      .from(marketSignals)
      .where(eq(marketSignals.signal, "lead_time")),
  );
  const doneSet = new Set(done.map((d) => `${d.companyId}|${d.day}`));
  const due = shops.filter((s) => !doneSet.has(`${s.id}|${localYmd(now, s.timeZone)}`));
  if (!due.length) return { shops: shops.length, queued: 0 };
  await refreshDemandJob.enqueue({ day: utcDay(now) });
  for (const s of due) {
    const day = localYmd(now, s.timeZone);
    await refreshPricingJob.enqueue({ companyId: s.id, day });
    await computeSignalsJob.enqueue({ companyId: s.id, day });
    await trackRecommendationsJob.enqueue({ companyId: s.id, day });
  }
  return { shops: shops.length, queued: due.length };
}

export const marketSweepJob = defineJob({
  queue: "reports",
  name: "market.sweep",
  input: z.object({}).passthrough(),
  handler: async () => marketSweep(),
});

/** Idempotent: the hourly sweep and the 03:00 UTC nightly demand refresh (API and worker). */
export async function scheduleMarketJobs() {
  await queues.reports.upsertJobScheduler(
    "market-sweep",
    { every: MARKET_SWEEP_EVERY_MS },
    { name: marketSweepJob.name, data: {} },
  );
  await queues.reports.upsertJobScheduler(
    "market-demand-nightly",
    { pattern: "0 3 * * *", tz: "UTC" },
    { name: refreshDemandJob.name, data: {} },
  );
}

if (!env.isTest) {
  scheduleMarketJobs().catch((err) =>
    log.warn("could not register the market schedulers", errorData(err)),
  );
}
