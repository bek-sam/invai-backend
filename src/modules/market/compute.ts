import type { Channel, SignalSource } from "@invai/contracts";
import { and, desc, eq, gte, inArray, ne, sql } from "drizzle-orm";
import { type Tx, withTenant } from "../../db/client";
import {
  costSettings,
  marketDesignNiches,
  marketPriceSnapshots,
  marketRecommendations,
  marketSeriesCache,
  marketSignals,
  type RecBaseline,
  type RecSource,
} from "../../db/schema";
import { logger } from "../../lib/log";
import { feeCategoryOf } from "../finance/fees";
import { defaultFeeTable, type FeeTable, orderFees } from "../finance/profit";
import { feeTablesOf, getProfit } from "../finance/service";
import { isSampleWorkspace } from "../tenancy/demo-flag";
import { band, combine, freshness, reliability, sampleFactor } from "./confidence";
import { MARKET_CONFIG, mockSourcesAllowed, OUTSIDE_DEMAND_SOURCES } from "./config";
import {
  activeDesigns,
  activeListings,
  companyInfo,
  connectedChannels,
  connections,
  currentPrices,
  type DesignRow,
  designBlanks,
  garmentClass,
  getOrSet,
  medianLeadHours,
  outOfStockWeeks,
  ownWeekly,
} from "./history";
import { type Classifier, mapDesign, stemNiches } from "./mapper";
import { NICHES, type Niche, nicheByKey } from "./niches";
import { buildSeason, buildTrend, type SignalRow } from "./read";
import {
  type ChannelFacts,
  type DesignFacts,
  designRules,
  type NicheFacts,
  nicheRules,
  type RecommendationDraft,
  type Scored,
} from "./rules";
import {
  breakEvenCents,
  type CostBasis,
  completeWeeks,
  filterComparables,
  fitTrend,
  floorPriceCents,
  leadTimeWeeks,
  localYmd,
  marginPctAt,
  netAt,
  type Observation,
  priceEnding,
  pricePercentile,
  priceStats,
  round4,
  seasonalityIndex,
  terciles,
  weeklyToMonthly,
  yearOverYear,
} from "./signals";

const log = logger("market.compute");
const DAY_MS = 86_400_000;

export type Screen = (
  companyId: string,
  terms: string[],
) => Promise<{ allowed: string[]; droppedCount: number }>;

export type ComputeDeps = { classify: Classifier | null; screen: Screen | null };

export type ComputeResult = {
  designs: number;
  mapped: number;
  classified: number;
  signals: number;
  recommendations: number;
  droppedTerms: number;
};

type SignalInsert = typeof marketSignals.$inferInsert;
type Provenance = RecSource;

function iso(d: Date): string {
  return d.toISOString();
}

/* -------------------------------- niche mapping -------------------------------- */

type NicheRow = typeof marketDesignNiches.$inferSelect;

/**
 * Phase A + B of a run: re-map every design that has no shop correction (stems each run; the
 * model only for designs without a stem match that weren't tried since their last edit, capped
 * per run). The model call happens outside any transaction.
 */
async function mapNiches(
  companyId: string,
  designIds: string[] | undefined,
  now: Date,
  classify: Classifier | null,
  allowedNiches: readonly Niche[],
): Promise<{ mapped: number; classified: number }> {
  const { designs, existing } = await withTenant(companyId, async (tx) => ({
    designs: await activeDesigns(tx, companyId, designIds),
    existing: await tx
      .select()
      .from(marketDesignNiches)
      .where(eq(marketDesignNiches.companyId, companyId)),
  }));
  const byDesign = new Map(existing.map((r) => [r.designId, r]));
  const retryAfter = 7 * DAY_MS;
  const writes: {
    design: DesignRow;
    niches: string[];
    source: NicheRow["source"];
    confidence: number | null;
  }[] = [];
  let modelCalls = 0;
  for (const d of designs) {
    const cur = byDesign.get(d.id);
    if (cur?.source === "correction") continue;
    const stems = stemNiches(d.name, d.tags, allowedNiches);
    if (stems.length) {
      writes.push({ design: d, niches: stems, source: "stems", confidence: null });
      continue;
    }
    const tried =
      cur &&
      (cur.source === "model" ||
        (cur.source === "unclassified" && now.getTime() - cur.updatedAt.getTime() < retryAfter)) &&
      cur.updatedAt >= d.updatedAt;
    if (tried) continue;
    const useModel = classify && modelCalls < MARKET_CONFIG.maxClassificationsPerRun;
    if (useModel) modelCalls++;
    const m = await mapDesign(d, useModel ? classify : null, allowedNiches);
    writes.push({ design: d, niches: m.niches, source: m.source, confidence: m.confidence });
  }
  if (!writes.length) return { mapped: 0, classified: modelCalls };
  await withTenant(companyId, async (tx) => {
    for (const w of writes) {
      await tx
        .insert(marketDesignNiches)
        .values({
          companyId,
          designId: w.design.id,
          niches: w.niches,
          source: w.source,
          confidence: w.confidence,
        })
        .onConflictDoUpdate({
          target: [marketDesignNiches.companyId, marketDesignNiches.designId],
          set: {
            niches: w.niches,
            source: w.source,
            confidence: w.confidence,
            updatedAt: new Date(),
          },
          // A shop correction written meanwhile always wins.
          setWhere: ne(marketDesignNiches.source, "correction"),
        });
    }
  });
  return { mapped: writes.length, classified: modelCalls };
}

/* -------------------------------- outside series -------------------------------- */

