import {
  boolean,
  doublePrecision,
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
  enumText,
  id,
  jsonObject,
  tenantPolicy,
  timestamps,
  vendorReadPolicy,
  vendorUpdatePolicy,
} from "./_shared";
import { orderItems, orders } from "./orders";
import { companyId, locations, stations } from "./tenancy";
import { vendorConnections, vendorHasSheetAccess } from "./vendors";

export const BATCH_STATUSES = [
  "building",
  "ready",
  "sent",
  "complete",
  "failed",
  "cancelled",
] as const;

/** One "build sheets" run: a set of items nested onto one or more gang sheets. */
export const gangSheetBatches = pgTable(
  "gang_sheet_batches",
  {
    id: id(),
    companyId: companyId(),
    name: text().notNull(),
    status: text(enumText(BATCH_STATUSES)).notNull().default("building"),
    dueBefore: timestamp({ withTimezone: true }),
    vendorConnectionId: uuid().references(() => vendorConnections.id, { onDelete: "set null" }),
    options: jsonObject<Record<string, unknown>>(),
    itemCount: integer().notNull().default(0),
    sheetCount: integer().notNull().default(0),
    jobId: uuid(),
    error: text(),
    createdBy: uuid(),
    ...timestamps,
  },
  (t) => [index().on(t.companyId, t.status, t.createdAt), tenantPolicy("gang_sheet_batches")],
).enableRLS();

/** Sheet lifecycle (contracts SHEET_STATES / SHEET_TRANSITIONS). */
export const SHEET_STATES = [
  "building",
  "ready",
  "sent",
  "acknowledged",
  "printed",
  "shipped",
  "received",
  "failed",
  "cancelled",
  // Added at the end (additive): in-house printing, when a company prints its own sheets.
  "printing",
] as const;
export type SheetState = (typeof SHEET_STATES)[number];

/** A composed 22in-wide sheet. Vendors read (and advance the status of) sheets shared with them. */
export const gangSheets = pgTable(
  "gang_sheets",
  {
    id: id(),
    companyId: companyId(),
    batchId: uuid()
      .notNull()
      .references(() => gangSheetBatches.id, { onDelete: "cascade" }),
    sheetNo: integer().notNull().default(1),
    /** Human name printed on the sheet, e.g. "2026-09-24 #1". */
    name: text().notNull(),
    vendorConnectionId: uuid().references(() => vendorConnections.id, { onDelete: "set null" }),
    widthIn: doublePrecision().notNull().default(22),
    lengthIn: doublePrecision().notNull().default(0),
    utilization: doublePrecision().notNull().default(0),
    status: text(enumText(SHEET_STATES)).notNull().default("building"),
    pngKey: text(),
    pdfKey: text(),
    previewKey: text(),
    transferCount: integer().notNull().default(0),
    reprintCount: integer().notNull().default(0),
    costCents: integer().notNull().default(0),
    trackingCarrier: text(),
    trackingCode: text(),
    vendorNotes: text(),
    error: text(),
    sentAt: timestamp({ withTimezone: true }),
    acknowledgedAt: timestamp({ withTimezone: true }),
    printedAt: timestamp({ withTimezone: true }),
    shippedAt: timestamp({ withTimezone: true }),
    receivedAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex().on(t.companyId, t.name),
    index().on(t.companyId, t.status, t.createdAt),
    index().on(t.companyId, t.batchId),
    tenantPolicy("gang_sheets"),
    vendorReadPolicy("gang_sheets", vendorHasSheetAccess("gang_sheets", "id")),
    vendorUpdatePolicy("gang_sheets", vendorHasSheetAccess("gang_sheets", "id")),
  ],
).enableRLS();

export const TRANSFER_STATUSES = ["placed", "received", "pressed", "scrap"] as const;

export type TransferLabel = {
  order_no: string;
  item_no: string;
  size: string;
  color: string;
  design: string;
  reprint: boolean;
};

/** One printed copy of one item's artwork on a sheet. Its id is what the QR code encodes. */
export const transfers = pgTable(
  "transfers",
  {
    id: id(),
    companyId: companyId(),
    gangSheetId: uuid()
      .notNull()
      .references(() => gangSheets.id, { onDelete: "cascade" }),
    orderItemId: uuid()
      .notNull()
      .references(() => orderItems.id, { onDelete: "cascade" }),
    xIn: doublePrecision().notNull().default(0),
    yIn: doublePrecision().notNull().default(0),
    widthIn: doublePrecision().notNull(),
    heightIn: doublePrecision().notNull(),
    rotated: boolean().notNull().default(false),
    label: jsonObject<TransferLabel>(),
    status: text(enumText(TRANSFER_STATUSES)).notNull().default("placed"),
    isReprint: boolean().notNull().default(false),
    /** Set when the item was cancelled after nesting; the transfer is scrap. */
    scrapped: boolean().notNull().default(false),
    pressedAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index().on(t.companyId, t.gangSheetId),
    index().on(t.companyId, t.orderItemId),
    tenantPolicy("transfers"),
    vendorReadPolicy("transfers", vendorHasSheetAccess("transfers", "gang_sheet_id")),
  ],
).enableRLS();

