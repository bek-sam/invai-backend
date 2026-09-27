import type {
  Channel,
  ConfidenceBand,
  DesignNiches,
  DesignNichesSetInput,
  MarketRecommendation,
  MarketRule,
  MarketSeasonality,
  MarketTrend,
  NicheTaxonomyEntry,
  PricePosition,
  PriceSimulation,
  RecommendationVote,
  SignalProvenance,
} from "@invai/contracts";
import { ORPCError } from "@orpc/server";
import { and, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import type { TenantContext } from "../../api/context";
import { afterCommit, type Tx } from "../../db/client";
import { designs, marketDesignNiches, marketRecommendations, marketSignals } from "../../db/schema";
import { notFound } from "../../lib/errors";
import { errorData, logger } from "../../lib/log";
import { keyset, type PageInput } from "../../lib/pagination";
import { getProfit } from "../finance/service";
import { isSampleWorkspace } from "../tenancy/demo-flag";
import { feeFn, feeTables, marginBasis } from "./compute";
import { band, bandAtLeast, combine } from "./confidence";
import { MARKET_CONFIG, mockSourcesAllowed } from "./config";
import { integrationsMarket } from "./deps";
import {
  activeListings,
  companyInfo,
  connections,
  currentPrices,
  designBlanks,
  ownPricePoints,
  ownWeekly,
} from "./history";
import { NICHES, nicheByKey } from "./niches";
import {
  buildSeason,
  buildTrend,
  provenanceOf,
  rowFreshness,
  rowStale,
  type SignalRow,
} from "./read";
import {
  breakEvenCents,
  candidatePrices,
  completeWeeks,
  floorPriceCents,
  marginPctAt,
  netAt,
  priceEnding,
  priceResponse,
  round4,
  unitsAt,
} from "./signals";

/*
 * Market signals read service (T-18-3, wave 18, `specs/market-signals.md`). Every function runs
 * inside the caller's `withTenant` and only reads stored signals (computed by the jobs), except
 * `simulatePrice`, which is own-data arithmetic, and the shop's own niche correction and votes.
 * Nothing here writes a price, listing, ad, stock or PO row (AC16).
 */

type Ctx = Pick<TenantContext, "companyId">;
export type Subject = { designId: string } | { niche: string };

const DAY_MS = 86_400_000;
const log = logger("market");

export { mockSourcesAllowed } from "./config";
export { NICHES, nicheLabel } from "./niches";

/* ------------------------------------ helpers ------------------------------------ */

async function loadDesign(tx: Tx, ctx: Ctx, designId: string) {
  const [d] = await tx
    .select({
      id: designs.id,
      name: designs.name,
      tags: designs.tags,
      template: designs.personalizationTemplateId,
    })
    .from(designs)
    .where(and(eq(designs.companyId, ctx.companyId), eq(designs.id, designId)));
  if (!d) throw notFound("Design", designId);
  return d;
}

async function nicheRowOf(tx: Tx, ctx: Ctx, designId: string) {
  const [row] = await tx
    .select()
    .from(marketDesignNiches)
    .where(
      and(
        eq(marketDesignNiches.companyId, ctx.companyId),
        eq(marketDesignNiches.designId, designId),
      ),
    );
  return row ?? null;
}

async function signalRows(
  tx: Tx,
  ctx: Ctx,
  where: {
    subjectType: SignalRow["subjectType"];
    subjectId: string;
    signal?: SignalRow["signal"];
  }[],
  allowed: boolean,
): Promise<SignalRow[]> {
  if (!where.length) return [];
  const rows = await tx
    .select()
    .from(marketSignals)
    .where(
      and(
        eq(marketSignals.companyId, ctx.companyId),
        or(
          ...where.map((w) =>
            and(
              eq(marketSignals.subjectType, w.subjectType),
              eq(marketSignals.subjectId, w.subjectId),
              w.signal ? eq(marketSignals.signal, w.signal) : undefined,
            ),
          ),
        ),
      ),
    );
  // The mock visibility rule: a mock row is no source unless mocks may be shown here.
  return allowed ? rows : rows.filter((r) => !r.mock);
}

/** The design's primary niche (for outside signals) and the mapper's confidence if the model chose it. */
async function subjectOf(tx: Tx, ctx: Ctx, input: Subject) {
  if ("designId" in input) {
    const d = await loadDesign(tx, ctx, input.designId);
    const n = await nicheRowOf(tx, ctx, d.id);
    const niche = n?.niches[0] ?? null;
    return {
      design: d,
      niche,
      mapperConfidence: n?.source === "model" ? (n.confidence ?? null) : null,
      subject: { designId: d.id, designName: d.name, niche },
    };
  }
  const known = nicheByKey(input.niche) ? input.niche : null;
  return {
    design: null,
    niche: known,
    mapperConfidence: null,
    subject: { designId: null, designName: null, niche: known },
  };
}

/* ------------------------------------ signals ------------------------------------ */

/** `get_market_trend`: own and outside readings side by side, disagreement stated. */
export async function getTrendSignal(tx: Tx, ctx: Ctx, input: Subject): Promise<MarketTrend> {
  const s = await subjectOf(tx, ctx, input);
  const allowed = await mockSourcesAllowed(ctx.companyId);
  const rows = await signalRows(
    tx,
    ctx,
    [
      ...(s.design
        ? [{ subjectType: "design" as const, subjectId: s.design.id, signal: "trend" as const }]
        : []),
      ...(s.niche
        ? [{ subjectType: "niche" as const, subjectId: s.niche, signal: "trend" as const }]
        : []),
    ],
    allowed,
  );
  const own = s.design
    ? (rows.find((r) => r.subjectType === "design" && r.source === "own") ?? null)
    : (rows.find((r) => r.subjectType === "niche" && r.source === "own") ?? null);
  const outside = rows.filter((r) => r.subjectType === "niche" && r.source !== "own");
  return buildTrend({
    own,
    outside,
    mapperConfidence: s.mapperConfidence,
    now: new Date(),
    subject: s.subject,
  });
}

/** `get_seasonality`: index, peaks, act-by date, and which source the index came from. */
export async function getSeasonalitySignal(
  tx: Tx,
  ctx: Ctx,
  input: Subject,
): Promise<MarketSeasonality> {
  const s = await subjectOf(tx, ctx, input);
  const allowed = await mockSourcesAllowed(ctx.companyId);
  const rows = await signalRows(
    tx,
    ctx,
    [
      ...(s.design
        ? [
            {
              subjectType: "design" as const,
              subjectId: s.design.id,
              signal: "seasonality" as const,
            },
          ]
        : []),
      ...(s.niche
        ? [{ subjectType: "niche" as const, subjectId: s.niche, signal: "seasonality" as const }]
        : []),
      { subjectType: "shop" as const, subjectId: ctx.companyId },
    ],
    allowed,
  );
  const { timeZone } = await companyInfo(tx, ctx.companyId);
  const { seasonRow: _row, ...season } = buildSeason({
    designOwn: rows.find((r) => r.subjectType === "design" && r.source === "own") ?? null,
    nicheRows: rows.filter((r) => r.subjectType === "niche"),
    census:
      rows.find(
        (r) => r.subjectType === "shop" && r.signal === "seasonality" && r.source === "census",
      ) ?? null,
    lead: rows.find((r) => r.subjectType === "shop" && r.signal === "lead_time") ?? null,
    mapperConfidence: s.mapperConfidence,
    now: new Date(),
    timeZone,
    subject: s.subject,
  });
  return season;
}

function unavailable(
  base: { subject: MarketTrend["subject"]; channel: Channel; currentPriceCents: number | null },
  reason: "no_compliant_source" | "not_connected" | "too_few_comparables",
  extra: Partial<{
    n: number;
    sources: SignalProvenance[];
    stale: boolean;
    mock: boolean;
    confidence: number;
  }> = {},
): PricePosition {
  const confidence = extra.confidence ?? 0;
  return {
    ...base,
    available: false,
    reason,
    n: extra.n ?? 0,
    confidence,
    band: band(confidence),
    stale: extra.stale ?? false,
    mock: extra.mock ?? false,
    sources: extra.sources ?? [],
    asOf: new Date().toISOString(),
  };
}

/**
 * `get_price_position`. `available: false` is a normal answer: no compliant source for the
 * channel (Etsy, TikTok, Shopify, or only a mock where mocks may not be shown), the channel isn't
 * connected, or fewer than 8 comparables survive the filter.
 */
export async function getPricePosition(
  tx: Tx,
  ctx: Ctx,
  input: { designId: string; channel: Channel },
): Promise<PricePosition> {
  const d = await loadDesign(tx, ctx, input.designId);
  const n = await nicheRowOf(tx, ctx, d.id);
  const subject = { designId: d.id, designName: d.name, niche: n?.niches[0] ?? null };
  const price =
    (await currentPrices(tx, ctx.companyId, [d.id])).get(d.id)?.get(input.channel) ?? null;
  const base = { subject, channel: input.channel, currentPriceCents: price };
  if (input.channel !== "amazon" && input.channel !== "walmart")
    return unavailable(base, "no_compliant_source");
  const conn = (await connections(tx, ctx.companyId)).find(
    (c) => c.channel === input.channel && c.status === "connected",
  );
  if (!conn) return unavailable(base, "not_connected");
  const allowed = await mockSourcesAllowed(ctx.companyId);
  const provider = integrationsMarket().marketPricingProvider({
    sampleWorkspace: await isSampleWorkspace(ctx.companyId),
    channel: input.channel,
    connection: {
      id: conn.id,
      companyId: conn.companyId,
      status: conn.status,
      provider: conn.provider,
    },
  });
  if (!provider || (provider.mock && !allowed)) return unavailable(base, "no_compliant_source");
  const [row] = await signalRows(
    tx,
    ctx,
    [{ subjectType: "listing", subjectId: `${d.id}:${input.channel}`, signal: "price_position" }],
    allowed,
  );
  if (!row) return unavailable(base, "too_few_comparables");
  const v = row.value as {
    available: boolean;
    percentile: number | null;
    priceBand: "low" | "market" | "premium" | null;
    q1Cents?: number;
    medianCents?: number;
    q3Cents?: number;
    featuredCents?: number | null;
    density?: "less_crowded" | "typical" | "crowded" | null;
    currentPriceCents: number | null;
  };
  const now = new Date();
  const confidence = combine({
    s: row.sampleFactor,
    f: rowFreshness(row, now),
    r: row.reliability,
    a: 1,
  });
  const common = {
    n: row.n,
    sources: [provenanceOf(row)],
    stale: rowStale(row, now),
    mock: row.mock,
    confidence,
  };
  if (
    !v.available ||
    row.n < MARKET_CONFIG.price.minComparables ||
    v.percentile === null ||
    v.priceBand === null ||
    v.q1Cents === undefined ||
    v.medianCents === undefined ||
    v.q3Cents === undefined
  )
    return unavailable(base, "too_few_comparables", common);
  return {
    ...base,
    currentPriceCents: price ?? v.currentPriceCents,
    available: true,
    ...common,
    band: band(confidence),
    asOf: row.updatedAt.toISOString(),
    percentile: v.percentile,
    priceBand: v.priceBand,
    q1Cents: v.q1Cents,
    medianCents: v.medianCents,
    q3Cents: v.q3Cents,
    featuredPriceCents: v.featuredCents ?? null,
    density: input.channel === "amazon" ? (v.density ?? null) : null,
  };
}

/**
 * `simulate_price`: margin at candidate prices from the trailing 90 days of the shop's own profit
 * data (always available). `incomplete` when cost lines are missing. Volume effects only with a
 * price-response estimate (≥ 2 own price points of ≥ 30 units).
 */
export async function simulatePrice(
  tx: Tx,
  ctx: Ctx,
  input: { designId: string; channel: Channel; prices?: number[] },
): Promise<PriceSimulation> {
  const d = await loadDesign(tx, ctx, input.designId);
  const n = await nicheRowOf(tx, ctx, d.id);
  const now = new Date();
  const days = MARKET_CONFIG.margin.periodDays;
  const period = {
    from: new Date(now.getTime() - days * DAY_MS).toISOString(),
    to: now.toISOString(),
  };
  const [onChannel, anyChannel] = await Promise.all([
    getProfit(tx, ctx, { dimension: "design", period, channel: input.channel, designId: d.id }),
    getProfit(tx, ctx, { dimension: "design", period, designId: d.id }),
  ]);
  const row =
    onChannel.rows.find((r) => r.key === d.id) ?? anyChannel.rows.find((r) => r.key === d.id);
  const { timeZone } = await companyInfo(tx, ctx.companyId);
  const weeks = completeWeeks(now, timeZone, 13);
  const from = new Date(`${weeks[0]?.monday}T00:00:00Z`);
  const weekly = (await ownWeekly(tx, ctx.companyId, timeZone, from, [d.id])).get(d.id);
  const cells = [...(weekly?.get(input.channel)?.entries() ?? [])].filter(([k]) =>
    weeks.some((w) => w.key === k),
  );
  const units13 = cells.reduce((a, [, c]) => a + c.units, 0);
  const gross13 = cells.reduce((a, [, c]) => a + c.grossCents, 0);
  const avgPrice = units13 > 0 ? Math.round(gross13 / units13) : null;
  const p0 =
    (await currentPrices(tx, ctx.companyId, [d.id])).get(d.id)?.get(input.channel) ?? avgPrice;
  const blank = (
    await designBlanks(tx, ctx.companyId, new Date(now.getTime() - 365 * DAY_MS), [d.id])
  ).get(d.id);
  const fee = feeFn(await feeTables(tx, ctx.companyId), input.channel, blank?.style ?? null);
  const mb = marginBasis(row, avgPrice ?? p0, fee);

  const pos =
    input.channel === "amazon" || input.channel === "walmart"
      ? await getPricePosition(tx, ctx, { designId: d.id, channel: input.channel })
      : null;
  const comparables = pos?.available ? pos : null;
  const requested = (input.prices ?? []).slice(0, MARKET_CONFIG.margin.maxRequested);
  const response = priceResponse(
    await ownPricePoints(
      tx,
      ctx.companyId,
      d.id,
      input.channel,
      new Date(now.getTime() - 156 * 7 * DAY_MS),
      timeZone,
    ),
  );
  const q0 = units13 / Math.max(1, weeks.length);
  const incomplete = mb.missing.length > 0;
  const candidates = candidatePrices({ currentCents: p0, requested, comparables }).map((c) => {
    const net = netAt(c.priceCents, mb.basis);
    const est =
      response && p0 !== null && q0 > 0
        ? round4(unitsAt(q0, p0, c.priceCents, response.elasticity))
        : null;
    return {
      priceCents: c.priceCents,
      origin: c.origin,
      netPerUnitCents: net,
      marginPct: marginPctAt(c.priceCents, mb.basis),
      estimatedWeeklyUnits: est,
      estimatedWeeklyNetCents: est === null ? null : Math.round(est * net),
    };
  });
  const own: SignalProvenance = {
    source: "own",
    licence: "first_party",
    asOf: now.toISOString(),
    fetchedAt: now.toISOString(),
    mock: await isSampleWorkspace(ctx.companyId),
  };
  const sources = [own, ...(comparables ? comparables.sources : [])];
  const confidence = combine({
    s: Math.min(1, mb.units / MARKET_CONFIG.confidence.target.ownUnits),
    f: 1,
    r: 1,
    a: 1,
  });
  const feeAtP0 = p0 !== null ? mb.basis.fees(p0) : null;
  const revenueAtP0 = p0 !== null ? p0 + mb.basis.shippingChargedCents : null;
  return {
    subject: { designId: d.id, designName: d.name, niche: n?.niches[0] ?? null },
    confidence,
    band: band(confidence),
    stale: false,
    mock: sources.some((s) => s.mock),
    sources,
    asOf: now.toISOString(),
    channel: input.channel,
    currentPriceCents: p0,
    costBasis: {
      unitCostCents: mb.unitCostCents,
      shippingChargedCents: mb.shippingChargedCents,
      adsPerUnitCents: mb.adsPerUnitCents,
      refundRate: mb.refundRate,
      feePct:
        feeAtP0 !== null && revenueAtP0
          ? round4(((feeAtP0 - mb.feeFixedCents) / revenueAtP0) * 100)
          : null,
      feeFixedCents: mb.feeFixedCents,
      periodDays: days,
    },
    candidates,
    breakEvenCents: incomplete ? null : breakEvenCents(mb.basis),
    floorPriceCents: incomplete
      ? null
      : floorPriceCents(mb.basis, priceEnding(p0), MARKET_CONFIG.margin.floorMarginPct),
    floorMarginPct: MARKET_CONFIG.margin.floorMarginPct,
    priceResponse: response,
    incomplete,
    missing: mb.missing,
  };
}

/* ------------------------------------ niches ------------------------------------ */

export function nicheTaxonomy(): { items: NicheTaxonomyEntry[] } {
  return {
    items: NICHES.map((n) => ({
      key: n.key,
      family: n.family,
      labelEn: n.labelEn,
      labelEs: n.labelEs,
      peakMonths: [...n.peakMonths],
    })),
  };
}

function toDesignNiches(
  designId: string,
  row: typeof marketDesignNiches.$inferSelect | null,
): DesignNiches {
  if (!row)
    return { designId, niches: [], source: "unclassified", confidence: null, updatedAt: null };
  return {
    designId,
    niches: row.niches.slice(0, 2),
    source: row.niches.length
      ? row.source
      : row.source === "correction"
        ? "correction"
        : "unclassified",
    confidence: row.source === "model" ? (row.confidence ?? null) : null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function getDesignNiches(
  tx: Tx,
  ctx: Ctx,
  input: { designId: string },
): Promise<DesignNiches> {
  await loadDesign(tx, ctx, input.designId);
  return toDesignNiches(input.designId, await nicheRowOf(tx, ctx, input.designId));
}

/** Contracts `UNKNOWN_NICHE` (400). */
export function unknownNiche(key: string) {
  return new ORPCError("UNKNOWN_NICHE", {
    status: 400,
    message: "That niche is not in the list",
    data: { key },
  });
}

/**
 * The shop's correction: replaces the design's niches (≤ 2). An empty list clears the correction
 * (the design reads as unclassified until the mapper runs again, which is queued at once).
 */
export async function setDesignNiches(
  tx: Tx,
  ctx: Pick<TenantContext, "companyId" | "userId">,
  input: DesignNichesSetInput,
): Promise<DesignNiches> {
  await loadDesign(tx, ctx, input.designId);
  for (const k of input.niches) if (!nicheByKey(k)) throw unknownNiche(k);
  const cleared = input.niches.length === 0;
  const values = {
    niches: input.niches,
    source: cleared ? ("unclassified" as const) : ("correction" as const),
    confidence: null,
    correctedBy: cleared ? null : ctx.userId,
  };
  const [row] = await tx
    .insert(marketDesignNiches)
    .values({ companyId: ctx.companyId, designId: input.designId, ...values })
    .onConflictDoUpdate({
      target: [marketDesignNiches.companyId, marketDesignNiches.designId],
      set: { ...values, updatedAt: new Date() },
    })
    .returning();
  const companyId = ctx.companyId;
  const designId = input.designId;
  afterCommit(tx, async () => {
    const { computeSignalsJob } = await import("./jobs");
    await computeSignalsJob.enqueue({ companyId, designIds: [designId] }).catch((err) =>
      log.warn("could not queue market signals after a niche fix", {
        companyId,
        ...errorData(err),
      }),
    );
  });
  return toDesignNiches(input.designId, row ?? null);
}

/* ------------------------------------ recommendations ------------------------------------ */

type RecRow = typeof marketRecommendations.$inferSelect;

export function toRecommendation(
  r: RecRow,
  designName: string | null,
  now = new Date(),
): MarketRecommendation {
  return {
    id: r.id,
    rule: r.rule,
    action: r.action,
    target: { designId: r.designId, designName, niche: r.niche, channel: r.channel },
    params: r.params as MarketRecommendation["params"],
    confidence: r.confidence,
    band: r.band,
    mock: r.mock,
    sources: r.sources.map((s) => ({ ...s })),
    evidenceSignalIds: r.evidenceSignalIds,
    stale: now.getTime() - r.createdAt.getTime() > r.staleAfterDays * DAY_MS,
    shownIn: r.shownIn,
    shownAt: r.shownAt?.toISOString() ?? null,
    vote: r.vote,
    votedAt: r.votedAt?.toISOString() ?? null,
    adoptedAt: r.adoptedAt?.toISOString() ?? null,
    outcome: r.outcome,
    createdAt: r.createdAt.toISOString(),
  };
}

const BANDS_AT_LEAST: Record<ConfidenceBand, ConfidenceBand[]> = {
  high: ["high"],
  medium: ["high", "medium"],
  low: ["high", "medium", "low"],
};

export type RecommendationListInput = PageInput & {
  designId?: string;
  ids?: string[];
  rule?: MarketRule[];
  minBand?: ConfidenceBand;
};

/** The shop's stored recommendations, newest first (cursor page). Mock ones only where allowed. */
export async function listRecommendationsPage(
  tx: Tx,
  ctx: Ctx,
  input: RecommendationListInput,
): Promise<{ items: MarketRecommendation[]; nextCursor: string | null }> {
  const allowed = await mockSourcesAllowed(ctx.companyId);
  const limit = Math.min(input.limit, 200);
  const page = keyset(marketRecommendations.createdAt, marketRecommendations.id, {
    ...input,
    limit,
  });
  const rows = await tx
    .select({ rec: marketRecommendations, designName: designs.name })
    .from(marketRecommendations)
    .leftJoin(designs, eq(designs.id, marketRecommendations.designId))
    .where(
      and(
        eq(marketRecommendations.companyId, ctx.companyId),
        input.designId ? eq(marketRecommendations.designId, input.designId) : undefined,
        input.ids?.length ? inArray(marketRecommendations.id, input.ids) : undefined,
        input.rule?.length ? inArray(marketRecommendations.rule, input.rule) : undefined,
        input.minBand
          ? inArray(marketRecommendations.band, BANDS_AT_LEAST[input.minBand])
          : undefined,
        allowed ? undefined : eq(marketRecommendations.mock, false),
        page.where,
      ),
    )
    .orderBy(...page.orderBy)
    .limit(limit + 1);
  const now = new Date();
  const out = page.result(
    rows.map((r) => ({ ...r, createdAt: r.rec.createdAt, id: r.rec.id })),
    (r) => toRecommendation(r.rec, r.designName ?? null, now),
  );
  return out;
}

/** Agreed interface for the assistant tools: an array, capped at 20 rows by default. */
export async function listRecommendations(
  tx: Tx,
  ctx: Ctx,
  input: { designId?: string; ids?: string[]; minBand?: ConfidenceBand; limit?: number },
): Promise<MarketRecommendation[]> {
  const page = await listRecommendationsPage(tx, ctx, {
    ...input,
    limit: input.limit ?? MARKET_CONFIG.maxRows,
  });
  return page.items;
}

/**
 * The shop's vote. Idempotent: the same vote twice stores one (the first `votedAt` stays); a
 * different vote replaces it. A vote always wins over adoption detection: "done" counts as
 * adopted from the vote, "not useful" clears adoption.
 */
export async function voteRecommendation(
  tx: Tx,
  ctx: Pick<TenantContext, "companyId" | "userId">,
  input: { id: string; vote: RecommendationVote },
): Promise<MarketRecommendation> {
  const [cur] = await tx
    .select()
    .from(marketRecommendations)
    .where(
      and(
        eq(marketRecommendations.companyId, ctx.companyId),
        eq(marketRecommendations.id, input.id),
      ),
    )
    .for("update");
  if (!cur) throw notFound("Recommendation", input.id);
  let row = cur;
  if (cur.vote !== input.vote) {
    const now = new Date();
    const [updated] = await tx
      .update(marketRecommendations)
      .set({
        vote: input.vote,
        votedAt: now,
        votedBy: ctx.userId,
        adoptedAt: input.vote === "done" ? (cur.adoptedAt ?? now) : null,
        ...(input.vote === "not_useful" ? { outcome: null, outcomeAt: null } : {}),
        updatedAt: now,
      })
      .where(eq(marketRecommendations.id, cur.id))
      .returning();
    if (updated) row = updated;
  }
  const name = row.designId
    ? ((
        await tx.select({ name: designs.name }).from(designs).where(eq(designs.id, row.designId))
      )[0]?.name ?? null)
    : null;
  return toRecommendation(row, name);
}

/**
 * Records where recommendations were shown (spec step 7): the first showing wins, so a replayed
 * stream or a digest resend changes nothing. Unknown or other shops' ids are ignored.
 */
export async function recordRecommendationsShown(
  tx: Tx,
  ctx: Ctx,
  input: { ids: string[]; shownIn: "assistant" | "digest"; refId?: string },
): Promise<{ updated: number }> {
  if (!input.ids.length) return { updated: 0 };
  const rows = await tx
    .update(marketRecommendations)
    .set({ shownIn: input.shownIn, shownAt: new Date(), shownRef: input.refId ?? null })
    .where(
      and(
        eq(marketRecommendations.companyId, ctx.companyId),
        inArray(marketRecommendations.id, input.ids.slice(0, 50)),
        isNull(marketRecommendations.shownAt),
      ),
    )
    .returning({ id: marketRecommendations.id });
  return { updated: rows.length };
}

/**
 * Wave 19 digest "Market watch": R1–R5 recommendations for the shop's own designs and niches,
 * band ≥ medium, not stale at `asOf`, created in the 7 days before it, with a trademark-screened
 * niche. Sorted by confidence, at most 20.
 */
export async function listDigestMarketItems(
  tx: Tx,
  ctx: Ctx,
  input: { asOf: Date },
): Promise<MarketRecommendation[]> {
  const allowed = await mockSourcesAllowed(ctx.companyId);
  const since = new Date(input.asOf.getTime() - 7 * DAY_MS);
  const rows = await tx
    .select({ rec: marketRecommendations, designName: designs.name })
    .from(marketRecommendations)
    .leftJoin(designs, eq(designs.id, marketRecommendations.designId))
    .where(
      and(
        eq(marketRecommendations.companyId, ctx.companyId),
        inArray(marketRecommendations.band, ["high", "medium"]),
        gte(marketRecommendations.createdAt, since),
        sql`${marketRecommendations.createdAt} <= ${input.asOf}`,
        allowed ? undefined : eq(marketRecommendations.mock, false),
        or(isNull(marketRecommendations.vote), eq(marketRecommendations.vote, "done")),
      ),
    );
  const items = rows
    .map((r) => toRecommendation(r.rec, r.designName ?? null, input.asOf))
    .filter((r) => !r.stale && bandAtLeast(r.band, "medium"))
    .filter((r) => r.target.niche === null || nicheByKey(r.target.niche) !== undefined)
    .sort((a, b) => b.confidence - a.confidence);
  const screen = integrationsMarket().screen;
  if (!screen || !items.length) return items.slice(0, MARKET_CONFIG.maxRows);
  const terms = [
    ...new Set(
      items.flatMap((r) => [
        ...(r.target.niche ? [nicheByKey(r.target.niche)?.labelEn ?? r.target.niche] : []),
        ...(r.params.ideas ?? []),
      ]),
    ),
  ];
  const ok = new Set((await screen(ctx.companyId, terms)).allowed);
  return items
    .filter(
      (r) =>
        (!r.target.niche || ok.has(nicheByKey(r.target.niche)?.labelEn ?? r.target.niche)) &&
        (r.params.ideas ?? []).every((i) => ok.has(i)),
    )
    .slice(0, MARKET_CONFIG.maxRows);
}

/** Active listings of a design (for adoption detection); re-exported for the feedback job. */
export { activeListings };
