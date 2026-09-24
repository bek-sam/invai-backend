import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { enumText, id, tenantPolicy } from "./_shared";
import { CHANNELS } from "./channels";
import { companies } from "./tenancy";

export const WEBHOOK_DELIVERY_STATUSES = ["received", "processed", "ignored", "failed"] as const;

/** Kept longer than any channel's retry window (Etsy about 30 h, Shopify 4 h). */
export const WEBHOOK_DELIVERY_RETENTION_MS = 7 * 24 * 3600_000;

/**
 * One row per verified marketplace webhook delivery, unique on the channel's delivery id, so a
 * redelivery is acknowledged and never processed twice. Written only by the system role: the
 * row is inserted before the delivery is routed to a shop, and `company_id` is filled in once it
 * is. The app role can read its own company's rows and nothing else (writes are revoked in the
 * migration). Purged after WEBHOOK_DELIVERY_RETENTION_MS.
 */
export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: id(),
    /** Null until the delivery is routed to a connected shop. */
    companyId: uuid().references(() => companies.id, { onDelete: "cascade" }),
    channel: text(enumText(CHANNELS)).notNull(),
    /** Shopify `X-Shopify-Webhook-Id`, Etsy `webhook-id`. */
    deliveryId: text().notNull(),
    status: text(enumText(WEBHOOK_DELIVERY_STATUSES)).notNull().default("received"),
    receivedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp({ withTimezone: true }),
    /** Why processing failed or was skipped (no PII: reasons and error messages only). */
    detail: text(),
  },
  (t) => [
    uniqueIndex().on(t.channel, t.deliveryId),
    index().on(t.receivedAt),
    index().on(t.companyId, t.receivedAt),
    tenantPolicy("webhook_deliveries"),
  ],
).enableRLS();
