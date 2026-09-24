import { integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { enumText, id, publicReadPolicy, tenantPolicy, timestamps } from "./_shared";
import { companyId, PLAN_KEYS } from "./tenancy";

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

export const SUBSCRIPTION_STATUSES = ["trialing", "active", "past_due", "cancelled"] as const;

/** Stripe is stubbed in v1; the row still records the plan and period so limits apply. */
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
