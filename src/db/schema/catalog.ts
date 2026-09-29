import {
  doublePrecision,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { enumText, id, jsonArray, tenantKey, tenantPolicy, timestamps } from "./_shared";
import { companyId } from "./tenancy";

export const PLACEMENTS = ["front", "back", "left_chest", "sleeve_left", "sleeve_right"] as const;
export type Placement = (typeof PLACEMENTS)[number];

export const ACTIVE_STATUSES = ["active", "archived"] as const;
export const QA_STATUSES = ["pending", "passed", "warn", "failed"] as const;
export type QaStatus = (typeof QA_STATUSES)[number];

export const designs = pgTable(
  "designs",
  {
    id: id(),
    companyId: companyId(),
    /** Short code used in SKUs, e.g. D1042. Unique per company. */
    code: text().notNull(),
    name: text().notNull(),
    tags: text().array().notNull().default([]),
    status: text(enumText(ACTIVE_STATUSES)).notNull().default("active"),
    /** Set when orders for this design need personalization rendering. */
    personalizationTemplateId: uuid(),
    /** Text found in the artwork by OCR, used by the trademark check. */
    ocrText: text(),
    ...timestamps,
  },
  (t) => [
    tenantKey("designs", t),
    uniqueIndex().on(t.companyId, t.code),
    index().on(t.companyId, t.status),
    tenantPolicy("designs"),
  ],
).enableRLS();

export type QaIssue = {
  code: "low_dpi" | "soft_alpha" | "no_alpha" | "tiny_file" | "unreadable";
  severity: "error" | "warn";
  message: string;
};

/** One print file per placement. Dimensions are inches at print size. */
export const designFiles = pgTable(
  "design_files",
  {
    id: id(),
    companyId: companyId(),
    designId: uuid().notNull(),
    placement: text(enumText(PLACEMENTS)).notNull().default("front"),
    fileKey: text().notNull(),
    previewKey: text(),
    widthIn: doublePrecision().notNull(),
    heightIn: doublePrecision().notNull(),
    widthPx: integer(),
    heightPx: integer(),
    qaStatus: text(enumText(QA_STATUSES)).notNull().default("pending"),
    effectiveDpi: doublePrecision(),
    qaIssues: jsonArray<QaIssue>(),
    qaCheckedAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex().on(t.companyId, t.designId, t.placement),
    foreignKey({
      name: "design_files_design_id_fk",
      columns: [t.companyId, t.designId],
      foreignColumns: [designs.companyId, designs.id],
    }).onDelete("cascade"),
    tenantPolicy("design_files"),
  ],
).enableRLS();

export const SUPPLIERS = ["ssactivewear", "sanmar", "other"] as const;
export type SupplierKind = (typeof SUPPLIERS)[number];

/**
 * One garment SKU: brand × style × color × size, flat. Upserted by
 * (brand, styleCode, colorCode, sizeCode). `sku` is our own code, e.g. G64000-BLK-M.
 */
export const blankVariants = pgTable(
  "blank_variants",
  {
    id: id(),
    companyId: companyId(),
    brand: text().notNull(),
    style: text().notNull(),
    styleCode: text().notNull(),
    styleName: text(),
    color: text().notNull(),
    colorCode: text().notNull(),
    colorHex: text(),
    size: text().notNull(),
    sizeCode: text().notNull(),
    sku: text().notNull(),
    supplier: text(enumText(SUPPLIERS)).notNull().default("ssactivewear"),
    supplierSku: text().notNull().default(""),
    costCents: integer().notNull().default(0),
    weightOz: doublePrecision().notNull().default(6),
    reorderPoint: integer(),
    reorderQty: integer(),
    status: text(enumText(ACTIVE_STATUSES)).notNull().default("active"),
    ...timestamps,
  },
  (t) => [
    tenantKey("blank_variants", t),
    uniqueIndex().on(t.companyId, t.brand, t.styleCode, t.colorCode, t.sizeCode),
    uniqueIndex().on(t.companyId, t.sku),
    index().on(t.companyId, t.styleCode),
    index().on(t.companyId, t.supplierSku),
    tenantPolicy("blank_variants"),
  ],
).enableRLS();

export type ProductPrice = { channel: string; price: number };

/** A design on a blank style. Stock lives on blank variants, never on products. */
export const products = pgTable(
  "products",
  {
    id: id(),
    companyId: companyId(),
    designId: uuid().notNull(),
    brand: text().notNull(),
    styleCode: text().notNull(),
    name: text().notNull(),
    allowedColorCodes: text().array().notNull().default([]),
    allowedSizeCodes: text().array().notNull().default([]),
    defaultPlacements: text().array().notNull().default(["front"]),
    prices: jsonArray<ProductPrice>(),
    status: text(enumText(ACTIVE_STATUSES)).notNull().default("active"),
    ...timestamps,
  },
  (t) => [
    index().on(t.companyId, t.designId),
    index().on(t.companyId, t.styleCode),
    foreignKey({
      name: "products_design_id_fk",
      columns: [t.companyId, t.designId],
      foreignColumns: [designs.companyId, designs.id],
    }).onDelete("restrict"),
    tenantPolicy("products"),
  ],
).enableRLS();
