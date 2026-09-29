import { sql } from "drizzle-orm";
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
import {
  enumText,
  id,
  jsonArray,
  jsonObject,
  tenantKey,
  tenantPolicy,
  timestamps,
} from "./_shared";
import { companyId } from "./tenancy";

export const CHANNELS = ["etsy", "amazon", "shopify", "tiktok", "walmart", "ebay", "csv"] as const;
export type Channel = (typeof CHANNELS)[number];

export const CONNECTION_STATUSES = [
  "pending",
  "connected",
  "csv_only",
  "error",
  "disconnected",
] as const;

export type ConnectionSettings = {
  autoImport: boolean;
  processingDays: number | null;
  riskWindowHours: number;
  pushTracking: boolean;
  pushAvailability: boolean;
};

export const DEFAULT_CONNECTION_SETTINGS: ConnectionSettings = {
  autoImport: true,
  processingDays: null,
  riskWindowHours: 24,
  pushTracking: true,
  pushAvailability: false,
};

/** A shop's link to one marketplace account. Credentials are field-encrypted (AES-256-GCM). */
export const channelConnections = pgTable(
  "channel_connections",
  {
    id: id(),
    companyId: companyId(),
    channel: text(enumText(CHANNELS)).notNull(),
    name: text().notNull(),
    status: text(enumText(CONNECTION_STATUSES)).notNull().default("pending"),
    mode: text(enumText(["api", "csv"] as const))
      .notNull()
      .default("csv"),
    /** Real adapter or the mock provider (no API key). */
    provider: text(enumText(["live", "mock"] as const))
      .notNull()
      .default("mock"),
    /** e.g. the Shopify shop domain or the Etsy shop id. */
    externalShopId: text(),
    /** Encrypted JSON: access/refresh tokens, expiry, scopes. Never returned by the API. */
    credentials: encryptedText(),
    settings: jsonObject<ConnectionSettings>().default(DEFAULT_CONNECTION_SETTINGS),
    cursor: text(),
    lastWebhookAt: timestamp({ withTimezone: true }),
    lastPollAt: timestamp({ withTimezone: true }),
    lastImportAt: timestamp({ withTimezone: true }),
    lastError: text(),
    lastErrorAt: timestamp({ withTimezone: true }),
    connectedAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    tenantKey("channel_connections", t),
    index().on(t.companyId, t.channel),
    uniqueIndex().on(t.companyId, t.channel, t.externalShopId),
    // A marketplace store is connected to at most one company (webhooks route by it).
    uniqueIndex("channel_connections_connected_shop_uq")
      .on(t.channel, t.externalShopId)
      .where(sql`status = 'connected' and external_shop_id is not null`),
    tenantPolicy("channel_connections"),
  ],
).enableRLS();

export const LISTING_STATES = ["active", "draft", "inactive"] as const;

export const listings = pgTable(
  "listings",
  {
    id: id(),
    companyId: companyId(),
    connectionId: uuid().notNull(),
    channel: text(enumText(CHANNELS)).notNull(),
    channelListingId: text().notNull(),
    title: text().notNull(),
    state: text(enumText(LISTING_STATES)).notNull().default("active"),
    url: text(),
    designId: uuid(),
    productId: uuid(),
    raw: jsonObject<Record<string, unknown>>(),
    lastSyncedAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    tenantKey("listings", t),
    uniqueIndex().on(t.companyId, t.connectionId, t.channelListingId),
    index().on(t.companyId, t.designId),
    foreignKey({
      name: "listings_connection_id_fk",
      columns: [t.companyId, t.connectionId],
      foreignColumns: [channelConnections.companyId, channelConnections.id],
    }).onDelete("cascade"),
    tenantPolicy("listings"),
  ],
).enableRLS();

export const listingVariants = pgTable(
  "listing_variants",
  {
    id: id(),
    companyId: companyId(),
    listingId: uuid().notNull(),
    channelVariantId: text().notNull(),
    channelSku: text(),
    title: text(),
    attributes: jsonObject<Record<string, string>>(),
    designId: uuid(),
    blankVariantId: uuid(),
    priceCents: integer(),
    /** Optional cap on the availability pushed to the channel. */
    quantityCap: integer(),
    lastPushedQty: integer(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex().on(t.companyId, t.listingId, t.channelVariantId),
    index().on(t.companyId, t.channelSku),
    index().on(t.companyId, t.blankVariantId),
    foreignKey({
      name: "listing_variants_listing_id_fk",
      columns: [t.companyId, t.listingId],
      foreignColumns: [listings.companyId, listings.id],
    }).onDelete("cascade"),
    tenantPolicy("listing_variants"),
  ],
).enableRLS();

export const SKU_PATTERN_TYPES = ["exact", "regex", "template"] as const;
export const SKU_RULE_SOURCES = ["manual", "learned", "suggested"] as const;

export type SkuRuleTarget =
  | { kind: "direct"; designId: string; blankVariantId: string }
  | { kind: "resolve"; defaults: Record<string, string> };

/** Maps a channel SKU to design + blank variant (contracts `SkuRule`). */
export const skuRules = pgTable(
  "sku_rules",
  {
    id: id(),
    companyId: companyId(),
    name: text(),
    patternType: text(enumText(SKU_PATTERN_TYPES)).notNull().default("exact"),
    pattern: text().notNull(),
    channel: text(enumText(CHANNELS)),
    connectionId: uuid(),
    target: jsonObject<SkuRuleTarget>().default({ kind: "resolve", defaults: {} }),
    priority: integer().notNull().default(0),
    active: boolean().notNull().default(true),
    source: text(enumText(SKU_RULE_SOURCES)).notNull().default("manual"),
    matchCount: integer().notNull().default(0),
    lastMatchedAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex().on(t.companyId, t.channel, t.connectionId, t.pattern),
    index().on(t.companyId, t.patternType, t.priority),
    foreignKey({
      name: "sku_rules_connection_id_fk",
      columns: [t.companyId, t.connectionId],
      foreignColumns: [channelConnections.companyId, channelConnections.id],
    }).onDelete("cascade"),
    tenantPolicy("sku_rules"),
  ],
).enableRLS();

export const CSV_FORMATS = ["etsy", "amazon", "tiktok", "walmart", "shopify", "generic"] as const;
export const IMPORT_STATUSES = ["pending", "running", "completed", "failed"] as const;

export type ImportError = { row: number; message: string };

/** One CSV (or API) import run and its report. */
export const importRuns = pgTable(
  "import_runs",
  {
    id: id(),
    companyId: companyId(),
    connectionId: uuid().notNull(),
    format: text(enumText(CSV_FORMATS)).notNull().default("generic"),
    fileKey: text().notNull().default(""),
    status: text(enumText(IMPORT_STATUSES)).notNull().default("pending"),
    rowsTotal: integer().notNull().default(0),
    ordersImported: integer().notNull().default(0),
    ordersUpdated: integer().notNull().default(0),
    ordersSkipped: integer().notNull().default(0),
    rowsFailed: integer().notNull().default(0),
    itemsNeedingMapping: integer().notNull().default(0),
    errors: jsonArray<ImportError>(),
    orderIds: uuid().array().notNull().default([]),
    createdBy: uuid(),
    startedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index().on(t.companyId, t.startedAt),
    foreignKey({
      name: "import_runs_connection_id_fk",
      columns: [t.companyId, t.connectionId],
      foreignColumns: [channelConnections.companyId, channelConnections.id],
    }).onDelete("cascade"),
    tenantPolicy("import_runs"),
  ],
).enableRLS();
