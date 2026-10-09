import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  createdAt,
  enumText,
  id,
  jsonObject,
  tenantKey,
  tenantPolicy,
  timestamps,
  updatedAt,
} from "./_shared";

/*
 * Better Auth tables (users, sessions, accounts, verifications, two_factors, companies, members,
 * invitations) and the account-security tables (sign_in_failures, password_history) are NOT tenant
 * tables: authentication runs before the tenant is known, so they carry no RLS.
 * Only src/auth.ts and modules/tenancy touch them. Every other table in this file is a tenant
 * table with `company_id` and a policy.
 */

export const users = pgTable("users", {
  id: id(),
  name: text().notNull(),
  email: text().notNull().unique(),
  emailVerified: boolean().notNull().default(false),
  image: text(),
  locale: text().notNull().default("en"),
  lastSeenAt: timestamp({ withTimezone: true }),
  /** Better Auth twoFactor plugin: true once the user confirmed an authenticator code. */
  twoFactorEnabled: boolean().notNull().default(false),
  /**
   * PIN-only floor staff: no password, no `accounts` row, so no web sign-in. Their `email` is a
   * synthetic placeholder (`PIN_ONLY_EMAIL_DOMAIN`) that nothing may ever mail or display.
   */
  pinOnly: boolean().notNull().default(false),
  /**
   * Start of the grace period for required two-step sign-in (T-28-2, ADR 0025): deadline = this +
   * MFA_GRACE_DAYS. Restarted when a user who was not required becomes required (src/lib/mfa.ts).
   * No backfill: rows that existed before the migration got the migration time.
   */
  mfaGraceStartsAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  ...timestamps,
});

export const COMPANY_TYPES = ["shop", "vendor"] as const;
export type CompanyType = (typeof COMPANY_TYPES)[number];

export const PLAN_KEYS = ["trial", "starter", "growth", "pro", "scale"] as const;

/** Companies are Better Auth organizations (`organization` model) with extra columns. */
export const companies = pgTable("companies", {
  id: id(),
  name: text().notNull(),
  slug: text().notNull().unique(),
  logo: text(),
  /** Better Auth stores organization metadata as a JSON string. */
  metadata: text(),
  type: text(enumText(COMPANY_TYPES)).notNull().default("shop"),
  /** Null for vendor orgs (the portal is free). */
  plan: text(enumText(PLAN_KEYS)).default("trial"),
  timezone: text().notNull().default("America/Phoenix"),
  demo: boolean().notNull().default(false),
  /**
   * Set on a user's own sample-data workspace (tenancy.demo.*): one per user, found by this
   * column whichever real company the user started it from. Null for every real company.
   */
  demoOwnerUserId: uuid()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  settings: jsonObject<CompanySettings>(),
  /**
   * Soft delete (privacy.deleteRequest, B-23): set when the owner asks to delete the company; the
   * hard purge runs 30 days later unless cancelled first. Null for every live company.
   */
  deletedAt: timestamp({ withTimezone: true }),
  /** Set when the hard purge ran: the row stays as an anonymized tombstone for the audit trail. */
  purgedAt: timestamp({ withTimezone: true }),
  ...timestamps,
});

export type CompanySettings = {
  riskWindowHours?: number;
  itemsPerHour?: number;
  shiftEndHour?: number;
  /** ISO time the setup checklist on Today was dismissed; absent = shown. */
  onboardingDismissedAt?: string;
  /** ISO time a demo workspace finished filling with sample data (tenancy.demo). */
  demoSeededAt?: string;
  /** ISO time a demo workspace was retired (reset or failed fill); it stays a sample workspace. */
  demoRetiredAt?: string;
  /** The shop prints its own DTF sheets instead of sending them to a vendor. */
  printsInHouse?: boolean;
  /** The outside shop that presses/ships for this org, if any (Etsy production-partner disclosure). */
  productionPartner?: { name: string; etsyPartnerId: string | null } | null;
  /** B-162: Saturday counts as a ship day for ship-by math (contracts 0.8.0 `me.updateOrg`). */
  shipsSaturday?: boolean;
  /** B-35: days after printing at which a transfer gets the age warning (contracts default 30). */
  transferAgeWarnDays?: number;
};

