import {
  boolean,
  date,
  doublePrecision,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { enumText, id, jsonArray, tenantPolicy, timestamps } from "./_shared";
import { CHANNELS } from "./channels";
import { orderItems, orders } from "./orders";
import { companyId } from "./tenancy";

/** Contracts `ChannelFeeTable`: percentages are plain percent (6.5 = 6.5%). */
export type ChannelFeeTable = {
  channel: string;
  transactionPct: number;
  perOrderCents: number;
  paymentPct: number;
  paymentFixedCents: number;
  listingFeeCents: number;
};

/** One row per company: the cost assumptions behind profit lines (contracts `CostSettings`). */
export const costSettings = pgTable(
  "cost_settings",
  {
    id: id(),
    companyId: companyId(),
    /** Seeded from contracts CHANNEL_RULES fee defaults; edited by the shop. */
    feeTables: jsonArray<ChannelFeeTable>(),
    transferCentsPerSqIn: integer().notNull().default(3),
    packagingPerOrderCents: integer().notNull().default(45),
    laborRatePerHourCents: integer().notNull().default(1800),
    laborMinutesPerItem: doublePrecision().notNull().default(4),
    adsAllocation: text(enumText(["revenue_share", "per_order"] as const))
      .notNull()
      .default("revenue_share"),
    /** Fixed monthly costs (rent, software, salaries) for break-even; null = not set. */
    fixedMonthlyCents: integer(),
    ...timestamps,
  },
  (t) => [uniqueIndex().on(t.companyId), tenantPolicy("cost_settings")],
).enableRLS();

export const adSpend = pgTable(
  "ad_spend",
  {
    id: id(),
    companyId: companyId(),
    day: date().notNull(),
    channel: text(enumText(CHANNELS)).notNull(),
    amountCents: integer().notNull(),
    campaign: text(),
    note: text(),
    ...timestamps,
  },
  (t) => [index().on(t.companyId, t.channel, t.day), tenantPolicy("ad_spend")],
).enableRLS();

/**
 * T-7-2: dated refund ledger (contracts `RefundEvent`). A refund is attributed to its own
 * date, not the order's `placedAt` (`profit_lines.refundsCents` can't do that -- see the wave
 * 7 stub note). Shopify/CSV ingestion upserts by (companyId, channel, channelRefundId); manual
 * entries (source "manual") have no channelRefundId, so the unique index (nulls excluded) never
 * blocks them.
 */
export const refundEvents = pgTable(
  "refund_events",
  {
    id: id(),
    companyId: companyId(),
    orderId: uuid().notNull(),
    /** null = order-level (e.g. a shipping refund), not tied to one item. */
    orderItemId: uuid(),
    channel: text(enumText(CHANNELS)).notNull(),
    source: text(enumText(["shopify", "csv", "manual"] as const)).notNull(),
    amountCents: integer().notNull(),
    feeRecoveredCents: integer().notNull().default(0),
    /** Shopify refund id / CSV row ref; null for manual entries. */
    channelRefundId: text(),
    refundedAt: timestamp({ withTimezone: true }).notNull(),
    note: text(),
    /** A manual refund voided as a mistake (finance.refunds.void): excluded from profit. */
    voidedAt: timestamp({ withTimezone: true }),
    voidReason: text(),
    voidedBy: uuid(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex().on(t.companyId, t.channel, t.channelRefundId),
    index().on(t.companyId, t.orderId),
    index().on(t.companyId, t.refundedAt),
    foreignKey({
      name: "refund_events_order_id_fk",
      columns: [t.companyId, t.orderId],
      foreignColumns: [orders.companyId, orders.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "refund_events_order_item_id_fk",
      columns: [t.companyId, t.orderItemId],
      foreignColumns: [orderItems.companyId, orderItems.id],
    }).onDelete("cascade"),
    tenantPolicy("refund_events"),
  ],
).enableRLS();

export const ESTIMATED_BUCKETS = [
  "channelFees",
  "blankCost",
  "transferCost",
  "labelCost",
  "adsCost",
] as const;

/** True profit per order item (contracts `CostBuckets`), recomputed by the profit job. All cents. */
export const profitLines = pgTable(
  "profit_lines",
  {
    id: id(),
    companyId: companyId(),
    orderId: uuid().notNull(),
    orderItemId: uuid().notNull(),
    channel: text(enumText(CHANNELS)).notNull(),
    designId: uuid(),
    blankVariantId: uuid(),
    styleCode: text(),
    revenueCents: integer().notNull().default(0),
    channelFeesCents: integer().notNull().default(0),
    blankCostCents: integer().notNull().default(0),
    transferCostCents: integer().notNull().default(0),
    labelCostCents: integer().notNull().default(0),
    packagingCostCents: integer().notNull().default(0),
    laborCostCents: integer().notNull().default(0),
    adsCostCents: integer().notNull().default(0),
    refundsCents: integer().notNull().default(0),
    netCents: integer().notNull().default(0),
    /** net / revenue; null when revenue is 0. */
    marginPct: doublePrecision(),
    printAreaSqIn: doublePrecision().notNull().default(0),
    laborMinutes: doublePrecision().notNull().default(0),
    isReprint: boolean().notNull().default(false),
    /** Which buckets are estimates (settings) versus actuals. */
    estimated: text().array().notNull().default([]),
    placedAt: timestamp({ withTimezone: true }).notNull(),
    computedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex().on(t.companyId, t.orderItemId),
    index().on(t.companyId, t.orderId),
    index().on(t.companyId, t.designId),
    index().on(t.companyId, t.channel, t.placedAt),
    index().on(t.companyId, t.styleCode),
    foreignKey({
      name: "profit_lines_order_id_fk",
      columns: [t.companyId, t.orderId],
      foreignColumns: [orders.companyId, orders.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "profit_lines_order_item_id_fk",
      columns: [t.companyId, t.orderItemId],
      foreignColumns: [orderItems.companyId, orderItems.id],
    }).onDelete("cascade"),
    tenantPolicy("profit_lines"),
  ],
).enableRLS();
