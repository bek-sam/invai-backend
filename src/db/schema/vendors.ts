import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  currentVendorOrgId,
  enumText,
  id,
  jsonObject,
  tenantPolicy,
  timestamps,
  vendorReadPolicy,
} from "./_shared";
import { companies, companyId } from "./tenancy";

/** The vendor's output spec; drives imaging /nest and /compose (contracts `SheetSpec`). */
export type SheetSpec = {
  widthIn: number;
  maxLengthIn: number;
  format: "png" | "pdf";
  dpi: number;
  /** Cents per linear inch of film; total = lengthIn × pricePerInch. */
  pricePerInch: number;
  spacingIn: number;
  marginIn: number;
  /** Clear film between a design and its label (contracts `SheetSpec.labelGapIn`, B-79). */
  labelGapIn: number;
  colorProfile: string | null;
  notes: string | null;
};

export const DEFAULT_SHEET_SPEC: SheetSpec = {
  widthIn: 22,
  maxLengthIn: 240,
  format: "png",
  dpi: 300,
  pricePerInch: 30,
  spacingIn: 0.25,
  marginIn: 0.25,
  labelGapIn: 0.125,
  colorProfile: null,
  notes: null,
};

export const VENDOR_CONNECTION_STATUSES = ["invited", "active", "paused"] as const;

/**
 * Shop side: a DTF vendor this shop sends sheets to. `vendorCompanyId` is set once the vendor
 * accepted the invite and has a portal org (a company of type `vendor`); null = email delivery.
 * Vendors can read the connections that point at them.
 */
export const vendorConnections = pgTable(
  "vendor_connections",
  {
    id: id(),
    companyId: companyId(),
    vendorCompanyId: uuid().references(() => companies.id, { onDelete: "set null" }),
    name: text().notNull(),
    email: text().notNull(),
    status: text(enumText(VENDOR_CONNECTION_STATUSES)).notNull().default("invited"),
    delivery: text(enumText(["portal", "email"] as const))
      .notNull()
      .default("email"),
    spec: jsonObject<SheetSpec>().default(DEFAULT_SHEET_SPEC),
    isDefault: boolean().notNull().default(false),
    turnaroundDays: integer().notNull().default(2),
    inviteToken: text(),
    invitedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    acceptedAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex().on(t.companyId, t.vendorCompanyId),
    index().on(t.vendorCompanyId),
    tenantPolicy("vendor_connections"),
    vendorReadPolicy("vendor_connections", sql`vendor_company_id = ${currentVendorOrgId}`),
  ],
).enableRLS();

/**
 * Explicit grant of one gang sheet to one vendor org. A vendor's RLS on gang_sheets goes
 * through this table, so nothing is visible to a vendor without a row here.
 */
export const vendorAccess = pgTable(
  "vendor_access",
  {
    id: id(),
    companyId: companyId(),
    vendorCompanyId: uuid()
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    gangSheetId: uuid().notNull(),
    grantedBy: uuid(),
    grantedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    uniqueIndex().on(t.companyId, t.vendorCompanyId, t.gangSheetId),
    index().on(t.vendorCompanyId, t.gangSheetId),
    tenantPolicy("vendor_access"),
    vendorReadPolicy(
      "vendor_access",
      sql`vendor_company_id = ${currentVendorOrgId} and revoked_at is null`,
    ),
  ],
).enableRLS();

/**
 * Rows of a table are vendor-visible when a live vendor_access row names their sheet and was
 * granted by the company that owns the row (a vendor_access row a vendor wrote for itself, or
 * one pointing at another company's sheet id, exposes nothing).
 */
export const vendorHasSheetAccess = (table: string, sheetIdColumn: string) =>
  sql.raw(
    `${table}.${sheetIdColumn} in (select va.gang_sheet_id from vendor_access va where va.company_id = ${table}.company_id and va.vendor_company_id = nullif(current_setting('app.vendor_org_id', true), '')::uuid and va.revoked_at is null)`,
  );
