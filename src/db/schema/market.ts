import {
  boolean,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  enumText,
  id,
  jsonArray,
  jsonObject,
  publicReadPolicy,
  tenantPolicy,
  timestamps,
} from "./_shared";
import { designs } from "./catalog";
import { CHANNELS } from "./channels";
import { companyId } from "./tenancy";

/*
 * Market signals (wave 18, `specs/market-signals.md`, ADR 0014 fences, ADR 0015 global cache).
 * Every table here has `company_id` + RLS except `market_series_cache`, the one global table
 * ADR 0015 allows: taxonomy queries and public-source series only, written by the nightly job.
 */

/** Mirrors `SIGNAL_SOURCES` in @invai/contracts (fixed order, additive). */
export const MARKET_SOURCES = [
  "own",
  "census",
  "google_trends",
  "pinterest_trends",
  "amazon_pricing",
  "amazon_brand_analytics",
  "walmart_pricing",
  "jungle_scout",
] as const;
export const MARKET_LICENCES = [
  "first_party",
  "official_api",
  "public_dataset",
  "licensed",
] as const;

/**
 * Global demand cache (ADR 0015). No tenant, connection, user or free-text column: `query` is a
 * canonical taxonomy query (or the Census series id). The app role may only read it.
 */
export const marketSeriesCache = pgTable(
  "market_series_cache",
  {
    id: id(),
    source: text(enumText(MARKET_SOURCES)).notNull(),
    query: text().notNull(),
    granularity: text(enumText(["week", "month"] as const)).notNull(),
    /** ISO week `2026-W38` or month `2026-09`. */
    period: text().notNull(),
    value: doublePrecision().notNull(),
    asOf: timestamp({ withTimezone: true }).notNull(),
    fetchedAt: timestamp({ withTimezone: true }).notNull(),
    licence: text(enumText(MARKET_LICENCES)).notNull(),
    mock: boolean().notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex().on(t.source, t.query, t.granularity, t.period),
    publicReadPolicy("market_series_cache"),
  ],
).enableRLS();

export const NICHE_SOURCES = ["stems", "model", "correction", "unclassified"] as const;

