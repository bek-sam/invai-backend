import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { enumText, id, publicReadPolicy, tenantPolicy, timestamps } from "./_shared";
import { companies, companyId, PLAN_KEYS } from "./tenancy";

/** Global plan catalog (contracts `Plan`). `key` is stored on companies.plan. */
export const plans = pgTable(
  "plans",
  {
    key: text(enumText(PLAN_KEYS)).primaryKey(),
    name: text().notNull(),
    priceMonthlyCents: integer().notNull().default(0),
    /** Null = custom / unlimited. */
    ordersPerMonth: integer(),
    aiCreditsPerMonth: integer().notNull().default(0),
    /** Per label on top of postage. */
    labelFeeCents: integer().notNull().default(0),
    maxUsers: integer(),
    maxConnections: integer(),
    ...timestamps,
  },
  () => [publicReadPolicy("plans")],
).enableRLS();

/** `trial_expired`: past `trialEndsAt` with no paid subscription; blocks imports and label buys. */
export const SUBSCRIPTION_STATUSES = [
  "trialing",
  "active",
  "past_due",
  "cancelled",
  "trial_expired",
] as const;

/**
 * One row per company. With live Stripe the plan and status change only through the
 * `/webhooks/stripe` handler; with mock Stripe `changePlan` writes them directly.
 */
export const subscriptions = pgTable(
  "subscriptions",
  {
    id: id(),
    companyId: companyId(),
    planKey: text()
      .notNull()
      .references(() => plans.key),
    status: text(enumText(SUBSCRIPTION_STATUSES)).notNull().default("trialing"),
    overLimitBehavior: text(enumText(["warn", "block_imports"] as const))
      .notNull()
      .default("warn"),
    stripeCustomerId: text(),
    stripeSubscriptionId: text(),
    trialEndsAt: timestamp({ withTimezone: true }),
    currentPeriodStart: timestamp({ withTimezone: true }).notNull().defaultNow(),
    currentPeriodEnd: timestamp({ withTimezone: true }),
    cancelAtPeriodEnd: boolean().notNull().default(false),
    /**
     * `created` of the last Stripe event applied to this row. An event older than this is
     * ignored, so out-of-order deliveries can't roll the plan or status back.
     */
    stripeEventAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex().on(t.companyId), tenantPolicy("subscriptions")],
).enableRLS();

/** Monthly usage meters per company (period = YYYY-MM). */
export const usage = pgTable(
  "usage",
  {
    id: id(),
    companyId: companyId(),
    period: text().notNull(),
    ordersImported: integer().notNull().default(0),
    labelsBought: integer().notNull().default(0),
    labelFeesCents: integer().notNull().default(0),
    sheetsBuilt: integer().notNull().default(0),
    aiCredits: integer().notNull().default(0),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex().on(t.companyId, t.period), tenantPolicy("usage")],
).enableRLS();

export const BILLING_WEBHOOK_EVENT_STATUSES = ["received", "processed", "ignored"] as const;

/**
 * Kept longer than Stripe's automatic retries (3 days) and its manual resend window, so a
 * replayed event (and the credit pack it paid for) is never applied twice. Events older than
 * this are refused by the handler for the same reason.
 */
export const BILLING_WEBHOOK_EVENT_RETENTION_MS = 30 * 24 * 3600_000;

/**
 * One row per verified Stripe webhook event, unique on the Stripe event id (decision 0009's
 * shape: tenant policy for reads, system-only writes, purged nightly). The row is inserted in
 * the same transaction that applies the event, so an event is applied exactly once or not at
 * all. `company_id` is null when the event names no InvAI company.
 */
export const billingWebhookEvents = pgTable(
  "billing_webhook_events",
  {
    id: id(),
    companyId: uuid().references(() => companies.id, { onDelete: "cascade" }),
    /** Stripe `evt_...`. */
    stripeEventId: text().notNull(),
    type: text().notNull(),
    /** Stripe's `created` for the event. */
    stripeCreatedAt: timestamp({ withTimezone: true }).notNull(),
    status: text(enumText(BILLING_WEBHOOK_EVENT_STATUSES)).notNull().default("received"),
    receivedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp({ withTimezone: true }),
    /** Why it was ignored (no PII: reasons only). */
    detail: text(),
  },
  (t) => [
    uniqueIndex().on(t.stripeEventId),
    index().on(t.receivedAt),
    index().on(t.companyId, t.receivedAt),
    tenantPolicy("billing_webhook_events"),
  ],
).enableRLS();
