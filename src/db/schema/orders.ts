import {
  boolean,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { encryptedText } from "../../lib/crypto";
import { enumText, id, jsonArray, jsonObject, tenantPolicy, timestamps } from "./_shared";
import { CHANNELS, channelConnections } from "./channels";
import { companyId } from "./tenancy";

/** Production state of one order item. The transition table lives in modules/orders/state-machine.ts. */
export const ORDER_ITEM_STATES = [
  "imported",
  "needs_mapping",
  "ready",
  "needs_artwork",
  "on_sheet",
  "transfer_in",
  "pressed",
  "packed",
  "shipped",
  "delivered",
  "on_hold",
  "cancelled",
] as const;
export type OrderItemState = (typeof ORDER_ITEM_STATES)[number];

/** Order-level rollup derived from its items (contracts `deriveOrderStatus`), cached here. */
export const ORDER_STATUSES = [
  "new",
  "needs_attention",
  "in_production",
  "ready_to_ship",
  "partially_shipped",
  "shipped",
  "delivered",
  "on_hold",
  "cancelled",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const HOLD_REASONS = [
  "address_check",
  "buyer_request",
  "artwork_review",
  "out_of_stock",
  "payment",
  "fraud_check",
  "other",
] as const;

export const CANCEL_REASONS = [
  "buyer_request",
  "out_of_stock",
  "fraud",
  "undeliverable_address",
  "duplicate",
  "channel_cancelled",
  "other",
] as const;

export const orders = pgTable(
  "orders",
  {
    id: id(),
    companyId: companyId(),
    connectionId: uuid()
      .notNull()
      .references(() => channelConnections.id, { onDelete: "restrict" }),
    channel: text(enumText(CHANNELS)).notNull(),
    channelOrderId: text().notNull(),
    /** Display number as the buyer sees it (Etsy receipt id, Shopify #1001). */
    orderNo: text().notNull(),
    status: text(enumText(ORDER_STATUSES)).notNull().default("new"),
    placedAt: timestamp({ withTimezone: true }).notNull(),
    shipBy: timestamp({ withTimezone: true }).notNull(),
    isRush: boolean().notNull().default(false),
    hasPersonalization: boolean().notNull().default(false),
    shippingMethod: text(),
    buyerNote: text(),
    /** Non-identifying buyer reference (channel buyer id or a hash), safe for analytics. */
    buyerRef: text(),
    subtotalCents: integer().notNull().default(0),
    shippingCents: integer().notNull().default(0),
    taxCents: integer().notNull().default(0),
    discountCents: integer().notNull().default(0),
    totalCents: integer().notNull().default(0),
    currency: text().notNull().default("USD"),
    itemCount: integer().notNull().default(0),
    tags: text().array().notNull().default([]),
    holdReason: text(enumText(HOLD_REASONS)),
    holdNote: text(),
    heldAt: timestamp({ withTimezone: true }),
    cancelReason: text(enumText(CANCEL_REASONS)),
    cancelNote: text(),
    cancelledAt: timestamp({ withTimezone: true }),
    binId: uuid(),
    /** S3 key of the raw channel payload (encrypted archive, 30-day lifecycle). */
    rawPayloadKey: text(),
    importRunId: uuid(),
    shippedAt: timestamp({ withTimezone: true }),
    deliveredAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex().on(t.companyId, t.channel, t.channelOrderId),
    index().on(t.companyId, t.status, t.shipBy),
    index().on(t.companyId, t.placedAt),
    index().on(t.companyId, t.orderNo),
    index().on(t.companyId, t.connectionId),
    tenantPolicy("orders"),
  ],
).enableRLS();

export type PersonalizationAnswer = {
  question: string;
  answer: string | null;
  fileUrl: string | null;
};
export type ItemFlag = {
  code: string;
  severity: "info" | "warn" | "error";
  message: string;
  active: boolean;
  createdAt: string;
};

export const ITEM_ARTWORK_STATUSES = [
  "none",
  "pending",
  "rendered",
  "flagged",
  "approved",
  "failed",
] as const;

/**
 * One physical unit. A channel line with quantity 3 becomes three items (unitNo 1..3), so
 * every shirt has one state and one transfer. `shipBy` is denormalized from the order.
 */
export const orderItems = pgTable(
  "order_items",
  {
    id: id(),
    companyId: companyId(),
    orderId: uuid()
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    lineNo: integer().notNull().default(1),
    unitNo: integer().notNull().default(1),
    unitsInLine: integer().notNull().default(1),
    channelLineId: text().notNull().default(""),
    channelSku: text().notNull().default(""),
    channelListingId: text(),
    title: text().notNull().default(""),
    variantTitle: text(),
    unitPriceCents: integer().notNull().default(0),
    personalization: jsonArray<PersonalizationAnswer>(),
    state: text(enumText(ORDER_ITEM_STATES)).notNull().default("imported"),
    /** State to restore on release; set while on_hold. */
    heldFromState: text(enumText(ORDER_ITEM_STATES)),
    stateChangedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    shipBy: timestamp({ withTimezone: true }).notNull(),
    isRush: boolean().notNull().default(false),
    designId: uuid(),
    productId: uuid(),
    blankVariantId: uuid(),
    placement: text(),
    printWidthIn: doublePrecision(),
    printHeightIn: doublePrecision(),
    artworkStatus: text(enumText(ITEM_ARTWORK_STATUSES)).notNull().default("none"),
    /** Rendered artwork S3 key (personalized items) or null to use the design file. */
    artworkKey: text(),
    artworkPreviewKey: text(),
    flags: jsonArray<ItemFlag>(),
    isReprint: boolean().notNull().default(false),
    reprintOfItemId: uuid(),
    /** Denormalized pointers kept in sync by production/shipping services (no FKs: cycles). */
    transferId: uuid(),
    gangSheetId: uuid(),
    binId: uuid(),
    shipmentId: uuid(),
    ...timestamps,
  },
  (t) => [
    index().on(t.companyId, t.state, t.shipBy),
    index().on(t.companyId, t.orderId),
    index().on(t.companyId, t.designId),
    index().on(t.companyId, t.blankVariantId),
    index().on(t.companyId, t.channelSku),
    index().on(t.companyId, t.transferId),
    index().on(t.companyId, t.shipmentId),
    tenantPolicy("order_items"),
  ],
).enableRLS();

export const orderItemTransitions = pgTable(
  "order_item_transitions",
  {
    id: id(),
    companyId: companyId(),
    orderItemId: uuid()
      .notNull()
      .references(() => orderItems.id, { onDelete: "cascade" }),
    orderId: uuid().notNull(),
    fromState: text(enumText(ORDER_ITEM_STATES)),
    toState: text(enumText(ORDER_ITEM_STATES)).notNull(),
    actorKind: text(enumText(["user", "station", "system"] as const)).notNull(),
    actorUserId: uuid(),
    stationId: uuid(),
    reason: text(),
    data: jsonObject<Record<string, unknown>>(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index().on(t.companyId, t.orderItemId, t.createdAt),
    index().on(t.companyId, t.orderId, t.createdAt),
    index().on(t.companyId, t.createdAt),
    tenantPolicy("order_item_transitions"),
  ],
).enableRLS();

/**
 * Buyer personal data, one row per order, identifying fields encrypted per field.
 * Purged (row deleted) 30 days after delivery by a nightly job; the order keeps everything else.
 */
export const buyerPii = pgTable(
  "buyer_pii",
  {
    id: id(),
    companyId: companyId(),
    orderId: uuid()
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    name: encryptedText().notNull(),
    email: encryptedText(),
    phone: encryptedText(),
    company: encryptedText(),
    street1: encryptedText(),
    street2: encryptedText(),
    city: text(),
    state: text(),
    zip: text(),
    country: text().notNull().default("US"),
    /** Set when the order is delivered; the purge job deletes rows past this time. */
    purgeAfter: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex().on(t.companyId, t.orderId),
    index().on(t.purgeAfter),
    tenantPolicy("buyer_pii"),
  ],
).enableRLS();