/** A design's 0..2 niches and how it got them. A `correction` is never overwritten by the mapper. */
export const marketDesignNiches = pgTable(
  "market_design_niches",
  {
    id: id(),
    companyId: companyId(),
    designId: uuid().notNull(),
    niches: text().array().notNull().default([]),
    source: text(enumText(NICHE_SOURCES)).notNull().default("unclassified"),
    /** The model's confidence when `source` is `model`. */
    confidence: doublePrecision(),
    correctedBy: uuid(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex().on(t.companyId, t.designId),
    foreignKey({
      name: "market_design_niches_design_id_fk",
      columns: [t.companyId, t.designId],
      foreignColumns: [designs.companyId, designs.id],
    }).onDelete("cascade"),
    tenantPolicy("market_design_niches"),
  ],
).enableRLS();

export type PriceObservationRow = {
  landedPriceCents: number;
  isFeatured: boolean;
  offerCount: number | null;
  personalized?: boolean;
};

/**
 * Comparable prices for the shop's own design on a channel with a compliant source (Amazon,
 * Walmart). Raw daily rows are kept 90 days, then rolled up into one `month` row (stats only).
 */
export const marketPriceSnapshots = pgTable(
  "market_price_snapshots",
  {
    id: id(),
    companyId: companyId(),
    designId: uuid().notNull(),
    channel: text(enumText(CHANNELS)).notNull(),
    source: text(enumText(MARKET_SOURCES)).notNull(),
    granularity: text(enumText(["day", "month"] as const)).notNull(),
    /** `2026-09-27` (day) or `2026-09` (month). */
    period: text().notNull(),
    /** Identity-free observations (price, featured, offer count); empty on month roll-ups. */
    observations: jsonArray<PriceObservationRow>(),
    personalized: boolean().notNull().default(false),
    n: integer().notNull().default(0),
    q1Cents: integer(),
    medianCents: integer(),
    q3Cents: integer(),
    featuredCents: integer(),
    offerCount: integer(),
    licence: text(enumText(MARKET_LICENCES)).notNull(),
    mock: boolean().notNull(),
    asOf: timestamp({ withTimezone: true }).notNull(),
    fetchedAt: timestamp({ withTimezone: true }).notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex().on(t.companyId, t.designId, t.channel, t.source, t.granularity, t.period),
    index().on(t.companyId, t.granularity, t.period),
    foreignKey({
      name: "market_price_snapshots_design_id_fk",
      columns: [t.companyId, t.designId],
      foreignColumns: [designs.companyId, designs.id],
    }).onDelete("cascade"),
    tenantPolicy("market_price_snapshots"),
  ],
).enableRLS();

export const SIGNAL_SUBJECT_TYPES = ["design", "niche", "listing", "shop"] as const;
export const SIGNAL_KINDS = [
  "trend",
  "seasonality",
  "price_position",
  "margin",
  "lead_time",
] as const;

/**
 * One computed signal per (subject, kind, source): replaced by each daily run. `listing` subjects
 * are `${designId}:${channel}`. Confidence parts are stored; freshness is applied at read time.
 */
export const marketSignals = pgTable(
  "market_signals",
  {
    id: id(),
    companyId: companyId(),
    subjectType: text(enumText(SIGNAL_SUBJECT_TYPES)).notNull(),
    subjectId: text().notNull(),
    signal: text(enumText(SIGNAL_KINDS)).notNull(),
    source: text(enumText(MARKET_SOURCES)).notNull(),
    value: jsonObject<Record<string, unknown>>(),
    n: integer().notNull().default(0),
    /** Sample-size factor s, reliability r (incl. the mapper's confidence), agreement a. */
    sampleFactor: doublePrecision().notNull().default(0),
    reliability: doublePrecision().notNull().default(0),
    agreement: doublePrecision().notNull().default(1),
    licence: text(enumText(MARKET_LICENCES)).notNull(),
    mock: boolean().notNull(),
    /** The date the data describes; freshness decays from here. */
    asOf: timestamp({ withTimezone: true }).notNull(),
    fetchedAt: timestamp({ withTimezone: true }).notNull(),
    /** Shop-local date of the run that wrote it (`YYYY-MM-DD`). */
    computedOn: text().notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex().on(t.companyId, t.subjectType, t.subjectId, t.signal, t.source),
    index().on(t.companyId, t.computedOn),
    tenantPolicy("market_signals"),
  ],
).enableRLS();

export const MARKET_RULE_KEYS = ["R1", "R2", "R3", "R4", "R5"] as const;
export const MARKET_ACTION_KEYS = [
  "list_and_stock",
  "price_test_up",
  "raise_to_floor_or_stop_ads",
  "new_designs_in_niche",
  "pause_ads_and_deprioritize",
] as const;
export const REC_VOTES = ["done", "not_useful"] as const;
export const REC_SHOWN_IN = ["assistant", "digest"] as const;
export const REC_OUTCOMES = ["improved", "worse", "inconclusive", "not_adopted"] as const;

export type RecSource = {
  source: (typeof MARKET_SOURCES)[number];
  licence: (typeof MARKET_LICENCES)[number];
  asOf: string;
  fetchedAt: string;
  mock: boolean;
};

/** 28-day baseline at creation: units/day, net/day and price, for the outcome label. */
export type RecBaseline = {
  from: string;
  to: string;
  unitsPerDay: number;
  netPerDayCents: number;
  priceCents: number | null;
  controlUnitsPerDay: number | null;
  controlNetPerDayCents: number | null;
  controlDesignIds: string[];
  garmentClass: string | null;
};

/**
 * A recommendation (spec step 7): rule, fixed action + params, confidence, sources, baseline,
 * where it was shown, the shop's vote, adoption and outcome. `dedupeKey` = rule:target:channel;
 * one row per key per creation day, so a re-run the same day adds nothing.
 */
export const marketRecommendations = pgTable(
  "market_recommendations",
  {
    id: id(),
    companyId: companyId(),
    rule: text(enumText(MARKET_RULE_KEYS)).notNull(),
    action: text(enumText(MARKET_ACTION_KEYS)).notNull(),
    dedupeKey: text().notNull(),
    createdOn: text().notNull(),
    designId: uuid(),
    niche: text(),
    channel: text(enumText(CHANNELS)),
    params: jsonObject<Record<string, unknown>>(),
    confidence: doublePrecision().notNull(),
    band: text(enumText(["high", "medium", "low"] as const)).notNull(),
    mock: boolean().notNull(),
    sources: jsonArray<RecSource>(),
    evidenceSignalIds: uuid().array().notNull().default([]),
    signalsSnapshot: jsonb().$type<Record<string, unknown>>(),
    baseline: jsonb().$type<RecBaseline>(),
    /** Days of freshness the slowest source allows before the recommendation reads as stale. */
    staleAfterDays: doublePrecision().notNull(),
    shownIn: text(enumText(REC_SHOWN_IN)),
    shownAt: timestamp({ withTimezone: true }),
    shownRef: text(),
    vote: text(enumText(REC_VOTES)),
    votedAt: timestamp({ withTimezone: true }),
    votedBy: uuid(),
    adoptedAt: timestamp({ withTimezone: true }),
    outcome: text(enumText(REC_OUTCOMES)),
    outcomeAt: timestamp({ withTimezone: true }),
    outcomeDetail: jsonb().$type<Record<string, unknown>>(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex().on(t.companyId, t.dedupeKey, t.createdOn),
    index().on(t.companyId, t.createdAt),
    index().on(t.companyId, t.designId),
    foreignKey({
      name: "market_recommendations_design_id_fk",
      columns: [t.companyId, t.designId],
      foreignColumns: [designs.companyId, designs.id],
    }).onDelete("cascade"),
    tenantPolicy("market_recommendations"),
  ],
).enableRLS();