type NicheSeries = {
  niche: string;
  source: SignalSource;
  licence: Provenance["licence"];
  points: { period: string; value: number }[];
  asOf: Date;
  fetchedAt: Date;
  mock: boolean;
};

/** Mean of each niche's (screened) queries per source and ISO week, from the global cache. */
async function nicheSeries(
  tx: Tx,
  niches: readonly Niche[],
  allowedQueries: Set<string>,
  includeMock: boolean,
  lastWeek: string,
): Promise<NicheSeries[]> {
  const pairs = niches.flatMap((n) =>
    n.queries.filter((q) => allowedQueries.has(q)).map((q) => sql`(${q}, ${n.key})`),
  );
  if (!pairs.length) return [];
  const rows = await tx.execute<{
    niche: string;
    source: SignalSource;
    period: string;
    value: number;
    as_of: Date;
    fetched_at: Date;
    mock: boolean;
    licence: Provenance["licence"];
  }>(sql`
    select m.niche, c.source, c.period, avg(c.value)::float8 as value, max(c.as_of) as as_of,
      max(c.fetched_at) as fetched_at, bool_or(c.mock) as mock, max(c.licence) as licence
    from ${marketSeriesCache} c
    join (values ${sql.join(pairs, sql`, `)}) as m(query, niche) on m.query = c.query
    where c.granularity = 'week' and c.period <= ${lastWeek}
      and c.source in (${sql.join(
        OUTSIDE_DEMAND_SOURCES.map((s) => sql`${s}`),
        sql`, `,
      )})
      ${includeMock ? sql`` : sql`and c.mock = false`}
    group by 1, 2, 3
    order by 1, 2, 3`);
  const out = new Map<string, NicheSeries>();
  for (const r of rows.rows) {
    const key = `${r.niche}|${r.source}`;
    const s = getOrSet(out, key, () => ({
      niche: r.niche,
      source: r.source,
      licence: r.licence,
      points: [],
      asOf: new Date(0),
      fetchedAt: new Date(0),
      mock: false,
    }));
    s.points.push({ period: r.period, value: Number(r.value) });
    const asOf = new Date(r.as_of);
    const fetchedAt = new Date(r.fetched_at);
    if (asOf > s.asOf) s.asOf = asOf;
    if (fetchedAt > s.fetchedAt) s.fetchedAt = fetchedAt;
    s.mock = s.mock || r.mock;
  }
  for (const s of out.values()) s.points = s.points.slice(-MARKET_CONFIG.history.weeks);
  return [...out.values()];
}

async function censusSeries(tx: Tx, includeMock: boolean) {
  const rows = await tx
    .select()
    .from(marketSeriesCache)
    .where(
      and(
        eq(marketSeriesCache.source, "census"),
        eq(marketSeriesCache.granularity, "month"),
        includeMock ? undefined : eq(marketSeriesCache.mock, false),
      ),
    )
    .orderBy(marketSeriesCache.period);
  if (!rows.length) return null;
  const last = rows.reduce((m, r) => (r.fetchedAt > m.fetchedAt ? r : m));
  return {
    points: rows.map((r) => ({ period: r.period, value: r.value })),
    asOf: rows.reduce((m, r) => (r.asOf > m ? r.asOf : m), new Date(0)),
    fetchedAt: last.fetchedAt,
    licence: last.licence,
    mock: rows.some((r) => r.mock),
  };
}

/* -------------------------------- margin basis -------------------------------- */

export async function feeTables(tx: Tx, companyId: string): Promise<FeeTable[]> {
  // Read-only: `ensureCostSettings` would insert a row, and the market module writes no
  // finance table (AC16). Without saved settings the channel defaults apply.
  const [row] = await tx.select().from(costSettings).where(eq(costSettings.companyId, companyId));
  return row ? feeTablesOf(row) : [];
}

export function feeFn(tables: FeeTable[], channel: Channel, style: string | null) {
  const table = tables.find((t) => t.channel === channel) ?? defaultFeeTable(channel);
  const category = feeCategoryOf(style);
  const fixed = table.paymentFixedCents + table.perOrderCents + table.listingFeeCents;
  const fees = (revenueCents: number) =>
    orderFees(table, {
      revenueCents,
      buyerTotalCents: revenueCents,
      units: 1,
      unitSales: [{ cents: revenueCents, category }],
    }).total;
  return { fees, fixed };
}

export type MarginBasis = {
  basis: CostBasis;
  units: number;
  unitCostCents: number | null;
  shippingChargedCents: number | null;
  adsPerUnitCents: number | null;
  refundRate: number | null;
  feeFixedCents: number;
  missing: ("unit_cost" | "fees" | "shipping" | "ads" | "refunds")[];
};

type ProfitRow = {
  revenue: number;
  blankCost: number;
  transferCost: number;
  labelCost: number;
  packagingCost: number;
  laborCost: number;
  adsCost: number;
  refunds: number;
  units: number;
};

