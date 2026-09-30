import { sql } from "drizzle-orm";
import {
  boolean,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { enumText, id, jsonArray, tenantKey, tenantPolicy, timestamps } from "./_shared";
import { orders } from "./orders";
import { type Address, companyId } from "./tenancy";

/** `mock` is the sandbox carrier used when no EasyPost key is present. */
export const CARRIERS = ["usps", "ups", "mock"] as const;
export type Carrier = (typeof CARRIERS)[number];

/**
 * `buying` and `voiding` are internal intent states (crash-safe carrier calls, research 10 R8):
 * the carrier call was (or is being) made and its outcome isn't recorded yet. The API shows them
 * as `rated` and `labeled` until contracts SHIPMENT_STATES has them.
 */
export const SHIPMENT_STATES = [
  "pending",
  "rated",
  "labeled",
  "in_transit",
  "delivered",
  "exception",
  "returned",
  "voided",
  "buying",
  "voiding",
] as const;
export type ShipmentState = (typeof SHIPMENT_STATES)[number];

/** `pushing` is internal (shown as `pending`): the channel call was (or is being) made. */
export const TRACKING_PUSH_STATUSES = [
  "not_required",
  "pending",
  "pushed",
  "failed",
  "pushing",
] as const;
export const LABEL_FORMATS = ["pdf", "zpl"] as const;
export const BATCH_STRATEGIES = ["cheapest", "fastest", "cheapest_on_time"] as const;

export type RateQuote = {
  rateId: string;
  carrier: Carrier;
  service: string;
  serviceLabel: string;
  rate: number;
  deliveryDays: number | null;
  estimatedDeliveryAt: string | null;
};

export const packagePresets = pgTable(
  "package_presets",
  {
    id: id(),
    companyId: companyId(),
    name: text().notNull(),
    lengthIn: doublePrecision().notNull(),
    widthIn: doublePrecision().notNull(),
    heightIn: doublePrecision().notNull(),
    tareOz: doublePrecision().notNull().default(0),
    /** Use for orders with this many units or fewer. */
    maxUnits: integer(),
    isDefault: boolean().notNull().default(false),
    ...timestamps,
  },
  (t) => [
    tenantKey("package_presets", t),
    index().on(t.companyId),
    tenantPolicy("package_presets"),
  ],
).enableRLS();

/** One row per company; created with defaults on first read (contracts `ShippingSettings`). */
export const shippingSettings = pgTable(
  "shipping_settings",
  {
    id: id(),
    companyId: companyId(),
    fromAddress: jsonb().$type<Address>(),
    weightPerStyle: jsonArray<{ styleCode: string; weightOz: number }>(),
    defaultStrategy: text(enumText(BATCH_STRATEGIES)).notNull().default("cheapest_on_time"),
    allowedCarriers: text().array().notNull().default(["usps", "ups", "mock"]),
    labelFormat: text(enumText(LABEL_FORMATS)).notNull().default("pdf"),
    trackingPushEnabled: boolean().notNull().default(true),
    ...timestamps,
  },
  (t) => [uniqueIndex().on(t.companyId), tenantPolicy("shipping_settings")],
).enableRLS();

/** One package for one order. Rate shop → buy label → push tracking → track to delivery. */
export const shipments = pgTable(
  "shipments",
  {
    id: id(),
    companyId: companyId(),
    orderId: uuid().notNull(),
    orderItemIds: uuid().array().notNull().default([]),
    status: text(enumText(SHIPMENT_STATES)).notNull().default("pending"),
    carrier: text(enumText(CARRIERS)),
    service: text(),
    trackingCode: text(),
    trackingUrl: text(),
    trackingStatus: text(),
    labelKey: text(),
    labelFormat: text(enumText(LABEL_FORMATS)),
    postageCents: integer().notNull().default(0),
    /** Platform per-label fee (billing). */
    labelFeeCents: integer().notNull().default(0),
    packagePresetId: uuid(),
    lengthIn: doublePrecision().notNull().default(10),
    widthIn: doublePrecision().notNull().default(8),
    heightIn: doublePrecision().notNull().default(1),
    weightOz: doublePrecision().notNull().default(6),
    rateQuotes: jsonArray<RateQuote>(),
    selectedRateId: text(),
    ratedAt: timestamp({ withTimezone: true }),
    /** EasyPost shipment id (or mock id). */
    carrierShipmentId: text(),
    carrierLabelId: text(),
    /**
     * When the carrier buy in flight started (status `buying`). Null while buying means the last
     * call ended with an unknown outcome, so a retry reads the carrier back before buying.
     */
    buyAttemptedAt: timestamp({ withTimezone: true }),
    /** Same for the refund in flight (status `voiding`). */
    voidAttemptedAt: timestamp({ withTimezone: true }),
    trackingPushStatus: text(enumText(TRACKING_PUSH_STATUSES)).notNull().default("pending"),
    /** Same for the channel push in flight (tracking push status `pushing`). */
    pushAttemptedAt: timestamp({ withTimezone: true }),
    trackingPushedAt: timestamp({ withTimezone: true }),
    trackingPushAttempts: integer().notNull().default(0),
    trackingPushError: text(),
    labeledAt: timestamp({ withTimezone: true }),
    deliveredAt: timestamp({ withTimezone: true }),
    voidedAt: timestamp({ withTimezone: true }),
    /**
     * T-7-1: last time this shipment's tracking was included in a CSV tracking export
     * (`shipping.exportTracking`). Separate from `trackingPushedAt` -- `manual` push status is
     * already conflated with "pushed" in void logic (B-67, shipping/service.ts:1040); this is a
     * distinct, re-settable timestamp that a re-export simply overwrites.
     */
    exportedAt: timestamp({ withTimezone: true }),
    /**
     * T-A4: carrier zone 1-9 from origin and destination ZIP3, set once at label purchase
     * (`shipping/zone.ts`). The ZIPs are read in memory only; no ZIP or address is stored here.
     */
    destZone: smallint(),
    ...timestamps,
  },
  (t) => [
    tenantKey("shipments", t),
    index().on(t.companyId, t.orderId),
    index().on(t.companyId, t.status),
    uniqueIndex().on(t.companyId, t.trackingCode),
    foreignKey({
      name: "shipments_order_id_fk",
      columns: [t.companyId, t.orderId],
      foreignColumns: [orders.companyId, orders.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "shipments_package_preset_id_fk",
      columns: [t.companyId, t.packagePresetId],
      foreignColumns: [packagePresets.companyId, packagePresets.id],
    }).onDelete("set null"),
    tenantPolicy("shipments"),
  ],
).enableRLS();

export const LABEL_STATUSES = ["purchased", "voided", "refund_pending", "refunded"] as const;

/** Every label ever bought, including voided ones; the shipment points at the live one. */
export const labels = pgTable(
  "labels",
  {
    id: id(),
    companyId: companyId(),
    shipmentId: uuid().notNull(),
    carrier: text(enumText(CARRIERS)).notNull(),
    service: text().notNull(),
    trackingCode: text().notNull(),
    labelKey: text().notNull(),
    format: text(enumText(LABEL_FORMATS)).notNull().default("pdf"),
    postageCents: integer().notNull(),
    labelFeeCents: integer().notNull().default(0),
    carrierLabelId: text(),
    status: text(enumText(LABEL_STATUSES)).notNull().default("purchased"),
    purchasedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    voidedAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index().on(t.companyId, t.shipmentId),
    index().on(t.companyId, t.trackingCode),
    // One live label per shipment: a retried or raced buy can't record a second one.
    uniqueIndex("labels_one_purchased_per_shipment")
      .on(t.companyId, t.shipmentId)
      .where(sql`status = 'purchased'`),
    foreignKey({
      name: "labels_shipment_id_fk",
      columns: [t.companyId, t.shipmentId],
      foreignColumns: [shipments.companyId, shipments.id],
    }).onDelete("cascade"),
    tenantPolicy("labels"),
  ],
).enableRLS();

/** `creating`: claimed and the carrier call made (or in flight); `created`: the carrier accepted it. */
export const SCAN_FORM_STATUSES = ["creating", "created"] as const;

/**
 * USPS end-of-day SCAN forms (B-25, T-22-3). One per company + carrier + shop-local date
 * (`create` is idempotent on it). `shipment_ids` lists the labels on the form; a shipment on any
 * form is never put on another. The PDF has the shop's from-address and tracking numbers, no
 * buyer data; it lives under the `label` key kind (shipping roles only). Kept like labels.
 */
export const scanForms = pgTable(
  "scan_forms",
  {
    id: id(),
    companyId: companyId(),
    carrier: text(enumText(CARRIERS)).notNull(),
    /** Pickup day, YYYY-MM-DD in the shop's timezone. */
    date: text().notNull(),
    status: text(enumText(SCAN_FORM_STATUSES)).notNull().default("creating"),
    shipmentIds: uuid().array().notNull().default([]),
    labelCount: integer().notNull().default(0),
    /** EasyPost `sf_...`; null for the mock carrier. */
    carrierFormId: text(),
    /** S3 key of the form PDF; null until the carrier has rendered it. */
    fileKey: text(),
    /** When the carrier call in flight started; null while `creating` = outcome unknown (read back). */
    attemptedAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex().on(t.companyId, t.carrier, t.date),
    index().on(t.companyId, t.createdAt),
    tenantPolicy("scan_forms"),
  ],
).enableRLS();

export const ADDRESS_CHECK_STATUSES = ["verified", "corrected", "failed"] as const;

/**
 * Last carrier address check per order (B-25, T-22-3). No address is stored: `address_hash` is
 * a keyed HMAC of the ship-to, so a repeat reuses the result only while the address is unchanged,
 * and the corrected address is fetched again rather than kept. `detail` is the carrier's reason
 * ("Address not found"), never the address. Deleted with the order.
 */
export const addressVerifications = pgTable(
  "address_verifications",
  {
    id: id(),
    companyId: companyId(),
    orderId: uuid().notNull(),
    addressHash: text().notNull(),
    status: text(enumText(ADDRESS_CHECK_STATUSES)).notNull(),
    detail: text(),
    verifiedAt: timestamp({ withTimezone: true }).notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex().on(t.companyId, t.orderId),
    foreignKey({
      name: "address_verifications_order_id_fk",
      columns: [t.companyId, t.orderId],
      foreignColumns: [orders.companyId, orders.id],
    }).onDelete("cascade"),
    tenantPolicy("address_verifications"),
  ],
).enableRLS();
