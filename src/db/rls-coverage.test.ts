import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createCompany, createConnection, createOrder } from "../test/fixtures";
import { db, withSystem, withTenant, withVendor } from "./client";
import { gangSheetBatches, gangSheets, transfers, vendorAccess } from "./schema";

/*
 * Structural guarantees behind tenant isolation, checked against the migrated test database so
 * a new table without RLS (or a role change) fails CI instead of leaking data.
 */

/** Better Auth identity tables: global by design, scoped explicitly by the tenancy module. */
const GLOBAL_TABLES = new Set([
  "users",
  "sessions",
  "accounts",
  "verifications",
  // twoFactor plugin (T-2-3): one row per user, keyed by user_id, no company. Read by Better Auth
  // over the app connection like `accounts`; the TOTP secret and backup codes are encrypted.
  "two_factors",
  // T-28-2 (ADR 0025): pre-auth lockout counters keyed by an email HMAC (no user, no company yet)
  // and per-user password hashes like `accounts`; neither holds tenant data.
  "sign_in_failures",
  "password_history",
  "companies",
  "members",
  "invitations",
]);
/** Global catalogs: RLS on, read-only for the app role. */
const PUBLIC_READ_TABLES = new Set(["plans", "trademark_marks", "market_series_cache"]);

type TableInfo = {
  name: string;
  rls: boolean;
  owner: string;
  hasCompanyId: boolean;
  policies: number;
  appPolicies: number;
};

async function tables(): Promise<TableInfo[]> {
  const res = await db.execute<{
    name: string;
    rls: boolean;
    owner: string;
    has_company_id: boolean;
    policies: number;
    app_policies: number;
  }>(sql`
    select c.relname as name, c.relrowsecurity as rls, pg_get_userbyid(c.relowner) as owner,
      exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'company_id'
        and not a.attisdropped) as has_company_id,
      (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies,
      (select count(*)::int from pg_policy p where p.polrelid = c.oid
        and (select oid from pg_roles where rolname = 'invai_app') = any(p.polroles)) as app_policies
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p')
    order by 1`);
  return res.rows.map((r) => ({
    name: r.name,
    rls: r.rls,
    owner: r.owner,
    hasCompanyId: r.has_company_id,
    policies: r.policies,
    appPolicies: r.app_policies,
  }));
}

describe("RLS coverage", () => {
  it("every table with company_id has RLS enabled and an invai_app policy", async () => {
    const all = await tables();
    expect(all.length).toBeGreaterThan(40);
    const missing = all
      .filter((t) => t.hasCompanyId)
      .filter((t) => !t.rls || t.appPolicies === 0)
      .map((t) => t.name);
    expect(missing).toEqual([]);
  });

  it("tables without RLS are only the Better Auth identity tables", async () => {
    const unprotected = (await tables()).filter((t) => !t.rls).map((t) => t.name);
    expect(unprotected.filter((n) => !GLOBAL_TABLES.has(n))).toEqual([]);
    const noCompany = (await tables())
      .filter((t) => !t.hasCompanyId && !GLOBAL_TABLES.has(t.name))
      .map((t) => t.name);
    expect(noCompany.filter((n) => !PUBLIC_READ_TABLES.has(n))).toEqual([]);
  });

  it("the app role owns no table, is no superuser and has no BYPASSRLS", async () => {
    const res = await db.execute<{ user: string; super: boolean; bypass: boolean }>(
      sql`select current_user as user, rolsuper as super, rolbypassrls as bypass
          from pg_roles where rolname = current_user`,
    );
    expect(res.rows[0]).toEqual({ user: "invai_app", super: false, bypass: false });
    const owned = (await tables()).filter((t) => t.owner === "invai_app").map((t) => t.name);
    // Owners bypass RLS unless FORCE is set, so the app role must own nothing.
    expect(owned).toEqual([]);
  });

  it("the app role cannot write the global catalogs or rewrite the audit trail", async () => {
    const res = await db.execute<{ t: string; ins: boolean; upd: boolean; del: boolean }>(sql`
      select t, has_table_privilege('invai_app', t, 'INSERT') as ins,
        has_table_privilege('invai_app', t, 'UPDATE') as upd,
        has_table_privilege('invai_app', t, 'DELETE') as del
      from unnest(array['plans', 'trademark_marks', 'market_series_cache', 'audit_log', 'order_item_transitions']) t`);
    const by = Object.fromEntries(res.rows.map((r) => [r.t, r]));
    expect(by.plans).toMatchObject({ ins: false, upd: false, del: false });
    expect(by.trademark_marks).toMatchObject({ ins: false, upd: false, del: false });
    expect(by.market_series_cache).toMatchObject({ ins: false, upd: false, del: false });
    expect(by.audit_log).toMatchObject({ upd: false, del: false });
    expect(by.order_item_transitions).toMatchObject({ upd: false, del: false });
  });
});