/** Trailing-90-day cost lines for one design on one channel (falls back to all channels). */
export function marginBasis(
  row: ProfitRow | undefined,
  avgUnitPriceCents: number | null,
  fee: { fees: (revenueCents: number) => number; fixed: number },
): MarginBasis {
  const units = row ? Math.max(row.units, 0) : 0;
  const has = !!row && units > 0;
  const per = (x: number) => (has ? Math.round(x / units) : 0);
  const unitCost = has
    ? per(row.blankCost + row.transferCost + row.labelCost + row.packagingCost + row.laborCost)
    : null;
  const revenuePerUnit = has ? row.revenue / units : null;
  const shipping =
    revenuePerUnit !== null && avgUnitPriceCents !== null
      ? Math.max(0, Math.round(revenuePerUnit - avgUnitPriceCents))
      : null;
  const ads = has ? per(row.adsCost) : null;
  const refundRate = has && row.revenue > 0 ? round4(row.refunds / row.revenue) : has ? 0 : null;
  const ship = shipping ?? 0;
  const basis: CostBasis = {
    shippingChargedCents: ship,
    unitCostCents: unitCost ?? 0,
    adsPerUnitCents: ads ?? 0,
    refundRate: refundRate ?? 0,
    fees: (p) => fee.fees(p + ship),
  };
  const missing: MarginBasis["missing"] = [];
  if (unitCost === null) missing.push("unit_cost");
  if (shipping === null) missing.push("shipping");
  if (ads === null) missing.push("ads");
  if (refundRate === null) missing.push("refunds");
  return {
    basis,
    units,
    unitCostCents: unitCost,
    shippingChargedCents: shipping,
    adsPerUnitCents: ads,
    refundRate,
    feeFixedCents: fee.fixed,
    missing,
  };
}

/* -------------------------------- the run -------------------------------- */

function provOwn(now: Date, mock: boolean): Provenance {
  return { source: "own", licence: "first_party", asOf: iso(now), fetchedAt: iso(now), mock };
}

/**
 * Computes and stores every signal and recommendation for one shop (spec steps 1–5). A full run
 * replaces the shop's signals for today; a design-scoped run (a new design, a niche correction)
 * refreshes only those designs' own signals and rules. Idempotent: the same inputs upsert the
 * same rows, and a recommendation is created at most once per rule, target and day.
 */
export async function computeSignalsForShop(
  companyId: string,
  opts: { designIds?: string[]; now?: Date },
  deps: ComputeDeps,
): Promise<ComputeResult> {
  const now = opts.now ?? new Date();
  const scoped = !!opts.designIds?.length;
  const allowed = await mockSourcesAllowed(companyId);
  const sample = await isSampleWorkspace(companyId);

  // Trademark screen on every niche label and canonical query before it's used (spec step 2.3).
  const terms = [...new Set(NICHES.flatMap((n) => [n.labelEn, n.labelEs, ...n.queries]))];
  const screened = deps.screen
    ? await deps.screen(companyId, terms)
    : { allowed: terms, droppedCount: 0 };
  const allowedTerms = new Set(screened.allowed);
  if (screened.droppedCount > 0)
    log.info("market terms dropped by the trademark screen", {
      companyId,
      dropped: screened.droppedCount,
    });
  const allowedNiches = NICHES.filter(
    (n) => allowedTerms.has(n.labelEn) && allowedTerms.has(n.labelEs),
  );
  const allowedQueries = new Set(
    NICHES.flatMap((n) => n.queries).filter((q) => allowedTerms.has(q)),
  );

  const mapping = await mapNiches(companyId, opts.designIds, now, deps.classify, allowedNiches);

  const result = await withTenant(companyId, (tx) =>
    computeInTx(tx, companyId, now, {
      designIds: opts.designIds,
      scoped,
      allowed,
      sample,
      allowedNiches,
      allowedQueries,
    }),
  );
  return {
    ...result,
    mapped: mapping.mapped,
    classified: mapping.classified,
    droppedTerms: screened.droppedCount,
  };
}

type RunCtx = {
  designIds: string[] | undefined;
  scoped: boolean;
  allowed: boolean;
  sample: boolean;
  allowedNiches: readonly Niche[];
  allowedQueries: Set<string>;
};

