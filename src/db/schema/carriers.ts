import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { enumText, id, tenantPolicy } from "./_shared";
import { companies } from "./tenancy";

export const CARRIER_WEBHOOK_PROVIDERS = ["easypost"] as const;
export const CARRIER_WEBHOOK_EVENT_STATUSES = [
  "received",
  "processed",
  "ignored",
  "failed",
] as const;

/** Kept longer than EasyPost's retry window (6 retries with increasing delay). */
export const CARRIER_WEBHOOK_EVENT_RETENTION_MS = 7 * 24 * 3600_000;

/**
 * One row per verified carrier webhook event, unique on the provider's event id (EasyPost
 * `evt_...`), so a redelivery is acknowledged and never processed twice. Same shape and rules
 * as `webhook_deliveries` (decision 0009): written only by the system role, `company_id` filled
 * in once the event is routed to a shipment, the app role reads its own company's rows only
 * (writes are revoked in the migration). Purged after CARRIER_WEBHOOK_EVENT_RETENTION_MS.
 */
export const carrierWebhookEvents = pgTable(
  "carrier_webhook_events",
  {
    id: id(),
    /** Null until the event is routed to a shipment. */
    companyId: uuid().references(() => companies.id, { onDelete: "cascade" }),
    provider: text(enumText(CARRIER_WEBHOOK_PROVIDERS)).notNull(),
    /** EasyPost Event `id`. */
    eventId: text().notNull(),
    status: text(enumText(CARRIER_WEBHOOK_EVENT_STATUSES)).notNull().default("received"),
    receivedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp({ withTimezone: true }),
    /** Why processing failed or was skipped (no PII: reasons and error messages only). */
    detail: text(),
    /** The tracker the event is about (EasyPost `trk_...`, else the tracking code). */
    subjectId: text(),
    /** The carrier's latest scan time in the event; an older event never moves a shipment back. */
    occurredAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    uniqueIndex().on(t.provider, t.eventId),
    index().on(t.receivedAt),
    index().on(t.companyId, t.receivedAt),
    index().on(t.provider, t.subjectId, t.occurredAt),
    tenantPolicy("carrier_webhook_events"),
  ],
).enableRLS();