/**
 * S-65: SECURITY DEFINER functions that may legitimately exist, as `schema.name(args)` with a
 * one-line reason each. Empty today: every one is a function that runs with its owner's rights,
 * so an owner-owned one executable by the app role reads every tenant's rows.
 */
const SECURITY_DEFINER_ALLOWLIST = new Set<string>([]);

describe("RLS-exempt paths (S-65)", () => {
  it("the app role holds no TRUNCATE on any table with company_id", async () => {
    // RLS does not apply to TRUNCATE. has_table_privilege covers direct grants, PUBLIC and membership.
    const res = await db.execute<{ name: string }>(sql`
      select c.relname as name
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p')
        and exists (select 1 from pg_attribute a where a.attrelid = c.oid
          and a.attname = 'company_id' and not a.attisdropped)
        and has_table_privilege('invai_app', c.oid, 'TRUNCATE')
      order by 1`);
    const names = res.rows.map((r) => r.name);
    expect(
      names,
      `invai_app can TRUNCATE ${names.join(", ")}: TRUNCATE ignores row-level security and would ` +
        "wipe every shop's rows. Revoke it (REVOKE TRUNCATE ON <table> FROM invai_app, and from PUBLIC) " +
        "and fix the migration or default privilege that granted it.",
    ).toEqual([]);
  });

  it("no SECURITY DEFINER function owned by an RLS-bypassing role is callable by the app role", async () => {
    const res = await db.execute<{ fn: string }>(sql`
      select format('%s.%s(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)) as fn
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      join pg_roles o on o.oid = p.proowner
      where p.prosecdef
        and n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
        and n.nspname not like 'pg\\_temp\\_%' and n.nspname not like 'pg\\_toast\\_temp\\_%'
        and (o.rolsuper or o.rolbypassrls
          or exists (select 1 from pg_class c where c.relowner = o.oid and c.relkind in ('r', 'p')
            and c.relnamespace not in (select oid from pg_namespace
              where nspname in ('pg_catalog', 'information_schema'))))
        and has_function_privilege('invai_app', p.oid, 'EXECUTE')
      order by 1`);
    const bad = res.rows.map((r) => r.fn).filter((fn) => !SECURITY_DEFINER_ALLOWLIST.has(fn));
    expect(
      bad,
      `SECURITY DEFINER function(s) ${bad.join(", ")} run with an owner that bypasses RLS and invai_app ` +
        "can execute them, so they can return or change every shop's rows. Make them SECURITY INVOKER, " +
        "or REVOKE EXECUTE ... FROM PUBLIC, invai_app. A legitimate one needs a reason in SECURITY_DEFINER_ALLOWLIST.",
    ).toEqual([]);
  });
});

