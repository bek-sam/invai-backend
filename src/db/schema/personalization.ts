import {
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { enumText, id, jsonArray, jsonObject, tenantPolicy, timestamps } from "./_shared";
import { orderItems } from "./orders";
import { companyId } from "./tenancy";

/** Contracts `TemplateSlot` (camelCase); translated to imaging's snake_case at render time. */
export type TemplateSlot = {
  name: string;
  kind: "text";
  xIn: number;
  yIn: number;
  wIn: number;
  hIn: number;
  fontFamily: string;
  fontSizePt: number;
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
  (t) => [index().on(t.companyId), tenantPolicy("personalization_templates")],
).enableRLS();

export const ARTWORK_STATUSES = ["pending", "rendered", "flagged", "approved", "failed"] as const;

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
    orderItemId: uuid()
      .notNull()
      .references(() => orderItems.id, { onDelete: "cascade" }),
    templateId: uuid()
      .notNull()
      .references(() => personalizationTemplates.id, { onDelete: "restrict" }),
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
    tenantPolicy("item_artwork"),
  ],
).enableRLS();
