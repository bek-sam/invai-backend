import {
  boolean,
  date,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { enumText, id, jsonObject, tenantPolicy, timestamps } from "./_shared";
import { companyId, users } from "./tenancy";

/*
 * The weekly business review digest (wave 19, `specs/weekly-digest.md`, T-19-3). Every table has
 * `company_id` + RLS; children reference their parent by `(company_id, id)` (S-26), so a row can
 * never point at another shop's digest or insight. Retention: rows older than
 * `DIGEST_CONFIG.retentionWeeks` are purged nightly (modules/digest/jobs.ts). No buyer PII is
 * stored here: facts are counts, cents, channel/design/blank names.
 */

/** DB statuses. `building` and `failed` never leave the backend (contract `DIGEST_STATUSES`). */
export const DIGEST_DB_STATUSES = ["building", "ready", "skipped_quiet", "failed"] as const;
export const DIGEST_NARRATIVE_STATUSES = [
  "none",
  "shadow",
  "ok",
  "rejected",
  "skipped_budget",
  "skipped_off",
] as const;
export const DIGEST_DETECTOR_KEYS = [
  "D1",
  "D2",
  "D3",
  "D4",
  "D5",
  "D6",
  "D7",
  "D8",
  "market",
  "D9",
  "D10",
  "D11",
  "D12",
  "D13",
] as const;
/** Where an insight is shown: one of the ≤ 3 actions, the one win, or the Market watch block. */
export const DIGEST_SECTIONS = ["action", "win", "market"] as const;
export const DIGEST_WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export const DIGEST_DELIVERY_STATUSES = ["pending", "sent", "skipped", "failed"] as const;
export const DIGEST_DELIVERY_CHANNELS = ["email"] as const;
export const DIGEST_FEEDBACK_VOTES = ["up", "down"] as const;
export const DIGEST_FEEDBACK_REASONS = ["not_relevant", "wrong", "already_knew"] as const;

/** Shop-level settings (one row per shop, created on first write; absent = defaults). */
export const digestSettings = pgTable(
  "digest_settings",
  {
    id: id(),
    companyId: companyId(),
    enabled: boolean().notNull().default(true),
    day: text(enumText(DIGEST_WEEKDAYS)).notNull().default("mon"),
    /** Local hour of the send slot, 6..10 (contract `DigestSettings.hour`). */
    hour: integer().notNull().default(7),
    aiSummary: boolean().notNull().default(false),
    ...timestamps,
  },
  (t) => [uniqueIndex().on(t.companyId), tenantPolicy("digest_settings")],
).enableRLS();

/** Stored snapshot and page content (computed facts only; shape in modules/digest/types.ts). */
export type DigestContentJson = Record<string, unknown>;

/** One digest per shop per ISO week (shop time). The unique key makes the build idempotent. */
export const digests = pgTable(
  "digests",
  {
    id: id(),
    companyId: companyId(),
    /** e.g. `2026-W39`. */
    weekKey: text().notNull(),
    /** Local Monday of the week, and the Monday after (exclusive), in `timezone`. */
    weekStart: date({ mode: "string" }).notNull(),
    weekEnd: date({ mode: "string" }).notNull(),
    /** The same bounds as instants, computed in the database from `timezone` (DST-safe). */
    periodFrom: timestamp({ withTimezone: true }).notNull(),
    periodTo: timestamp({ withTimezone: true }).notNull(),
    timezone: text().notNull(),
    status: text(enumText(DIGEST_DB_STATUSES)).notNull().default("building"),
    narrativeStatus: text(enumText(DIGEST_NARRATIVE_STATUSES)).notNull().default("none"),
    /**
     * The AI summary as stored (text, failed rule ids, mode). Never returned by any procedure and
     * never rendered while the mode is `shadow` (contract 0.7.0 has no field for it).
     */
    narrative: jsonObject<DigestContentJson>(),
    /** Glance block, steady flag, partial channels, incomplete orders, fact list. */
    content: jsonObject<DigestContentJson>(),
    /** True when the build ran after the day's email window (catch-up after 20:00, AC4). */
    inAppOnly: boolean().notNull().default(false),
    buildAttempts: integer().notNull().default(0),
    lastError: text(),
    readyAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex().on(t.companyId, t.weekKey),
    unique("digests_company_id_id_unique").on(t.companyId, t.id),
    index().on(t.companyId, t.status, t.weekStart),
    tenantPolicy("digests"),
  ],
).enableRLS();

/** A ranked insight shown in a digest (actions, win, Market watch). */
export const digestInsights = pgTable(
  "digest_insights",
  {
    id: id(),
    companyId: companyId(),
    digestId: uuid().notNull(),
    detector: text(enumText(DIGEST_DETECTOR_KEYS)).notNull(),
    section: text(enumText(DIGEST_SECTIONS)).notNull(),
    rank: integer().notNull(),
    score: doublePrecision().notNull(),
    confidence: doublePrecision().notNull(),
    impactCents: integer(),
    /**
     * Stable identity across weeks for repeat suppression (AC12), e.g. `D6:overdue:etsy`,
     * `D7:<blankVariantId>`, `market:<recommendationId>`.
     */
    fingerprint: text().notNull(),
    templateKey: text().notNull(),
    /** Contract `DigestAction` (kind, params, in-app href). */
    action: jsonb().$type<Record<string, unknown>>().notNull(),
    /** Contract `DigestFact[]`. */
    facts: jsonb().$type<Record<string, unknown>[]>().notNull().default([]),
    /** Market watch items: the wave 18 recommendation (votes go to that record, AC17). */
    recommendationId: uuid(),
    ...timestamps,
  },
  (t) => [
    unique("digest_insights_company_id_id_unique").on(t.companyId, t.id),
    uniqueIndex().on(t.companyId, t.digestId, t.fingerprint),
    index().on(t.companyId, t.fingerprint),
    foreignKey({
      name: "digest_insights_digest_fk",
      columns: [t.companyId, t.digestId],
      foreignColumns: [digests.companyId, digests.id],
    }).onDelete("cascade"),
    tenantPolicy("digest_insights"),
  ],
).enableRLS();

/** Thumbs on a non-market insight. One row per (insight, person); the latest vote wins. */
export const digestFeedback = pgTable(
  "digest_feedback",
  {
    id: id(),
    companyId: companyId(),
    digestId: uuid().notNull(),
    insightId: uuid().notNull(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    vote: text(enumText(DIGEST_FEEDBACK_VOTES)).notNull(),
    reason: text(enumText(DIGEST_FEEDBACK_REASONS)),
    votedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex().on(t.companyId, t.insightId, t.userId),
    index().on(t.companyId, t.digestId),
    foreignKey({
      name: "digest_feedback_insight_fk",
      columns: [t.companyId, t.insightId],
      foreignColumns: [digestInsights.companyId, digestInsights.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "digest_feedback_digest_fk",
      columns: [t.companyId, t.digestId],
      foreignColumns: [digests.companyId, digests.id],
    }).onDelete("cascade"),
    tenantPolicy("digest_feedback"),
  ],
).enableRLS();

/** Action clicks (in-app or the email's signed click link). The first click wins. */
export const digestClicks = pgTable(
  "digest_clicks",
  {
    id: id(),
    companyId: companyId(),
    digestId: uuid().notNull(),
    insightId: uuid().notNull(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    clickedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex().on(t.companyId, t.insightId, t.userId),
    index().on(t.companyId, t.digestId),
    foreignKey({
      name: "digest_clicks_insight_fk",
      columns: [t.companyId, t.insightId],
      foreignColumns: [digestInsights.companyId, digestInsights.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "digest_clicks_digest_fk",
      columns: [t.companyId, t.digestId],
      foreignColumns: [digests.companyId, digests.id],
    }).onDelete("cascade"),
    tenantPolicy("digest_clicks"),
  ],
).enableRLS();

/** First in-app view per person (`viewedAt`; feeds the "nobody reads it" AI-cost rule). */
export const digestViews = pgTable(
  "digest_views",
  {
    id: id(),
    companyId: companyId(),
    digestId: uuid().notNull(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    viewedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex().on(t.companyId, t.digestId, t.userId),
    foreignKey({
      name: "digest_views_digest_fk",
      columns: [t.companyId, t.digestId],
      foreignColumns: [digests.companyId, digests.id],
    }).onDelete("cascade"),
    tenantPolicy("digest_views"),
  ],
).enableRLS();

/**
 * The digest-level outcome per recipient and channel (A7): recorded `pending` before the send,
 * then `sent` or `skipped` with the reason. Send idempotency itself lives in T-19-4's
 * `email_sends` (dedupe key `digest:${digestId}:${userId}`).
 */
export const digestDeliveries = pgTable(
  "digest_deliveries",
  {
    id: id(),
    companyId: companyId(),
    digestId: uuid().notNull(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    channel: text(enumText(DIGEST_DELIVERY_CHANNELS)).notNull().default("email"),
    status: text(enumText(DIGEST_DELIVERY_STATUSES)).notNull().default("pending"),
    /** Contract `EMAIL_SKIP_REASONS` value when skipped; a short error code when failed. */
    reason: text(),
    lang: text(enumText(["en", "es"] as const))
      .notNull()
      .default("en"),
    messageId: text(),
    sentAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex().on(t.companyId, t.digestId, t.userId, t.channel),
    foreignKey({
      name: "digest_deliveries_digest_fk",
      columns: [t.companyId, t.digestId],
      foreignColumns: [digests.companyId, digests.id],
    }).onDelete("cascade"),
    tenantPolicy("digest_deliveries"),
  ],
).enableRLS();

/*
 * Today's action panel (wave A2, T-A9; architect ruling 2 in `waves/A2/reviews/plan-architect.md`).
 * A daily set per shop, built by a job from the digest's snapshot, detectors and ranking over the
 * 7 days ending yesterday (shop time); the read is a plain SELECT. `today_action_sets` marks a
 * built day, so a healthy day with no actions still reads as built (`steady`). Children reference
 * their parent by `(company_id, ...)` (S-26). Retention: 90 days (modules/today/jobs.ts purge).
 * No buyer PII: params are channel, design, blank, supplier names and numbers.
 */

/** One built day per shop. `(company_id, date)` is the idempotency key of the build job. */
export const todayActionSets = pgTable(
  "today_action_sets",
  {
    id: id(),
    companyId: companyId(),
    /** The shop-local day the set is for; the window is `date - 7` .. `date - 1`. */
    date: date({ mode: "string" }).notNull(),
    windowStart: date({ mode: "string" }).notNull(),
    windowEnd: date({ mode: "string" }).notNull(),
    generatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("today_action_sets_company_id_id_unique").on(t.companyId, t.id),
    uniqueIndex().on(t.companyId, t.date),
    tenantPolicy("today_action_sets"),
  ],
).enableRLS();

/** A ranked action (at most 5 per set). `key` is the candidate's fingerprint, unique per day. */
export const todayActions = pgTable(
  "today_actions",
  {
    id: id(),
    companyId: companyId(),
    setId: uuid().notNull(),
    date: date({ mode: "string" }).notNull(),
    key: text().notNull(),
    rank: integer().notNull(),
    detector: text(enumText(DIGEST_DETECTOR_KEYS)).notNull(),
    kind: text().notNull(),
    /** Contract `DigestActionParams`. */
    params: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    href: text().notNull(),
    impactCents: integer(),
    generatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("today_actions_company_id_id_unique").on(t.companyId, t.id),
    uniqueIndex().on(t.companyId, t.date, t.key),
    index().on(t.companyId, t.setId),
    foreignKey({
      name: "today_actions_set_fk",
      columns: [t.companyId, t.setId],
      foreignColumns: [todayActionSets.companyId, todayActionSets.id],
    }).onDelete("cascade"),
    tenantPolicy("today_actions"),
  ],
).enableRLS();

/** First click per (action, person), like `digest_clicks`. */
export const todayActionClicks = pgTable(
  "today_action_clicks",
  {
    id: id(),
    companyId: companyId(),
    actionId: uuid().notNull(),
    date: date({ mode: "string" }).notNull(),
    key: text().notNull(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    clickedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex().on(t.companyId, t.actionId, t.userId),
    foreignKey({
      name: "today_action_clicks_action_fk",
      columns: [t.companyId, t.actionId],
      foreignColumns: [todayActions.companyId, todayActions.id],
    }).onDelete("cascade"),
    tenantPolicy("today_action_clicks"),
  ],
).enableRLS();
