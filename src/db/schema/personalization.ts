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
import {
  enumText,
  id,
  jsonArray,
  jsonObject,
  tenantKey,
  tenantPolicy,
  timestamps,
} from "./_shared";
import { orderItems } from "./orders";
import { companyId } from "./tenancy";

/** Contracts `TemplateSlot` (camelCase); translated to imaging's snake_case at render time. */
export type TemplateSlot = {
  name: string;
  kind: "text" | "photo";
  xIn: number;
  yIn: number;
  wIn: number;
  hIn: number;
  fontFamily: "Inter" | "Inter Bold" | "Inter Black" | "Oswald" | "Pacifico" | "Bebas Neue";
  fontSizePt: number;
  minFontSizePt: number | null;
  maxLines: number | null;
  strokeWidthPt: number;
  strokeColor: string | null;
  fit: "fit" | "fill";
  color: string;
  align: "left" | "center" | "right";
  maxChars: number | null;
  uppercase: boolean;
  sourceQuestion: string | null;
  required: boolean;
  placeholder: string | null;
};

export const personalizationTemplates = pgTable(
  "personalization_templates",
  {
    id: id(),
    companyId: companyId(),
    name: text().notNull(),
    widthIn: doublePrecision().notNull(),
    heightIn: doublePrecision().notNull(),
    backgroundKey: text(),
    dpi: integer().notNull().default(300),
    slots: jsonArray<TemplateSlot>(),
    ...timestamps,
  },
  (t) => [
    tenantKey("personalization_templates", t),
    index().on(t.companyId),
    tenantPolicy("personalization_templates"),
  ],
).enableRLS();

/** `purged`: the buyer text and rendered art were removed on a retention clock (decision 0027). */
export const ARTWORK_STATUSES = [
  "pending",
  "rendered",
  "flagged",
  "approved",
  "failed",
  "purged",
] as const;

export type ArtworkFlag = {
  slot: string | null;
  code: string;
  message: string;
  suggestion: string | null;
};

/** Rendered artwork for one personalized order item. */
export const itemArtwork = pgTable(
  "item_artwork",
  {
    id: id(),
    companyId: companyId(),
    orderItemId: uuid().notNull(),
    templateId: uuid().notNull(),
    /** Slot name -> text. Starts from the buyer's answers; edited by staff. */
    values: jsonObject<Record<string, string>>(),
    fileKey: text(),
    previewKey: text(),
    widthPx: integer(),
    heightPx: integer(),
    flags: jsonArray<ArtworkFlag>(),
    status: text(enumText(ARTWORK_STATUSES)).notNull().default("pending"),
    error: text(),
    renderedAt: timestamp({ withTimezone: true }),
    approvedBy: uuid(),
    approvedAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex().on(t.companyId, t.orderItemId),
    index().on(t.companyId, t.status),
    foreignKey({
      name: "item_artwork_order_item_id_fk",
      columns: [t.companyId, t.orderItemId],
      foreignColumns: [orderItems.companyId, orderItems.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "item_artwork_template_id_fk",
      columns: [t.companyId, t.templateId],
      foreignColumns: [personalizationTemplates.companyId, personalizationTemplates.id],
    }).onDelete("restrict"),
    tenantPolicy("item_artwork"),
  ],
).enableRLS();