export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    token: text().notNull().unique(),
    ipAddress: text(),
    userAgent: text(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    activeOrganizationId: uuid().references(() => companies.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [index().on(t.userId)],
);

export const accounts = pgTable(
  "accounts",
  {
    id: id(),
    accountId: text().notNull(),
    providerId: text().notNull(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text(),
    refreshToken: text(),
    idToken: text(),
    accessTokenExpiresAt: timestamp({ withTimezone: true }),
    refreshTokenExpiresAt: timestamp({ withTimezone: true }),
    scope: text(),
    password: text(),
    ...timestamps,
  },
  (t) => [index().on(t.userId)],
);

export const verifications = pgTable(
  "verifications",
  {
    id: id(),
    identifier: text().notNull(),
    value: text().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    ...timestamps,
  },
  (t) => [index().on(t.identifier)],
);

/**
 * Better Auth twoFactor plugin (`twoFactor` model): the TOTP secret and backup codes, both
 * encrypted by Better Auth with BETTER_AUTH_SECRET. One row per user; `verified` stays false until
 * the first authenticator code is confirmed.
 */
export const twoFactors = pgTable(
  "two_factors",
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    secret: text().notNull(),
    backupCodes: text().notNull(),
    verified: boolean().notNull().default(true),
    failedVerificationCount: integer().notNull().default(0),
    lockedUntil: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex().on(t.userId)],
);

/**
 * Per-email sign-in lockout (T-28-2, B-185, ADR 0025). Global by design: sign-in runs before any
 * tenant is known, and unknown emails lock exactly like real ones. Keyed by an HMAC of the
 * normalized email, never the address. Rows go away on success, on a password reset, or once
 * stale (src/lib/account-lockout.ts).
 */
export const signInFailures = pgTable(
  "sign_in_failures",
  {
    emailHmac: text().primaryKey(),
    failures: integer().notNull().default(0),
    lockedUntil: timestamp({ withTimezone: true }),
    /** When the "account locked" email went out for the current lock (null: none, or no user). */
    notifiedAt: timestamp({ withTimezone: true }),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.updatedAt)],
);

/**
 * The last password hashes per user (T-28-2, B-186, ADR 0025), in Better Auth's own scrypt
 * format, at most 10 per user (the current one included), deleted with the user. Global like
 * `accounts`.
 */
export const passwordHistory = pgTable(
  "password_history",
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    hash: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  },
  (t) => [index().on(t.userId, t.createdAt)],
);

export const ROLES = [
  "owner",
  "admin",
  "office",
  "designer",
  "presser",
  "packer",
  "receiver",
  "vendor",
] as const;
export type Role = (typeof ROLES)[number];

export const MEMBER_STATUSES = ["active", "invited", "deactivated"] as const;

/** Better Auth `member` model: a user's role inside one company. */
export const members = pgTable(
  "members",
  {
    id: id(),
    organizationId: uuid()
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text(enumText(ROLES)).notNull().default("office"),
    status: text(enumText(MEMBER_STATUSES)).notNull().default("active"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex().on(t.organizationId, t.userId), index().on(t.userId)],
);

export const invitations = pgTable(
  "invitations",
  {
    id: id(),
    organizationId: uuid()
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    email: text().notNull(),
    role: text().notNull(),
    status: text().notNull().default("pending"),
    expiresAt: timestamp({ withTimezone: true }),
    inviterId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [
    index().on(t.organizationId),
    index().on(t.email),
    // One pending invite per company and email: a second invite resends the first.
    uniqueIndex("invitations_pending_org_email_unique")
      .on(t.organizationId, t.email)
      .where(sql`${t.status} = 'pending'`),
  ],
);

/** Every tenant table starts with this column. */
export const companyId = () =>
  uuid()
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" });

export type Address = {
  name: string;
  company: string | null;
  street1: string;
  street2: string | null;
  city: string;
  state: string;
  zip: string;
  country: string;
  phone: string | null;
  email: string | null;
};

export const locations = pgTable(
  "locations",
  {
    id: id(),
    companyId: companyId(),
    name: text().notNull(),
    address: jsonb().$type<Address>(),
    isDefault: boolean().notNull().default(false),
    ...timestamps,
  },
  (t) => [tenantKey("locations", t), index().on(t.companyId), tenantPolicy("locations")],
).enableRLS();

export const STATION_KINDS = ["pick", "press", "qc", "pack", "receiving"] as const;
export type StationKind = (typeof STATION_KINDS)[number];

/** A tablet or scanner post. `kind` null lets staff pick the screen on the tablet. */
export const stations = pgTable(
  "stations",
  {
    id: id(),
    companyId: companyId(),
    locationId: uuid().notNull(),
    name: text().notNull(),
    kind: text(enumText(STATION_KINDS)),
    active: boolean().notNull().default(true),
    tokenIssuedAt: timestamp({ withTimezone: true }),
    lastSeenAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    tenantKey("stations", t),
    index().on(t.companyId),
    foreignKey({
      name: "stations_location_id_fk",
      columns: [t.companyId, t.locationId],
      foreignColumns: [locations.companyId, locations.id],
    }).onDelete("restrict"),
    tenantPolicy("stations"),
  ],
).enableRLS();

/** A long random token issued to one tablet; only its hash is stored. */
export const stationTokens = pgTable(
  "station_tokens",
  {
    id: id(),
    companyId: companyId(),
    stationId: uuid().notNull(),
    tokenHash: text().notNull().unique(),
    /** First 8 chars, so an admin can tell tokens apart. */
    tokenPrefix: text().notNull(),
    createdBy: uuid().references(() => users.id, { onDelete: "set null" }),
    lastUsedAt: timestamp({ withTimezone: true }),
    revokedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index().on(t.companyId, t.stationId),
    foreignKey({
      name: "station_tokens_station_id_fk",
      columns: [t.companyId, t.stationId],
      foreignColumns: [stations.companyId, stations.id],
    }).onDelete("cascade"),
    tenantPolicy("station_tokens"),
  ],
).enableRLS();

/** 4–6 digit PIN per user per company (HMAC hashed; the station token is the first factor). */
export const staffPins = pgTable(
  "staff_pins",
  {
    id: id(),
    companyId: companyId(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    pinHash: text().notNull(),
    active: boolean().notNull().default(true),
    ...timestamps,
  },
  (t) => [
    uniqueIndex().on(t.companyId, t.userId),
    uniqueIndex().on(t.companyId, t.pinHash),
    tenantPolicy("staff_pins"),
  ],
).enableRLS();

export const ACTOR_KINDS = ["user", "station", "system"] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

export const auditLog = pgTable(
  "audit_log",
  {
    id: id(),
    companyId: companyId(),
    actorKind: text(enumText(ACTOR_KINDS)).notNull(),
    actorUserId: uuid(),
    stationId: uuid(),
    /** One of contracts AUDIT_ACTIONS, e.g. `item.state_changed`. */
    action: text().notNull(),
    entityType: text(),
    entityId: uuid(),
    summary: text().notNull().default(""),
    data: jsonObject<Record<string, unknown>>(),
    ip: text(),
    createdAt: createdAt(),
  },
  (t) => [
    index().on(t.companyId, t.createdAt),
    index().on(t.companyId, t.entityType, t.entityId),
    index().on(t.companyId, t.action, t.createdAt),
    tenantPolicy("audit_log"),
  ],
).enableRLS();

/** Transactional outbox. Written with the change, relayed to BullMQ by worker/outbox-relay.ts. */
export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: id(),
    companyId: companyId(),
    name: text().notNull(),
    payload: jsonb().$type<Record<string, unknown>>().notNull(),
    attempts: integer().notNull().default(0),
    lastError: text(),
    dispatchedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("outbox_events_pending_idx").on(t.createdAt).where(sql`dispatched_at is null`),
    // The 7-day purge of dispatched rows (worker/outbox-relay.ts `purgeDispatchedOutbox`).
    index("outbox_events_dispatched_idx").on(t.dispatchedAt).where(sql`dispatched_at is not null`),
    tenantPolicy("outbox_events"),
  ],
).enableRLS();

export const FILE_KINDS = [
  "design",
  "artwork",
  "template_background",
  "csv",
  "photo",
  "mockup",
  "sheet",
  "preview",
  "label",
  "export",
  "other",
] as const;

/** Every S3 object the app knows about. `key` is the S3 key inside S3_BUCKET. */
export const files = pgTable(
  "files",
  {
    id: id(),
    companyId: companyId(),
    key: text().notNull().unique(),
    kind: text(enumText(FILE_KINDS)).notNull().default("other"),
    filename: text(),
    contentType: text().notNull().default("application/octet-stream"),
    sizeBytes: bigint({ mode: "number" }),
    sha256: text(),
    status: text(enumText(["pending", "ready"] as const))
      .notNull()
      .default("pending"),
    uploadedBy: uuid(),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.companyId, t.kind), tenantPolicy("files")],
).enableRLS();