async function computeInTx(tx: Tx, companyId: string, now: Date, run: RunCtx) {
  const { timeZone } = await companyInfo(tx, companyId);
  const today = localYmd(now, timeZone);
  const currentMonth = Number(today.slice(5, 7));
  const weeks = completeWeeks(now, timeZone, MARKET_CONFIG.history.weeks);
  const weekKeys = weeks.map((w) => w.key);
  const lastWeek = weekKeys[weekKeys.length - 1] ?? "";
  const from = new Date(`${weeks[0]?.monday ?? today}T00:00:00Z`);
  from.setTime(from.getTime() - DAY_MS); // time-zone slack; the week key decides
  const ownProv = provOwn(now, run.sample);

  const designs = await activeDesigns(tx, companyId, run.designIds);
  const allDesigns = run.scoped ? await activeDesigns(tx, companyId) : designs;
  const nicheRows = await tx
    .select()
    .from(marketDesignNiches)
    .where(eq(marketDesignNiches.companyId, companyId));
  const nichesOf = new Map(
    nicheRows.map((r) => [
      r.designId,
      { niches: r.niches.filter((k) => run.allowedNiches.some((n) => n.key === k)), row: r },
    ]),
  );
  const designIds = designs.map((d) => d.id);
  const weekly = await ownWeekly(tx, companyId, timeZone, from, run.scoped ? designIds : undefined);
  const blanks = await designBlanks(tx, companyId, from, run.scoped ? designIds : undefined);
  const oos = await outOfStockWeeks(
    tx,
    companyId,
    [...new Set([...blanks.values()].map((b) => b.id))],
    weekKeys,
    from,
    timeZone,
  );
  const leadHours = await medianLeadHours(tx, companyId, now);
  const conns = await connections(tx, companyId);
  const connected = connectedChannels(conns);
  const prices = await currentPrices(tx, companyId, run.scoped ? designIds : undefined);
  const listed = await activeListings(tx, companyId, run.scoped ? designIds : undefined);
  const tables = await feeTables(tx, companyId);

  const signals: SignalInsert[] = [];
  const put = (
    subjectType: SignalInsert["subjectType"],
    subjectId: string,
    signal: SignalInsert["signal"],
    prov: Provenance,
    fields: { value: Record<string, unknown>; n: number; s: number; r: number; a?: number },
  ) =>
    signals.push({
      companyId,
      subjectType,
      subjectId,
      signal,
      source: prov.source,
      value: fields.value,
      n: fields.n,
      sampleFactor: round4(fields.s),
      reliability: round4(fields.r),
      agreement: fields.a ?? 1,
      licence: prov.licence,
      mock: prov.mock,
      asOf: new Date(prov.asOf),
      fetchedAt: new Date(prov.fetchedAt),
      computedOn: today,
    });

  /* ---- own weekly series per design (all channels) ---- */
  const seriesOf = (
    designId: string,
  ): { values: (number | null)[]; age: number; nonZero: number; oosWeeks: number } => {
    const byCh = weekly.get(designId);
    const blank = blanks.get(designId);
    const out = blank ? oos.get(blank.id) : undefined;
    const values: (number | null)[] = weekKeys.map((k) => {
      let u = 0;
      for (const m of byCh?.values() ?? []) u += m.get(k)?.units ?? 0;
      return u;
    });
    const first = values.findIndex((v) => (v ?? 0) > 0);
    const age = first < 0 ? 0 : values.length - first;
    let nonZero = 0;
    let oosWeeks = 0;
    const trimmed = values.map((v, i) => {
      if (first < 0 || i < first) return null;
      if (out?.has(weekKeys[i] as string)) {
        oosWeeks++;
        return null;
      }
      if ((v ?? 0) > 0) nonZero++;
      return v;
    });
    return { values: trimmed, age, nonZero, oosWeeks };
  };

  const ownSeason = (values: (number | null)[]) => {
    const pts = values.flatMap((v, i) =>
      v === null ? [] : [{ period: weekKeys[i] as string, value: v }],
    );
    const units = pts.reduce((a, p) => a + p.value, 0);
    const si = seasonalityIndex(weeklyToMonthly(pts));
    if (!si || units / si.yearsUsed < MARKET_CONFIG.seasonality.ownMinUnitsPerYear) return null;
    return si;
  };
  const siByWeek = (si: { index: { month: number; index: number }[] } | null) =>
    si ? weeks.map((w) => si.index.find((x) => x.month === w.month)?.index ?? null) : undefined;

  const target = MARKET_CONFIG.confidence.target;

  /* ---- design-level own signals ---- */
  const designSeries = new Map<string, ReturnType<typeof seriesOf>>();
  for (const d of designs) {
    const s = seriesOf(d.id);
    designSeries.set(d.id, s);
    const season = ownSeason(s.values);
    if (season) {
      put("design", d.id, "seasonality", ownProv, {
        value: { ...season },
        n: season.yearsUsed,
        s: sampleFactor(season.yearsUsed, target.seasonalityYears),
        r: 1,
      });
    }
    const fit = fitTrend(s.values, { ageWeeks: s.age, si: siByWeek(season) });
    put("design", d.id, "trend", ownProv, {
      value: {
        ...fit,
        yoy: yearOverYear(
          s.values.map((v) => v ?? 0),
          MARKET_CONFIG.yoy.minOwnDenominator,
        ),
        outOfStockWeeks: s.oosWeeks,
      },
      n: s.nonZero,
      s: sampleFactor(fit.windowPoints, target.trend),
      r: 1,
    });
  }

  /* ---- niche-level signals (full runs) ---- */
  let outside: NicheSeries[] = [];
  if (!run.scoped) {
    outside = await nicheSeries(tx, run.allowedNiches, run.allowedQueries, run.allowed, lastWeek);
    for (const ns of outside) {
      const prov: Provenance = {
        source: ns.source,
        licence: ns.licence,
        asOf: iso(ns.asOf),
        fetchedAt: iso(ns.fetchedAt),
        mock: ns.mock,
      };
      const si = seasonalityIndex(weeklyToMonthly(ns.points));
      const siWeek = si
        ? ns.points.map((p) => si.index.find((x) => x.month === monthOf(p.period))?.index ?? null)
        : undefined;
      const values = ns.points.map((p) => p.value);
      const fit = fitTrend(values, { si: siWeek });
      put("niche", ns.niche, "trend", prov, {
        value: { ...fit, yoy: yearOverYear(values, Number.MIN_VALUE) },
        n: values.length,
        s: sampleFactor(fit.windowPoints, target.trend),
        r: reliability(ns.source),
      });
      if (si)
        put("niche", ns.niche, "seasonality", prov, {
          value: { ...si, latest4: values.slice(-4).reduce((a, b) => a + b, 0) / 4 },
          n: si.yearsUsed,
          s: sampleFactor(si.yearsUsed, target.seasonalityYears),
          r: reliability(ns.source),
        });
    }
    // Own niche series: the shop's designs in each niche, summed.
    const byNiche = new Map<string, (number | null)[]>();
    for (const d of allDesigns) {
      const s = designSeries.get(d.id) ?? seriesOf(d.id);
      for (const k of nichesOf.get(d.id)?.niches ?? []) {
        const acc = getOrSet(byNiche, k, () => weekKeys.map(() => null as number | null));
        s.values.forEach((v, i) => {
          if (v !== null) acc[i] = (acc[i] ?? 0) + v;
        });
      }
    }
    for (const [niche, values] of byNiche) {
      const first = values.findIndex((v) => v !== null);
      const age = first < 0 ? 0 : values.length - first;
      const season = ownSeason(values);
      if (season)
        put("niche", niche, "seasonality", ownProv, {
          value: { ...season },
          n: season.yearsUsed,
          s: sampleFactor(season.yearsUsed, target.seasonalityYears),
          r: 1,
        });
      const fit = fitTrend(values, { ageWeeks: age, si: siByWeek(season) });
      put("niche", niche, "trend", ownProv, {
        value: {
          ...fit,
          yoy: yearOverYear(
            values.map((v) => v ?? 0),
            MARKET_CONFIG.yoy.minOwnDenominator,
          ),
        },
        n: values.filter((v) => (v ?? 0) > 0).length,
        s: sampleFactor(fit.windowPoints, target.trend),
        r: 1,
      });
    }
    const census = await censusSeries(tx, run.allowed);
    const censusSi = census ? seasonalityIndex(census.points) : null;
    if (census && censusSi)
      put(
        "shop",
        companyId,
        "seasonality",
        {
          source: "census",
          licence: census.licence,
          asOf: iso(census.asOf),
          fetchedAt: iso(census.fetchedAt),
          mock: census.mock,
        },
        {
          value: { ...censusSi },
          n: censusSi.yearsUsed,
          s: sampleFactor(censusSi.yearsUsed, target.seasonalityYears),
          r: reliability("census"),
        },
      );
  }
  put("shop", companyId, "lead_time", ownProv, {
    value: { medianLeadHours: leadHours, leadTimeWeeks: leadTimeWeeks(leadHours) },
    n: leadHours === null ? 0 : 1,
    s: 1,
    r: 1,
  });

  /* ---- margin and price position per design × channel ---- */
  const since90 = new Date(now.getTime() - MARKET_CONFIG.margin.periodDays * DAY_MS);
  const period = { from: iso(since90), to: iso(now) };
  const profitBy = new Map<string, ProfitRow>();
  const channelsWithProfit = new Set<Channel>();
  for (const ch of [
    ...new Set<Channel>(["etsy", "amazon", "shopify", "tiktok", "walmart", "ebay", "csv"]),
  ]) {
    const p = await getProfit(
      tx,
      { companyId },
      { dimension: "design", period, channel: ch, limit: 100_000 },
    );
    for (const r of p.rows) {
      profitBy.set(`${r.key}:${ch}`, r);
      channelsWithProfit.add(ch);
    }
  }
  const all = await getProfit(tx, { companyId }, { dimension: "design", period, limit: 100_000 });
  const profitAll = new Map(all.rows.map((r) => [r.key, r]));

  const snapshots = await tx
    .select()
    .from(marketPriceSnapshots)
    .where(
      and(
        eq(marketPriceSnapshots.companyId, companyId),
        eq(marketPriceSnapshots.granularity, "day"),
        run.allowed ? undefined : eq(marketPriceSnapshots.mock, false),
        run.scoped ? inArray(marketPriceSnapshots.designId, designIds) : undefined,
      ),
    )
    .orderBy(desc(marketPriceSnapshots.period));
  const latestSnap = new Map<string, typeof marketPriceSnapshots.$inferSelect>();
  for (const s of snapshots) {
    const k = `${s.designId}:${s.channel}`;
    if (!latestSnap.has(k)) latestSnap.set(k, s);
  }
  const listedBy = new Map<string, Set<Channel>>();
  for (const l of listed) getOrSet(listedBy, l.designId, () => new Set()).add(l.channel);

  const channelsOf = (designId: string): Channel[] => {
    const set = new Set<Channel>();
    for (const ch of prices.get(designId)?.keys() ?? []) set.add(ch);
    for (const ch of weekly.get(designId)?.keys() ?? []) {
      if (profitBy.has(`${designId}:${ch}`)) set.add(ch);
    }
    return [...set];
  };

  // Density inputs (Amazon only): offers on comparables ÷ the niche's latest outside interest.
  const interestOf = (niche: string | undefined) => {
    if (!niche) return null;
    for (const src of OUTSIDE_DEMAND_SOURCES) {
      const ns = outside.find((o) => o.niche === niche && o.source === src);
      if (ns?.points.length)
        return ns.points.slice(-4).reduce((a, p) => a + p.value, 0) / Math.min(4, ns.points.length);
    }
    return null;
  };
  const densityRaw = new Map<string, number>();

  type ListingCalc = {
    designId: string;
    channel: Channel;
    p0: number | null;
    margin: { marginPct: number; floorPriceCents: number | null; units: number } | null;
    price: {
      prov: Provenance;
      n: number;
      available: boolean;
      priceBand: "low" | "market" | "premium" | null;
      medianCents: number | null;
      value: Record<string, unknown>;
    } | null;
  };
  const listingCalcs: ListingCalc[] = [];
  for (const d of designs) {
    const blank = blanks.get(d.id);
    for (const ch of channelsOf(d.id)) {
      const byWeek = weekly.get(d.id)?.get(ch);
      let units = 0;
      let gross = 0;
      const cutoffWeek = weekKeys[Math.max(0, weekKeys.length - 13)] ?? "";
      for (const [k, c] of byWeek ?? []) {
        if (k >= cutoffWeek) {
          units += c.units;
          gross += c.grossCents;
        }
      }
      const avgPrice = units > 0 ? Math.round(gross / units) : null;
      const p0 = prices.get(d.id)?.get(ch) ?? avgPrice;
      const fee = feeFn(tables, ch, blank?.style ?? null);
      const row = profitBy.get(`${d.id}:${ch}`) ?? profitAll.get(d.id);
      const mb = marginBasis(row, avgPrice ?? p0, fee);
      let margin: ListingCalc["margin"] = null;
      if (p0 !== null && !mb.missing.includes("unit_cost")) {
        const marginPct = marginPctAt(p0, mb.basis);
        const floor = floorPriceCents(
          mb.basis,
          priceEnding(p0),
          MARKET_CONFIG.margin.floorMarginPct,
        );
        margin = { marginPct, floorPriceCents: floor, units: mb.units };
        put("listing", `${d.id}:${ch}`, "margin", ownProv, {
          value: {
            channel: ch,
            currentPriceCents: p0,
            marginPct,
            netPerUnitCents: netAt(p0, mb.basis),
            floorPriceCents: floor,
            breakEvenCents: breakEvenCents(mb.basis),
          },
          n: mb.units,
          s: sampleFactor(mb.units, target.ownUnits),
          r: 1,
        });
      }
      let price: ListingCalc["price"] = null;
      const snap = latestSnap.get(`${d.id}:${ch}`);
      if (snap && (ch === "amazon" || ch === "walmart")) {
        const prov: Provenance = {
          source: snap.source,
          licence: snap.licence,
          asOf: iso(snap.asOf),
          fetchedAt: iso(snap.fetchedAt),
          mock: snap.mock,
        };
        const kept = filterComparables(snap.observations as Observation[], d.personalized);
        const stats = priceStats(kept);
        const n = kept.length;
        const available = !!stats && n >= MARKET_CONFIG.price.minComparables && p0 !== null;
        const pos =
          stats && p0 !== null
            ? pricePercentile(
                kept.map((o) => o.landedPriceCents),
                p0,
              )
            : null;
        const value: Record<string, unknown> = {
          channel: ch,
          available,
          currentPriceCents: p0,
          ...(stats ?? {}),
          n,
          percentile: pos?.percentile ?? null,
          priceBand: pos?.band ?? null,
          density: null,
        };
        price = {
          prov,
          n,
          available,
          priceBand: pos?.band ?? null,
          medianCents: stats?.medianCents ?? null,
          value,
        };
        if (ch === "amazon" && stats?.offerCount) {
          const interest = interestOf(nichesOf.get(d.id)?.niches[0]);
          if (interest && interest > 0)
            densityRaw.set(`${d.id}:${ch}`, stats.offerCount / interest);
        }
      }
      listingCalcs.push({ designId: d.id, channel: ch, p0, margin, price });
    }
  }
  const density = terciles(densityRaw);
  for (const lc of listingCalcs) {
    if (!lc.price) continue;
    lc.price.value.density = density.get(`${lc.designId}:${lc.channel}`) ?? null;
    put("listing", `${lc.designId}:${lc.channel}`, "price_position", lc.price.prov, {
      value: lc.price.value,
      n: lc.price.n,
      s: sampleFactor(lc.price.n, target.comparables),
      r: reliability(lc.price.prov.source),
    });
  }

  /* ---- persist signals ---- */
  const ids = await upsertSignals(tx, signals);
  if (!run.scoped) {
    // Rows not rewritten today describe subjects that no longer exist (or a source now hidden).
    await tx
      .delete(marketSignals)
      .where(and(eq(marketSignals.companyId, companyId), ne(marketSignals.computedOn, today)));
  }

  /* ---- rules ---- */
  const rowOf = (
    subjectType: string,
    subjectId: string,
    signal: string,
    source: string,
  ): SignalRow | null => {
    const s = signals.find(
      (x) =>
        x.subjectType === subjectType &&
        x.subjectId === subjectId &&
        x.signal === signal &&
        x.source === source,
    );
    const id = ids.get(`${subjectType}|${subjectId}|${signal}|${source}`);
    return s && id ? ({ ...s, id } as SignalRow) : null;
  };
  const rowsFor = (subjectType: string, subjectId: string, signal: string) =>
    signals
      .filter(
        (x) => x.subjectType === subjectType && x.subjectId === subjectId && x.signal === signal,
      )
      .map((x) => rowOf(subjectType, subjectId, signal, x.source as string))
      .filter((x): x is SignalRow => !!x);
  const leadRow = rowOf("shop", companyId, "lead_time", "own");
  const shopSeasonRows = rowsFor("shop", companyId, "seasonality");
  const storedNicheRows = run.scoped
    ? await tx
        .select()
        .from(marketSignals)
        .where(and(eq(marketSignals.companyId, companyId), eq(marketSignals.subjectType, "niche")))
    : [];
  const nicheRowsFor = (niche: string, signal: string): SignalRow[] =>
    run.scoped
      ? (storedNicheRows.filter((r) => r.subjectId === niche && r.signal === signal) as SignalRow[])
      : rowsFor("niche", niche, signal);
  const shopRows = run.scoped
    ? ((await tx
        .select()
        .from(marketSignals)
        .where(
          and(eq(marketSignals.companyId, companyId), eq(marketSignals.subjectType, "shop")),
        )) as SignalRow[])
    : [];

  const drafts: RecommendationDraft[] = [];
  const scoredOf = (row: SignalRow, a = 1): Scored & { prov: Provenance } => {
    const prov: Provenance = {
      source: row.source,
      licence: row.licence,
      asOf: iso(row.asOf),
      fetchedAt: iso(row.fetchedAt),
      mock: row.mock,
    };
    const confidence = combine({
      s: row.sampleFactor,
      f: freshness(row.source, row.source === "census" ? row.fetchedAt : row.asOf, now),
      r: row.reliability,
      a,
    });
    return { confidence, band: band(confidence), sources: [prov], signalIds: [row.id], prov };
  };

  for (const d of designs) {
    const nm = nichesOf.get(d.id);
    const primary = nm?.niches[0] ?? null;
    const mapperConf = nm?.row.source === "model" ? (nm.row.confidence ?? null) : null;
    const trend = buildTrend({
      own: rowOf("design", d.id, "trend", "own"),
      outside: primary ? nicheRowsFor(primary, "trend").filter((r) => r.source !== "own") : [],
      mapperConfidence: mapperConf,
      now,
      subject: { designId: d.id, designName: d.name, niche: primary },
    });
    const ownTrendRow = rowOf("design", d.id, "trend", "own");
    const season = buildSeason({
      designOwn: rowOf("design", d.id, "seasonality", "own"),
      nicheRows: primary ? nicheRowsFor(primary, "seasonality") : [],
      census:
        [...shopSeasonRows, ...shopRows.filter((r) => r.signal === "seasonality")].find(
          (r) => r.source === "census",
        ) ?? null,
      lead: leadRow ?? shopRows.find((r) => r.signal === "lead_time") ?? null,
      mapperConfidence: mapperConf,
      now,
      timeZone,
      subject: { designId: d.id, designName: d.name, niche: primary },
    });
    const ds = designSeries.get(d.id);
    let expectedUnits: number | null = null;
    if (season.actBy && ds && ds.values.length >= 52) {
      const lastYear = ds.values.slice(-52);
      const lastYearWeeks = weeks.slice(-52);
      const peakUnits = lastYear.reduce<number>(
        (a, v, i) => a + (lastYearWeeks[i]?.month === season.actBy?.peakMonth ? (v ?? 0) : 0),
        0,
      );
      const ownYoy = (ownTrendRow?.value as { yoy?: number | null } | undefined)?.yoy ?? null;
      if (peakUnits > 0) expectedUnits = Math.round(peakUnits * (1 + (ownYoy ?? 0)));
    }
    const blank = blanks.get(d.id);
    const listedChannels = new Set<Channel>(listedBy.get(d.id) ?? []);
    for (const ch of prices.get(d.id)?.keys() ?? []) listedChannels.add(ch);
    const facts: DesignFacts = {
      designId: d.id,
      designName: d.name,
      connectedChannels: connected,
      listedChannels: [...listedChannels],
      blank: blank
        ? { id: blank.id, name: blank.name, belowReorderPoint: blank.belowReorderPoint }
        : null,
      season:
        season.indexSource && season.seasonRow
          ? {
              ...scoredOf(season.seasonRow),
              confidence: season.confidence,
              band: season.band,
              peakMonths: season.peakMonths,
              offMonths: season.offMonths,
              actBy: season.actBy,
              expectedUnits,
            }
          : null,
      ownTrend: ownTrendRow
        ? {
            confidence: trend.confidence,
            band: trend.band,
            sources: [scoredOf(ownTrendRow).prov],
            signalIds: [ownTrendRow.id],
            trend:
              trend.readings.find((r) => r.provenance.source === "own")?.trend ?? "insufficient",
          }
        : null,
      channels: listingCalcs
        .filter((lc) => lc.designId === d.id)
        .map((lc): ChannelFacts => {
          const mRow = rowOf("listing", `${d.id}:${lc.channel}`, "margin", "own");
          const pRow = lc.price
            ? rowOf("listing", `${d.id}:${lc.channel}`, "price_position", lc.price.prov.source)
            : null;
          return {
            channel: lc.channel,
            currentPriceCents: lc.p0,
            margin:
              lc.margin && mRow
                ? {
                    ...scoredOf(mRow),
                    marginPct: lc.margin.marginPct,
                    floorPriceCents: lc.margin.floorPriceCents,
                  }
                : null,
            price:
              lc.price?.available && pRow && lc.price.priceBand && lc.price.medianCents !== null
                ? {
                    ...scoredOf(pRow),
                    priceBand: lc.price.priceBand,
                    n: lc.price.n,
                    medianCents: lc.price.medianCents,
                  }
                : null,
          };
        }),
      currentMonth,
    };
    drafts.push(...designRules(facts));
  }

  if (!run.scoped) {
    const designsPerNiche = new Map<string, number>();
    for (const d of allDesigns)
      for (const k of nichesOf.get(d.id)?.niches ?? [])
        designsPerNiche.set(k, (designsPerNiche.get(k) ?? 0) + 1);
    for (const [niche, count] of designsPerNiche) {
      const n = nicheByKey(niche);
      if (!n) continue;
      const outsideRows = nicheRowsFor(niche, "trend").filter((r) => r.source !== "own");
      if (!outsideRows.length) continue;
      const t = buildTrend({
        own: null,
        outside: outsideRows,
        mapperConfidence: null,
        now,
        subject: { designId: null, designName: null, niche },
      });
      const facts: NicheFacts = {
        niche,
        outsideTrend: {
          confidence: t.confidence,
          band: t.band,
          sources: t.sources,
          signalIds: outsideRows.map((r) => r.id),
          trend: t.trend,
        },
        designsInNiche: count,
        ideas: n.queries.filter((q) => run.allowedQueries.has(q)).slice(0, 2),
      };
      drafts.push(...nicheRules(facts));
    }
  }

  const recs = await persistRecommendations(
    tx,
    companyId,
    now,
    today,
    drafts.slice(0, MARKET_CONFIG.rules.maxPerRun),
    {
      allowed: run.allowed,
      blanks,
    },
  );
  return { designs: designs.length, signals: signals.length, recommendations: recs };
}

