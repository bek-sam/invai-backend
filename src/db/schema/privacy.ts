import {
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { enumText, id, jsonObject, tenantPolicy } from "./_shared";
import { CHANNELS, channelConnections } from "./channels";
import { companyId } from "./tenancy";

/** Shopify compliance topics (https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance). */
export const PRIVACY_TOPICS = [
  "customers/data_request",
  "customers/redact",
  "shop/redact",
] as const;
export const PRIVACY_REQUEST_STATUSES = ["open", "completed"] as const;

/** The strictest clock: Shopify wants every compliance request completed within 30 days. */
export const PRIVACY_REQUEST_DUE_MS = 30 * 86400_000;

export type PrivacyCounts = {
  orders: number;
  buyerPii: number;
  rawPayloads: number;
  personalizedItems: number;
};

/**
 * One privacy request received from a channel for one company (a shop can have been connected to
 * more than one). Redactions are carried out while the webhook is handled and recorded
 * `completed` with their counts; a data request stays `open` until the owner has sent the data to
 * the shop. Holds no buyer PII: the channel's customer id and order ids are the only references.
 * Written only by the system role (writes revoked from the app role in the migration, the
 * `webhook_deliveries` pattern of decision 0009); the app role reads its own company's rows.
 */
export const privacyRequests = pgTable(
  "privacy_requests",
  {
    id: id(),
    companyId: companyId(),
    connectionId: uuid(),
    channel: text(enumText(CHANNELS)).notNull(),
    topic: text(enumText(PRIVACY_TOPICS)).notNull(),
    /** The webhook delivery id (`X-Shopify-Webhook-Id`): one request per delivery and company. */
    deliveryId: text().notNull(),
    externalShopId: text().notNull(),
    /** Shopify's customer id (`customer.id`); null for `shop/redact`. */
    channelCustomerId: text(),
    /** Shopify's `data_request.id`, for the reply to the store owner. */
    channelRequestId: text(),
    /** `orders_requested` / `orders_to_redact`: channel order ids, not PII. */
    channelOrderIds: text().array().notNull().default([]),
    status: text(enumText(PRIVACY_REQUEST_STATUSES)).notNull().default("open"),
    receivedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    dueAt: timestamp({ withTimezone: true }).notNull(),
    completedAt: timestamp({ withTimezone: true }),
    counts: jsonObject<PrivacyCounts>(),
  },
  (t) => [
    uniqueIndex().on(t.companyId, t.channel, t.deliveryId),
    index().on(t.companyId, t.status, t.dueAt),
    index().on(t.status, t.dueAt),
    foreignKey({
      name: "privacy_requests_connection_id_fk",
      columns: [t.companyId, t.connectionId],
      foreignColumns: [channelConnections.companyId, channelConnections.id],
    }).onDelete("set null"),
    tenantPolicy("privacy_requests"),
  ],
).enableRLS();