describe("vendor policies cannot be abused", () => {
  async function shopWithSheet() {
    const shop = (await createCompany({ name: "Shop" })).id;
    const conn = await createConnection(shop);
    const { items } = await createOrder(shop, conn.id);
    const itemId = items[0]?.id as string;
    const sheet = await withTenant(shop, async (tx) => {
      const [batch] = await tx
        .insert(gangSheetBatches)
        .values({ companyId: shop, name: "B" })
        .returning();
      if (!batch) throw new Error("batch");
      const [s] = await tx
        .insert(gangSheets)
        .values({ companyId: shop, batchId: batch.id, name: "private sheet", status: "ready" })
        .returning();
      if (!s) throw new Error("sheet");
      await tx.insert(transfers).values({
        companyId: shop,
        gangSheetId: s.id,
        orderItemId: itemId,
        widthIn: 4,
        heightIn: 4,
      });
      return s;
    });
    return { shop, sheet };
  }

  it("a vendor that grants itself access to another shop's sheet sees nothing", async () => {
    const { sheet } = await shopWithSheet();
    const vendor = (await createCompany({ name: "Sneaky vendor", type: "vendor" })).id;
    // The vendor scope sets app.company_id = the vendor, so the tenant policy lets it write
    // vendor_access rows for itself; the vendor policies must ignore them.
    await withVendor(vendor, (tx) =>
      tx
        .insert(vendorAccess)
        .values({ companyId: vendor, vendorCompanyId: vendor, gangSheetId: sheet.id }),
    );
    expect(await withVendor(vendor, (tx) => tx.select().from(gangSheets))).toHaveLength(0);
    expect(await withVendor(vendor, (tx) => tx.select().from(transfers))).toHaveLength(0);
    const updated = await withVendor(vendor, (tx) =>
      tx
        .update(gangSheets)
        .set({ status: "printed" })
        .where(eq(gangSheets.id, sheet.id))
        .returning(),
    );
    expect(updated).toHaveLength(0);
  });

  it("a shop cannot share another shop's sheet with a vendor", async () => {
    const { sheet } = await shopWithSheet();
    const attacker = (await createCompany({ name: "Other shop" })).id;
    const vendor = (await createCompany({ name: "Vendor", type: "vendor" })).id;
    await withTenant(attacker, (tx) =>
      tx
        .insert(vendorAccess)
        .values({ companyId: attacker, vendorCompanyId: vendor, gangSheetId: sheet.id }),
    );
    expect(await withVendor(vendor, (tx) => tx.select().from(gangSheets))).toHaveLength(0);
  });

  it("a vendor can advance a shared sheet but never move it to another company", async () => {
    const { shop, sheet } = await shopWithSheet();
    const vendor = (await createCompany({ name: "Vendor", type: "vendor" })).id;
    const other = (await createCompany({ name: "Other vendor", type: "vendor" })).id;
    await withTenant(shop, (tx) =>
      tx
        .insert(vendorAccess)
        .values({ companyId: shop, vendorCompanyId: vendor, gangSheetId: sheet.id }),
    );
    expect(await withVendor(vendor, (tx) => tx.select().from(gangSheets))).toHaveLength(1);
    expect(await withVendor(vendor, (tx) => tx.select().from(transfers))).toHaveLength(1);
    expect(await withVendor(other, (tx) => tx.select().from(gangSheets))).toHaveLength(0);
    await expect(
      withVendor(vendor, (tx) =>
        tx.update(gangSheets).set({ companyId: vendor }).where(eq(gangSheets.id, sheet.id)),
      ),
    ).rejects.toSatisfy((err: unknown) =>
      /row-level security|cannot change/.test(String((err as { cause?: unknown }).cause ?? err)),
    );
    // Revoking access hides the sheet again.
    await withTenant(shop, (tx) =>
      tx
        .update(vendorAccess)
        .set({ revokedAt: new Date() })
        .where(eq(vendorAccess.gangSheetId, sheet.id)),
    );
    expect(await withVendor(vendor, (tx) => tx.select().from(gangSheets))).toHaveLength(0);
    const [row] = await withSystem((tx) =>
      tx.select().from(gangSheets).where(eq(gangSheets.id, sheet.id)),
    );
    expect(row?.companyId).toBe(shop);
  });
});