function monthOf(period: string): number {
  // ISO week key → the month of its Thursday.
  const [y, w] = period.split("-W").map(Number) as [number, number];
  const jan4 = Date.UTC(y, 0, 4);
  const dow = new Date(jan4).getUTCDay() || 7;
  const thursday = new Date(jan4 - (dow - 1) * DAY_MS + (w - 1) * 7 * DAY_MS + 3 * DAY_MS);
  return thursday.getUTCMonth() + 1;
}

async function upsertSignals(tx: Tx, rows: SignalInsert[]): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const out = await tx
      .insert(marketSignals)
      .values(chunk)
      .onConflictDoUpdate({
        target: [
          marketSignals.companyId,
          marketSignals.subjectType,
          marketSignals.subjectId,
          marketSignals.signal,
          marketSignals.source,
        ],
        set: {
          value: sql`excluded.value`,
          n: sql`excluded.n`,
          sampleFactor: sql`excluded.sample_factor`,
          reliability: sql`excluded.reliability`,
          agreement: sql`excluded.agreement`,
          licence: sql`excluded.licence`,
          mock: sql`excluded.mock`,
          asOf: sql`excluded.as_of`,
          fetchedAt: sql`excluded.fetched_at`,
          computedOn: sql`excluded.computed_on`,
          updatedAt: new Date(),
        },
      })
      .returning({
        id: marketSignals.id,
        subjectType: marketSignals.subjectType,
        subjectId: marketSignals.subjectId,
        signal: marketSignals.signal,
        source: marketSignals.source,
      });
    for (const r of out) ids.set(`${r.subjectType}|${r.subjectId}|${r.signal}|${r.source}`, r.id);
  }
  return ids;
}

