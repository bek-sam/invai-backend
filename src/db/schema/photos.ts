import type {
  BlankColor,
  DesignPhotoAnalysis,
  PhotoChecks,
  PhotoPush,
  PhotoSetSpec,
} from "@invai/contracts";
import {
  GARMENT_TYPES,
  PHOTO_CHANNELS,
  PHOTO_IMAGE_SOURCES,
  PHOTO_IMAGE_STATUSES,
  PHOTO_PRESETS,
  PHOTO_PUSH_STATUSES,
  PHOTO_SCENE_KINDS,
  PHOTO_SET_STATUSES,
  PHOTO_VIEWS,
} from "@invai/contracts";
import {
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
import { enumText, id, jsonArray, tenantKey, tenantPolicy, timestamps } from "./_shared";
import { designs } from "./catalog";
import { companyId, users } from "./tenancy";

/*
 * Listing photos (wave 26, T-26-4, ADR 0023). Every table has `company_id` + RLS; children point
 * at their parent by `(company_id, id)` (S-26). Rendered images follow the design: deleting a
 * design cascades to its analysis and sets. No buyer PII is stored here.
 */

export const PHOTO_ANALYSIS_STATUSES = ["pending", "ready", "failed"] as const;
export const PHOTO_ZIP_DB_STATUSES = ["none", "queued", "building", "ready", "failed"] as const;

/** One cached design analysis per design (refresh replaces it). */
export const photoAnalyses = pgTable(
  "photo_analyses",
  {
    id: id(),
    companyId: companyId(),
    designId: uuid().notNull(),
    status: text(enumText(PHOTO_ANALYSIS_STATUSES)).notNull().default("pending"),
    /** The run that owns the row; a job whose id no longer matches is superseded and skips. */
    jobId: uuid().notNull(),
    analysis: jsonb().$type<DesignPhotoAnalysis>(),
    error: text(),
    requestedBy: uuid().references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex().on(t.companyId, t.designId),
    foreignKey({
      name: "photo_analyses_design_fk",
      columns: [t.companyId, t.designId],
      foreignColumns: [designs.companyId, designs.id],
    }).onDelete("cascade"),
    tenantPolicy("photo_analyses"),
  ],
).enableRLS();

export const photoSets = pgTable(
  "photo_sets",
  {
    id: id(),
    companyId: companyId(),
    designId: uuid().notNull(),
    /** Snapshot of the design name at creation, for the list (no cross-module read per row). */
    designName: text().notNull(),
    /** Client key, stable across retries: the same key returns the same set. */
    idempotencyKey: text().notNull(),
    /** Hash of the normalized spec; the same key with a different spec is a CONFLICT. */
    specHash: text().notNull(),
    status: text(enumText(PHOTO_SET_STATUSES)).notNull().default("queued"),
    garments: jsonArray<(typeof GARMENT_TYPES)[number]>(),
    colors: jsonArray<BlankColor>(),
    views: jsonArray<(typeof PHOTO_VIEWS)[number]>(),
    channels: jsonArray<(typeof PHOTO_CHANNELS)[number]>(),
    underbasePreview: boolean().notNull().default(true),
    /** Phase B: the lifestyle request as given (count, scene kinds); null for template-only sets. */
    lifestyle: jsonb().$type<NonNullable<PhotoSetSpec["lifestyle"]>>(),
    creditsEstimated: integer().notNull().default(0),
    error: text(),
    completedAt: timestamp({ withTimezone: true }),
    zipStatus: text(enumText(PHOTO_ZIP_DB_STATUSES)).notNull().default("none"),
    zipChannel: text(enumText(PHOTO_CHANNELS)),
    zipJobId: uuid(),
    /** Hash of the zip's channel + approved image ids; an unchanged approval set reuses the zip. */
    zipFingerprint: text(),
    zipKey: text(),
    zipBytes: integer(),
    zipImageCount: integer().notNull().default(0),
    zipBuiltAt: timestamp({ withTimezone: true }),
    zipError: text(),
    createdBy: uuid().references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    tenantKey("photo_sets", t),
    uniqueIndex().on(t.companyId, t.idempotencyKey),
    index().on(t.companyId, t.createdAt, t.id),
    index().on(t.companyId, t.designId, t.createdAt),
    foreignKey({
      name: "photo_sets_design_fk",
      columns: [t.companyId, t.designId],
      foreignColumns: [designs.companyId, designs.id],
    }).onDelete("cascade"),
    tenantPolicy("photo_sets"),
  ],
).enableRLS();

/** The charged unit: garment x view x color (templates). `charged_at` guards the one charge. */
export const photoCompositions = pgTable(
  "photo_compositions",
  {
    id: id(),
    companyId: companyId(),
    setId: uuid().notNull(),
    source: text(enumText(PHOTO_IMAGE_SOURCES)).notNull().default("template"),
    garment: text(enumText(GARMENT_TYPES)).notNull(),
    view: text(enumText(PHOTO_VIEWS)).notNull(),
    colorName: text().notNull(),
    /** Lowercase `#rrggbb`. */
    colorHex: text().notNull(),
    placement: text(enumText(["front", "back"] as const)).notNull(),
    sceneKind: text(enumText(PHOTO_SCENE_KINDS)),
    /** 0 for templates; 1..n for the set's AI scenes (several scenes may share garment and color). */
    sceneIndex: integer().notNull().default(0),
    /** Phase B: imaging's blank base + edit mask for this scene, and the base's print box. */
    sceneBaseKey: text(),
    sceneMaskKey: text(),
    scenePrintBoxPx: jsonb().$type<number[]>(),
    /** Provider attempt the scene is on (1, or 2 after one drift); 0 before the first. */
    sceneAttempt: integer().notNull().default(0),
    /** The stored raw scene of `sceneAttempt`: once set, the provider is never called for it again. */
    sceneKey: text(),
    /** From the requested scene kind (ADR 0023 §3), never from the output. */
    containsPerson: boolean().notNull().default(false),
    sceneModel: text(),
    /** Raw scene, base and mask are deleted 7 days after creation (ADR 0023 §9). */
    scenePurgedAt: timestamp({ withTimezone: true }),
    creditsCharged: integer().notNull().default(0),
    chargedAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    tenantKey("photo_compositions", t),
    uniqueIndex().on(t.companyId, t.setId, t.garment, t.view, t.colorHex, t.sceneIndex),
    foreignKey({
      name: "photo_compositions_set_fk",
      columns: [t.companyId, t.setId],
      foreignColumns: [photoSets.companyId, photoSets.id],
    }).onDelete("cascade"),
    tenantPolicy("photo_compositions"),
  ],
).enableRLS();

/** One image per composition per channel preset. */
export const photoImages = pgTable(
  "photo_images",
  {
    id: id(),
    companyId: companyId(),
    setId: uuid().notNull(),
    compositionId: uuid().notNull(),
    channel: text(enumText(PHOTO_CHANNELS)).notNull(),
    preset: text(enumText(PHOTO_PRESETS)).notNull(),
    slot: integer().notNull(),
    status: text(enumText(PHOTO_IMAGE_STATUSES)).notNull().default("queued"),
    key: text(),
    widthPx: integer(),
    heightPx: integer(),
    format: text(enumText(["jpeg", "png"] as const)),
    checks: jsonb().$type<PhotoChecks>(),
    designLockScore: doublePrecision(),
    aiGenerated: boolean().notNull().default(false),
    containsSyntheticPerson: boolean().notNull().default(false),
    drawnTemplate: boolean().notNull().default(true),
    altText: text(),
    creditsCharged: integer().notNull().default(0),
    model: text(),
    error: text(),
    reviewedBy: uuid().references(() => users.id, { onDelete: "set null" }),
    reviewedAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex().on(t.companyId, t.compositionId, t.preset),
    index().on(t.companyId, t.setId, t.channel, t.slot),
    foreignKey({
      name: "photo_images_set_fk",
      columns: [t.companyId, t.setId],
      foreignColumns: [photoSets.companyId, photoSets.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "photo_images_composition_fk",
      columns: [t.companyId, t.compositionId],
      foreignColumns: [photoCompositions.companyId, photoCompositions.id],
    }).onDelete("cascade"),
    tenantPolicy("photo_images"),
  ],
).enableRLS();

/**
 * A push of approved images to one Shopify product (phase B, T-27-3). Idempotent on the client
 * key. The product is a `listings` row of the same company and connection, checked by the service
 * under the tenant (no FK into the channels module's tables). Ids only, no buyer data.
 */
export const photoPushes = pgTable(
  "photo_pushes",
  {
    id: id(),
    companyId: companyId(),
    setId: uuid().notNull(),
    connectionId: uuid().notNull(),
    listingId: uuid().notNull(),
    /** `gid://shopify/Product/<channelListingId>` at request time. */
    productGid: text().notNull(),
    idempotencyKey: text().notNull(),
    /** Hash of (set, connection, listing, image ids): the same key with another request is a CONFLICT. */
    requestHash: text().notNull(),
    status: text(enumText(PHOTO_PUSH_STATUSES)).notNull().default("queued"),
    /** Approved images to send, in slot order. */
    imageIds: jsonArray<string>(),
    pushed: jsonArray<{ imageId: string; mediaId: string }>(),
    skipped: jsonb().$type<PhotoPush["skipped"]>().notNull().default([]),
    error: text(),
    requestedBy: uuid().references(() => users.id, { onDelete: "set null" }),
    completedAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex().on(t.companyId, t.idempotencyKey),
    index().on(t.companyId, t.setId, t.createdAt),
    foreignKey({
      name: "photo_pushes_set_fk",
      columns: [t.companyId, t.setId],
      foreignColumns: [photoSets.companyId, photoSets.id],
    }).onDelete("cascade"),
    tenantPolicy("photo_pushes"),
  ],
).enableRLS();
