import {
  boolean,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { encryptedText } from "../../lib/crypto";
import { enumText, id, jsonArray, tenantKey, tenantPolicy, timestamps } from "./_shared";
import { blankVariants, SUPPLIERS } from "./catalog";
import { companyId, locations } from "./tenancy";

export const MOVEMENT_KINDS = [
  "receive",
  "reserve",
  "release",
  "consume",
  "adjust",
  "return",
  "scrap",
  "count",
  "transfer",
] as const;
export type MovementKind = (typeof MOVEMENT_KINDS)[number];

export const ADJUST_REASONS = [
  "damaged",
  "lost",
  "found",
  "correction",
  "sample",
  "other",
] as const;
export const MOVEMENT_REF_TYPES = [
  "order_item",
  "purchase_order",
  "count",
  "reprint",
  "transfer",
] as const;

/**
 * Append-only stock ledger (a DB trigger rejects UPDATE/DELETE). `qty` is signed:
 * receive/return/found add, consume/scrap/lost remove. `reserve`/`release` move the reserved
 * count only. stock_levels is a cache derived from this table.
 */
export const inventoryMovements = pgTable(
  "inventory_movements",
  {
    id: id(),
    companyId: companyId(),
    blankVariantId: uuid().notNull(),
    locationId: uuid().notNull(),
    kind: text(enumText(MOVEMENT_KINDS)).notNull(),
    qty: integer().notNull(),
    unitCostCents: integer(),
    reason: text(enumText(ADJUST_REASONS)),
    refType: text(enumText(MOVEMENT_REF_TYPES)),
    refId: uuid(),
    note: text(),
    userId: uuid(),
    /** e.g. `consume:order_item:{id}` so a retried job cannot double-consume. */
    idempotencyKey: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex().on(t.companyId, t.idempotencyKey),
    index().on(t.companyId, t.blankVariantId, t.createdAt),
    index().on(t.companyId, t.refType, t.refId),
    index().on(t.companyId, t.createdAt),
    foreignKey({
      name: "inventory_movements_blank_variant_id_fk",
      columns: [t.companyId, t.blankVariantId],
      foreignColumns: [blankVariants.companyId, blankVariants.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "inventory_movements_location_id_fk",
      columns: [t.companyId, t.locationId],
      foreignColumns: [locations.companyId, locations.id],
    }).onDelete("restrict"),
    tenantPolicy("inventory_movements"),
  ],
).enableRLS();

/** Cached on-hand / reserved per blank variant per location. available = onHand - reserved. */
export const stockLevels = pgTable(
  "stock_levels",
  {
    id: id(),
    companyId: companyId(),
    blankVariantId: uuid().notNull(),
    locationId: uuid().notNull(),
    onHand: integer().notNull().default(0),
    reserved: integer().notNull().default(0),
    available: integer().notNull().default(0),
    /** Per-location override; falls back to blank_variants.reorder_point, then velocity. */
    reorderPoint: integer(),
    reorderQty: integer(),
    /** Shelf / bin label where this blank sits, e.g. "A-03-2" (shown on the pick queue). */
    shelf: text(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex().on(t.companyId, t.blankVariantId, t.locationId),
    index().on(t.companyId, t.available),
    foreignKey({
      name: "stock_levels_blank_variant_id_fk",
      columns: [t.companyId, t.blankVariantId],
      foreignColumns: [blankVariants.companyId, blankVariants.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "stock_levels_location_id_fk",
      columns: [t.companyId, t.locationId],
      foreignColumns: [locations.companyId, locations.id],
    }).onDelete("cascade"),
    tenantPolicy("stock_levels"),
  ],
).enableRLS();

/** Per-company supplier account (one row per supplier kind). API keys are encrypted. */
export const suppliers = pgTable(
  "suppliers",
  {
    id: id(),
    companyId: companyId(),
    supplier: text(enumText(SUPPLIERS)).notNull(),
    name: text().notNull(),
    accountNumber: text(),
    apiKey: encryptedText(),
    /** Order subtotal above which freight is free (reorder-to-the-line logic). */
    freeFreightThresholdCents: integer().notNull().default(20000),
    ...timestamps,
  },
  (t) => [uniqueIndex().on(t.companyId, t.supplier), tenantPolicy("suppliers")],
).enableRLS();

/** One row per company; created with defaults on first read. */
export const inventorySettings = pgTable(
  "inventory_settings",
  {
    id: id(),
    companyId: companyId(),
    velocityWindowDays: integer().notNull().default(30),
    leadTimeDays: integer().notNull().default(3),
    safetyDays: integer().notNull().default(2),
    reserveOnImport: boolean().notNull().default(true),
    ...timestamps,
  },
  (t) => [uniqueIndex().on(t.companyId), tenantPolicy("inventory_settings")],
).enableRLS();

/**
 * `submitting`: the supplier order was (or is being) sent and its outcome isn't recorded yet.
 * It is internal: the API shows it as `draft` until the contract's PO_STATES has it.
 */
export const PO_STATUSES = [
  "draft",
  "submitting",
  "submitted",
  "partially_received",
  "received",
  "cancelled",
] as const;

export const purchaseOrders = pgTable(
  "purchase_orders",
  {
    id: id(),
    companyId: companyId(),
    supplier: text(enumText(SUPPLIERS)).notNull(),
    locationId: uuid().notNull(),
    poNo: text().notNull(),
    status: text(enumText(PO_STATUSES)).notNull().default("draft"),
    subtotalCents: integer().notNull().default(0),
    freightCents: integer().notNull().default(0),
    totalCents: integer().notNull().default(0),
    supplierOrderId: text(),
    expectedAt: timestamp({ withTimezone: true }),
    /**
     * When the supplier call in flight started (status `submitting`). Null while submitting
     * means the last call ended with an unknown outcome, so a retry reads back first.
     */
    submitAttemptedAt: timestamp({ withTimezone: true }),
    submittedAt: timestamp({ withTimezone: true }),
    receivedAt: timestamp({ withTimezone: true }),
    notes: text(),
    createdBy: uuid(),
    ...timestamps,
  },
  (t) => [
    tenantKey("purchase_orders", t),
    uniqueIndex().on(t.companyId, t.poNo),
    index().on(t.companyId, t.status),
    foreignKey({
      name: "purchase_orders_location_id_fk",
      columns: [t.companyId, t.locationId],
      foreignColumns: [locations.companyId, locations.id],
    }).onDelete("restrict"),
    tenantPolicy("purchase_orders"),
  ],
).enableRLS();

export const purchaseOrderLines = pgTable(
  "purchase_order_lines",
  {
    id: id(),
    companyId: companyId(),
    purchaseOrderId: uuid().notNull(),
    blankVariantId: uuid().notNull(),
    qty: integer().notNull(),
    receivedQty: integer().notNull().default(0),
    unitCostCents: integer().notNull().default(0),
    ...timestamps,
  },
  (t) => [
    index().on(t.companyId, t.purchaseOrderId),
    foreignKey({
      name: "purchase_order_lines_purchase_order_id_fk",
      columns: [t.companyId, t.purchaseOrderId],
      foreignColumns: [purchaseOrders.companyId, purchaseOrders.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "purchase_order_lines_blank_variant_id_fk",
      columns: [t.companyId, t.blankVariantId],
      foreignColumns: [blankVariants.companyId, blankVariants.id],
    }).onDelete("restrict"),
    tenantPolicy("purchase_order_lines"),
  ],
).enableRLS();

/**
 * One row per receipt submitted with a client idempotency key, so a retried receipt counts once.
 * `lines` is the request as received; the same key with different lines is a conflict.
 */
export const purchaseOrderReceipts = pgTable(
  "purchase_order_receipts",
  {
    id: id(),
    companyId: companyId(),
    purchaseOrderId: uuid().notNull(),
    idempotencyKey: text().notNull(),
    locationId: uuid().notNull(),
    lines: jsonArray<{ lineId: string; qty: number }>(),
    createdBy: uuid(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex().on(t.companyId, t.idempotencyKey),
    index().on(t.companyId, t.purchaseOrderId),
    foreignKey({
      name: "purchase_order_receipts_purchase_order_id_fk",
      columns: [t.companyId, t.purchaseOrderId],
      foreignColumns: [purchaseOrders.companyId, purchaseOrders.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "purchase_order_receipts_location_id_fk",
      columns: [t.companyId, t.locationId],
      foreignColumns: [locations.companyId, locations.id],
    }).onDelete("restrict"),
    tenantPolicy("purchase_order_receipts"),
  ],
).enableRLS();