export const SCAN_ACTIONS = ["pick", "press", "qc_pass", "qc_fail", "pack"] as const;

/**
 * Every scan on the floor. `clientScanId` comes from the tablet so offline replays are
 * idempotent: a repeated id returns the stored `result`.
 */
export const scans = pgTable(
  "scans",
  {
    id: id(),
    companyId: companyId(),
    clientScanId: uuid().notNull(),
    stationId: uuid().references(() => stations.id, { onDelete: "set null" }),
    station: text().notNull(),
    action: text(enumText(SCAN_ACTIONS)).notNull(),
    userId: uuid(),
    transferCode: text().notNull(),
    blankCode: text(),
    transferId: uuid().references(() => transfers.id, { onDelete: "set null" }),
    orderItemId: uuid().references(() => orderItems.id, { onDelete: "set null" }),
    ok: boolean().notNull(),
    mismatch: text(),
    /** The full contracts ScanResult, returned verbatim on replay. */
    result: jsonObject<Record<string, unknown>>(),
    scannedAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex().on(t.companyId, t.clientScanId),
    index().on(t.companyId, t.scannedAt),
    index().on(t.companyId, t.orderItemId),
    index().on(t.companyId, t.station, t.createdAt),
    tenantPolicy("scans"),
  ],
).enableRLS();

/** A tote or bin holding one order's units between stations. */
export const bins = pgTable(
  "bins",
  {
    id: id(),
    companyId: companyId(),
    locationId: uuid().references(() => locations.id, { onDelete: "set null" }),
    code: text().notNull(),
    // T-6-2 (wave 6 stub 4): turns the bin from pure occupancy state into a manageable entity.
    name: text(),
    archivedAt: timestamp({ withTimezone: true }),
    orderId: uuid().references(() => orders.id, { onDelete: "set null" }),
    station: text(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex().on(t.companyId, t.code),
    index().on(t.companyId, t.orderId),
    tenantPolicy("bins"),
  ],
).enableRLS();

export const FLOOR_REQUEST_KINDS = ["pack_order"] as const;

/**
 * The stored first result of an idempotent floor command (`production.packOrder` today), keyed
 * by the tablet's `idempotencyKey`. A replay returns `result` verbatim; a replay whose request
 * differs is a conflict. Only effective calls are stored: a refused pack has no effect.
 */
export const floorRequests = pgTable(
  "floor_requests",
  {
    id: id(),
    companyId: companyId(),
    kind: text(enumText(FLOOR_REQUEST_KINDS)).notNull(),
    idempotencyKey: text().notNull(),
    orderId: uuid().references(() => orders.id, { onDelete: "cascade" }),
    request: jsonObject<Record<string, unknown>>(),
    result: jsonb().$type<Record<string, unknown>>().notNull(),
    userId: uuid(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex().on(t.companyId, t.kind, t.idempotencyKey),
    index().on(t.companyId, t.orderId),
    tenantPolicy("floor_requests"),
  ],
).enableRLS();

export const REPRINT_REASONS = [
  "misprint",
  "peel",
  "ghosting",
  "color_off",
  "wrong_placement",
  "transfer_damaged",
  "blank_damaged",
  "wrong_blank",
  "press_error",
  "customer_request",
  "lost",
  "other",
] as const;

export const REPRINT_STATUSES = ["requested", "on_sheet", "done", "cancelled"] as const;

/** A QC failure (or lost transfer) that sends an item back to `ready` for a new transfer. */
export const reprints = pgTable(
  "reprints",
  {
    id: id(),
    companyId: companyId(),
    orderItemId: uuid()
      .notNull()
      .references(() => orderItems.id, { onDelete: "cascade" }),
    reason: text(enumText(REPRINT_REASONS)).notNull(),
    note: text(),
    status: text(enumText(REPRINT_STATUSES)).notNull().default("requested"),
    originalTransferId: uuid(),
    newTransferId: uuid(),
    /** True when the blank was ruined and consumed from stock. */
    blankConsumed: boolean().notNull().default(true),
    stationId: uuid(),
    requestedBy: uuid(),
    requestedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    ...timestamps,
  },
  (t) => [
    index().on(t.companyId, t.requestedAt),
    index().on(t.companyId, t.orderItemId),
    index().on(t.companyId, t.status),
    tenantPolicy("reprints"),
  ],
).enableRLS();
