import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, enumText, id, tenantPolicy, timestamps } from "./_shared";
import { companyId, users } from "./tenancy";

/*
 * Email infrastructure (wave 19, T-19-4, ADR 0016): who wants which kind of mail, who must never
 * get any, and one durable row per attempted send. All three are tenant tables: a preference or a
 * suppression belongs to a person *in a company* (the same person can be a member of several
 * shops), and `sendUserEmail` (src/lib/notify.ts) is the only writer.
 */

/** Mirrors `NOTIFICATION_KINDS` in @invai/contracts (values appended at the end). */
export const NOTIFICATION_KINDS = ["digest"] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** Mirrors `NOTIFICATION_PREFERENCE_SOURCES` in @invai/contracts. */
export const NOTIFICATION_PREFERENCE_SOURCES = ["settings", "unsubscribe_link", "admin"] as const;
export type NotificationPreferenceSource = (typeof NOTIFICATION_PREFERENCE_SOURCES)[number];

/**
 * Per-person, per-kind email opt-in. No row means off. Only the person turns a kind on
 * (`source: settings`); an admin or a one-click unsubscribe link can only turn it off (the guard is
 * in `setEmailPreference`, not the table).
 */
export const notificationPreferences = pgTable(
  "notification_preferences",
  {
    id: id(),
    companyId: companyId(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text(enumText(NOTIFICATION_KINDS)).notNull(),
    on: boolean().notNull().default(false),
    source: text(enumText(NOTIFICATION_PREFERENCE_SOURCES)).notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex().on(t.companyId, t.userId, t.kind),
    tenantPolicy("notification_preferences"),
  ],
).enableRLS();

export const EMAIL_SUPPRESSION_REASONS = ["bounce", "complaint", "manual"] as const;
export type EmailSuppressionReason = (typeof EMAIL_SUPPRESSION_REASONS)[number];

/**
 * Suppression list: a person whose address bounced or who complained gets no email of any kind
 * from this company until the row is removed. Written by a future bounce/complaint webhook or by
 * an operator; read by every `sendUserEmail`.
 */
export const emailSuppressions = pgTable(
  "email_suppressions",
  {
    id: id(),
    companyId: companyId(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    reason: text(enumText(EMAIL_SUPPRESSION_REASONS)).notNull(),
    /** Provider or operator note; never the mail body. */
    detail: text(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex().on(t.companyId, t.userId), tenantPolicy("email_suppressions")],
).enableRLS();

export const EMAIL_SEND_STATUSES = ["pending", "sent", "skipped", "failed"] as const;
export type EmailSendStatus = (typeof EMAIL_SEND_STATUSES)[number];

/**
 * One row per `(company, dedupe_key)`: the durable send guard (ADR 0016 §5, wave 19 A7). Inserted
 * `pending` in its own short transaction before the transport call, then marked `sent`, `skipped`
 * (with the reason) or `failed` (transport error; a retry with the same key takes the row over).
 * A repeat key on a `sent`/`skipped`/fresh `pending` row is answered `skipped: duplicate` without
 * touching the transport. Retention: rows older than 90 days may be purged (follow-up job).
 */
export const emailSends = pgTable(
  "email_sends",
  {
    id: id(),
    companyId: companyId(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text().notNull(),
    dedupeKey: text().notNull(),
    /** The deterministic RFC 5322 Message-ID the caller chose (`<...@domain>`). */
    messageId: text().notNull(),
    status: text(enumText(EMAIL_SEND_STATUSES)).notNull().default("pending"),
    /** Skip or failure reason; null while pending or once sent. */
    reason: text(),
    sentAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex().on(t.companyId, t.dedupeKey),
    index().on(t.companyId, t.userId, t.createdAt),
    tenantPolicy("email_sends"),
  ],
).enableRLS();
