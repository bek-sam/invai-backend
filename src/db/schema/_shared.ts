import { sql } from "drizzle-orm";
import {
  jsonb,
  type PgColumn,
  pgPolicy,
  pgRole,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

/** The role the app connects as. Not the table owner, no BYPASSRLS. Created by infra, not migrations. */
export const appRole = pgRole("invai_app").existing();

/** `app.company_id` is set per transaction by `withTenant()`; unset means "no rows". */
export const currentCompanyId = sql`nullif(current_setting('app.company_id', true), '')::uuid`;
/** `app.vendor_org_id` is set by `withVendor()` for DTF vendor portal requests. */
export const currentVendorOrgId = sql`nullif(current_setting('app.vendor_org_id', true), '')::uuid`;

const tenantMatch = sql`company_id = ${currentCompanyId}`;

/**
 * The standard tenant policy: the app role sees and writes only rows of the active company.
 * Every tenant table adds `tenantPolicy("<table>")` to its extras and calls `.enableRLS()`.
 */
export function tenantPolicy(table: string) {
  return pgPolicy(`${table}_tenant`, {
    for: "all",
    to: appRole,
    using: tenantMatch,
    withCheck: tenantMatch,
  });
}

/** A read-only policy for the vendor org: `using` decides which rows a vendor may see. */
export function vendorReadPolicy(table: string, using: ReturnType<typeof sql>) {
  return pgPolicy(`${table}_vendor_read`, { for: "select", to: appRole, using });
}

/** An update policy for the vendor org (e.g. a vendor marking a sheet printed). */
export function vendorUpdatePolicy(table: string, using: ReturnType<typeof sql>) {
  return pgPolicy(`${table}_vendor_update`, {
    for: "update",
    to: appRole,
    using,
    withCheck: using,
  });
}

/**
 * The `(company_id, id)` key a composite tenant foreign key points at (S-26, B-30, T-22-2). A
 * tenant table that another tenant table references adds `tenantKey("<table>", t)` to its
 * extras; the child then declares
 * `foreignKey({ name: "<child>_<col>_fk", columns: [t.companyId, t.<col>], foreignColumns: [parent.companyId, parent.id] })`
 * instead of `.references(() => parent.id)`. FK checks ignore RLS, so a single-column FK would
 * let a row of shop B point at shop A's row; `src/db/fk-coverage.test.ts` fails on any such FK.
 */
export const tenantKey = (table: string, t: { companyId: PgColumn; id: PgColumn }) =>
  unique(`${table}_company_id_id_unique`).on(t.companyId, t.id);

/** Global (non-tenant) tables readable by every company, e.g. trademark marks, plans. */
export function publicReadPolicy(table: string) {
  return pgPolicy(`${table}_public_read`, { for: "select", to: appRole, using: sql`true` });
}

export const id = () => uuid().primaryKey().defaultRandom();

export const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();
export const updatedAt = () =>
  timestamp({ withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

export const timestamps = { createdAt: createdAt(), updatedAt: updatedAt() };

export const jsonObject = <T extends Record<string, unknown>>() =>
  jsonb()
    .$type<T>()
    .notNull()
    .default({} as T);
export const jsonArray = <T>() => jsonb().$type<T[]>().notNull().default([]);

/** Marker for enum-like text columns; keeps migrations simple (no pg enums to alter). */
export const enumText = <const T extends readonly [string, ...string[]]>(values: T) =>
  ({ enum: values }) as { enum: T };
