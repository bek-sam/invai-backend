import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { enumText, id, jsonObject, publicReadPolicy, tenantPolicy, timestamps } from "./_shared";
import { CHANNELS } from "./channels";
import { companyId, users } from "./tenancy";

export const AI_JOB_KINDS = [
  "listing_draft",
  "trademark_check",
  "sku_suggestion",
  "personalization_check",
  "assistant",
  "ocr",
  "mockup",
] as const;
export const AI_JOB_STATUSES = ["queued", "running", "done", "failed"] as const;

/** Every gateway call: input, output, tokens and cost, for metering and traces. */
export const aiJobs = pgTable(
  "ai_jobs",
  {
    id: id(),
    companyId: companyId(),
    kind: text(enumText(AI_JOB_KINDS)).notNull(),
    status: text(enumText(AI_JOB_STATUSES)).notNull().default("queued"),
    model: text(),
    provider: text(enumText(["anthropic", "mock"] as const))
      .notNull()
      .default("mock"),
    input: jsonObject<Record<string, unknown>>(),
    output: jsonObject<Record<string, unknown>>(),
    tokensIn: integer().notNull().default(0),
    tokensOut: integer().notNull().default(0),
    cacheReadTokens: integer().notNull().default(0),
    costCents: integer().notNull().default(0),
    credits: integer().notNull().default(0),
    stopReason: text(),
    error: text(),
    entityType: text(),
    entityId: uuid(),
    createdBy: uuid(),
    startedAt: timestamp({ withTimezone: true }),
    finishedAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index().on(t.companyId, t.kind, t.createdAt),
    index().on(t.companyId, t.entityType, t.entityId),
    tenantPolicy("ai_jobs"),
  ],
).enableRLS();

export const LISTING_DRAFT_STATES = [
  "generating",
  "needs_review",
  "approved",
  "rejected",
  "publishing",
  "published",
  "failed",
] as const;

export type ListingContent = {
  title: string;
  description: string;
  tags: string[];
  bullets: string[];
  attributes: Record<string, string>;
  price: number | null;
  disclosures: string[];
  /** Filled in at generation time from the company's `productionPartner` setting; never model-generated. */
  productionPartner: string | null;
};

/** AI listing copy waiting for human approval. Nothing goes live without `approved`. */
export const listingDrafts = pgTable(
  "listing_drafts",
  {
    id: id(),
    companyId: companyId(),
    designId: uuid().notNull(),
    channel: text(enumText(CHANNELS)).notNull(),
    connectionId: uuid(),
    productId: uuid(),
    aiJobId: uuid().references(() => aiJobs.id, { onDelete: "set null" }),
    status: text(enumText(LISTING_DRAFT_STATES)).notNull().default("generating"),
    content: jsonObject<ListingContent>().default({
      title: "",
      description: "",
      tags: [],
      bullets: [],
      attributes: {},
      price: null,
      disclosures: [],
      productionPartner: null,
    }),
    /** Contracts ValidationResult / TrademarkCheck, null until computed. */
    validation: jsonb().$type<Record<string, unknown>>(),
    trademark: jsonb().$type<Record<string, unknown>>(),
    /** Compliance sign-off for a medium-risk draft (contracts TrademarkReview). All null until reviewed. */
    trademarkReviewedBy: uuid().references(() => users.id),
    trademarkReviewedAt: timestamp({ withTimezone: true }),
    trademarkReviewNote: text(),
    mockupKeys: text().array().notNull().default([]),
    model: text(),
    creditsUsed: integer().notNull().default(0),
    brief: text(),
    approvedBy: uuid(),
    approvedAt: timestamp({ withTimezone: true }),
    rejectedReason: text(),
    publishedListingId: text(),
    publishedUrl: text(),
    error: text(),
    ...timestamps,
  },
  (t) => [
    index().on(t.companyId, t.designId, t.channel),
    index().on(t.companyId, t.status, t.createdAt),
    tenantPolicy("listing_drafts"),
  ],
).enableRLS();

export const MARK_KINDS = ["word", "slogan", "character", "generic"] as const;
export const MARK_STATUSES = ["live", "dead"] as const;

/**
 * Global (not tenant) trademark index: live class-25 marks plus generic words that should not
 * raise risk. Seeded; later rebuilt from USPTO bulk data. Trigram index on `normalized`
 * (added in the custom SQL migration).
 */
export const trademarkMarks = pgTable(
  "trademark_marks",
  {
    id: id(),
    mark: text().notNull(),
    normalized: text().notNull(),
    owner: text(),
    kind: text(enumText(MARK_KINDS)).notNull().default("word"),
    status: text(enumText(MARK_STATUSES)).notNull().default("live"),
    classes: integer().array().notNull().default([25]),
    serialNo: text(),
    source: text().notNull().default("seed"),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex().on(t.normalized, t.kind), publicReadPolicy("trademark_marks")],
).enableRLS();

export const CREDIT_KINDS = [
  "allowance",
  "pack",
  "listing_draft",
  "sku_suggestion",
  "trademark_check",
  "personalization_check",
  "assistant",
  "mockup",
] as const;

/** Per-company AI credit ledger: allowance/packs in (+), every job out (−). */
export const aiCreditLedger = pgTable(
  "ai_credit_ledger",
  {
    id: id(),
    companyId: companyId(),
    kind: text(enumText(CREDIT_KINDS)).notNull(),
    credits: integer().notNull(),
    model: text(),
    tokensIn: integer(),
    tokensOut: integer(),
    cacheReadTokens: integer(),
    aiJobId: uuid().references(() => aiJobs.id, { onDelete: "set null" }),
    refType: text(),
    refId: uuid(),
    userId: uuid(),
    /** YYYY-MM the entry counts against. */
    period: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index().on(t.companyId, t.period),
    index().on(t.companyId, t.createdAt),
    tenantPolicy("ai_credit_ledger"),
  ],
).enableRLS();

export const assistantConversations = pgTable(
  "assistant_conversations",
  {
    id: id(),
    companyId: companyId(),
    userId: uuid().notNull(),
    title: text().notNull().default("New conversation"),
    ...timestamps,
  },
  (t) => [index().on(t.companyId, t.userId, t.updatedAt), tenantPolicy("assistant_conversations")],
).enableRLS();

export const assistantMessages = pgTable(
  "assistant_messages",
  {
    id: id(),
    companyId: companyId(),
    conversationId: uuid()
      .notNull()
      .references(() => assistantConversations.id, { onDelete: "cascade" }),
    role: text(enumText(["user", "assistant"] as const)).notNull(),
    text: text().notNull(),
    toolCalls: jsonObject<Record<string, unknown>>(),
    creditsUsed: integer().notNull().default(0),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index().on(t.companyId, t.conversationId, t.createdAt),
    tenantPolicy("assistant_messages"),
  ],
).enableRLS();
