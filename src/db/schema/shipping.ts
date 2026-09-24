import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { enumText, id, jsonArray, tenantPolicy, timestamps } from "./_shared";
import { orders } from "./orders";
import { type Address, companyId } from "./tenancy";

/** `mock` is the sandbox carrier used when no EasyPost key is present. */
export const CARRIERS = ["usps", "ups", "mock"] as const;
export type Carrier = (typeof CARRIERS)[number];

export const SHIPMENT_STATES = [
  "pending",
  "rated",
  "labeled",
  "in_transit",
  "delivered",
  "exception",
  "returned",
  "voided",
] as const;
export type ShipmentState = (typeof SHIPMENT_STATES)[number];

export const TRACKING_PUSH_STATUSES = ["not_required", "pending", "pushed", "failed"] as const;
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
  (t) => [index().on(t.companyId), tenantPolicy("package_presets")],
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
    orderId: uuid()
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
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
    packagePresetId: uuid().references(() => packagePresets.id, { onDelete: "set null" }),
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
    trackingPushStatus: text(enumText(TRACKING_PUSH_STATUSES)).notNull().default("pending"),
    trackingPushedAt: timestamp({ withTimezone: true }),
    trackingPushAttempts: integer().notNull().default(0),
    trackingPushError: text(),
    labeledAt: timestamp({ withTimezone: true }),
    deliveredAt: timestamp({ withTimezone: true }),
    voidedAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index().on(t.companyId, t.orderId),
    index().on(t.companyId, t.status),
    uniqueIndex().on(t.companyId, t.trackingCode),
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
    shipmentId: uuid()
      .notNull()
      .references(() => shipments.id, { onDelete: "cascade" }),
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
    tenantPolicy("labels"),
  ],
).enableRLS();