/** Baseline for the outcome label: the 28 days before creation, for the design and its controls. */
async function baselines(
  tx: Tx,
  companyId: string,
  now: Date,
  designIds: string[],
  blanks: Map<string, { styleName: string | null; style: string }>,
): Promise<Map<string, RecBaseline>> {
  const out = new Map<string, RecBaseline>();
  if (!designIds.length) return out;
  const days = MARKET_CONFIG.feedback.baselineDays;
  const from = new Date(now.getTime() - days * DAY_MS);
  const p = await getProfit(
    tx,
    { companyId },
    { dimension: "design", period: { from: iso(from), to: iso(now) }, limit: 100_000 },
  );
  const by = new Map(p.rows.map((r) => [r.key, r]));
  const classOf = (id: string) => garmentClass(blanks.get(id));
  const prices = await currentPrices(tx, companyId, designIds);
  for (const id of designIds) {
    const cls = classOf(id);
    const controls = [...by.keys()].filter(
      (k) => k !== id && k !== "unmapped" && classOf(k) === cls,
    );
    const cu = controls.reduce((a, k) => a + (by.get(k)?.units ?? 0), 0);
    const cn = controls.reduce((a, k) => a + (by.get(k)?.net ?? 0), 0);
    const r = by.get(id);
    const firstPrice = prices.get(id)?.values().next().value;
    out.set(id, {
      from: iso(from),
      to: iso(now),
      unitsPerDay: round4((r?.units ?? 0) / days),
      netPerDayCents: Math.round((r?.net ?? 0) / days),
      priceCents: firstPrice ?? null,
      controlUnitsPerDay: controls.length ? round4(cu / days) : null,
      controlNetPerDayCents: controls.length ? Math.round(cn / days) : null,
      controlDesignIds: controls.slice(0, 50),
      garmentClass: cls,
    });
  }
  return out;
}