export const ALERT_SEVERITIES = ["info", "warning", "critical"] as const;
export const ALERT_STATUSES = ["open", "resolved"] as const;

/** "Today" alerts: at-risk orders, broken syncs, stuck sheets, low stock. Deduped by key. */
export const alerts = pgTable(
  "alerts",
  {
    id: id(),
    companyId: companyId(),
    /** One of contracts ALERT_KINDS. */
    kind: text().notNull(),
    severity: text(enumText(ALERT_SEVERITIES)).notNull().default("warning"),
    title: text().notNull(),
    message: text().notNull().default(""),
    entityType: text(),
    entityId: text(),
    dedupeKey: text().notNull(),
    status: text(enumText(ALERT_STATUSES)).notNull().default("open"),
    data: jsonObject<Record<string, unknown>>(),
    readAt: timestamp({ withTimezone: true }),
    resolvedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex().on(t.companyId, t.dedupeKey),
    index().on(t.companyId, t.status, t.createdAt),
    tenantPolicy("alerts"),
  ],
).enableRLS();

export const JOB_KINDS = [
  "build_sheets",
  "regenerate_sheet",
  "render_artwork",
  "csv_import",
  "batch_labels",
  "listing_drafts",
  "profit_recompute",
  "sync",
  "tenant_export",
] as const;
export const JOB_STATUSES = ["queued", "running", "done", "failed"] as const;

/** User-visible async work (contracts `Job`). Modules create a row, the BullMQ job updates it. */
export const jobs = pgTable(
  "jobs",
  {
    id: id(),
    companyId: companyId(),
    kind: text(enumText(JOB_KINDS)).notNull(),
    status: text(enumText(JOB_STATUSES)).notNull().default("queued"),
    progress: doublePrecision().notNull().default(0),
    message: text(),
    resultIds: uuid().array().notNull().default([]),
    error: text(),
    input: jsonObject<Record<string, unknown>>(),
    createdBy: uuid(),
    finishedAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [index().on(t.companyId, t.kind, t.createdAt), tenantPolicy("jobs")],
).enableRLS();