async function persistRecommendations(
  tx: Tx,
  companyId: string,
  now: Date,
  today: string,
  drafts: RecommendationDraft[],
  ctx: { allowed: boolean; blanks: Map<string, { styleName: string | null; style: string }> },
): Promise<number> {
  const usable = drafts.filter((d) => ctx.allowed || !d.mock);
  if (!usable.length) return 0;
  const keys = [...new Set(usable.map((d) => d.dedupeKey))];
  const since = new Date(now.getTime() - MARKET_CONFIG.rules.reissueAfterDays * DAY_MS);
  const recent = await tx
    .select({ dedupeKey: marketRecommendations.dedupeKey })
    .from(marketRecommendations)
    .where(
      and(
        eq(marketRecommendations.companyId, companyId),
        inArray(marketRecommendations.dedupeKey, keys),
        gte(marketRecommendations.createdAt, since),
      ),
    );
  const open = new Set(recent.map((r) => r.dedupeKey));
  const fresh = usable.filter((d) => !open.has(d.dedupeKey));
  if (!fresh.length) return 0;
  const base = await baselines(
    tx,
    companyId,
    now,
    [...new Set(fresh.flatMap((d) => (d.designId ? [d.designId] : [])))],
    ctx.blanks,
  );
  const rows = fresh.map((d) => ({
    companyId,
    rule: d.rule,
    action: d.action,
    dedupeKey: d.dedupeKey,
    createdOn: today,
    designId: d.designId,
    niche: d.niche,
    channel: d.channel,
    params: d.params as Record<string, unknown>,
    confidence: d.confidence,
    band: d.band,
    mock: d.mock,
    sources: d.sources,
    evidenceSignalIds: d.evidenceSignalIds,
    signalsSnapshot: { confidence: d.confidence, band: d.band, params: d.params } as Record<
      string,
      unknown
    >,
    baseline: d.designId ? (base.get(d.designId) ?? null) : null,
    staleAfterDays:
      2 * Math.max(...d.sources.map((s) => MARKET_CONFIG.sources[s.source].ttlDays), 1),
    createdAt: now,
    updatedAt: now,
  }));
  const inserted = await tx
    .insert(marketRecommendations)
    .values(rows)
    .onConflictDoNothing({
      target: [
        marketRecommendations.companyId,
        marketRecommendations.dedupeKey,
        marketRecommendations.createdOn,
      ],
    })
    .returning({ id: marketRecommendations.id });
  return inserted.length;
}
