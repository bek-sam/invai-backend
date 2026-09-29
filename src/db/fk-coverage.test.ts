import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createCompany, createConnection, createOrder } from "../test/fixtures";
import { db, withSystem } from "./client";
import { orderItems } from "./schema";

/*
 * Composite tenant foreign keys (T-22-2, B-30, S-26). Foreign-key checks ignore RLS, so a
 * single-column FK `(order_id) -> orders(id)` lets a row of shop B point at a row of shop A as
 * long as the id exists. Every FK between two tenant tables must therefore carry `company_id` on
 * both sides: `(company_id, order_id) -> orders(company_id, id)`. This test introspects
 * `pg_constraint` on the migrated test database so a new `.references(() => parent.id)` on a
 * tenant table fails CI. References to the global identity tables (`users`, `companies`) are
 * not tenant-to-tenant and are out of scope here (see `rls-coverage.test.ts` GLOBAL_TABLES).
 */

type Fk = {
  constraint: string;
  child: string;
  parent: string;
  childCols: string[];
  parentCols: string[];
};

/** Every FK whose child and parent both carry a `company_id` column. */
async function tenantFks(): Promise<Fk[]> {
  const res = await db.execute<{
    constraint: string;
    child: string;
    parent: string;
    child_cols: string[];
    parent_cols: string[];
  }>(sql`
    with tenant as (
      select c.oid from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
        and exists (select 1 from pg_attribute a where a.attrelid = c.oid
          and a.attname = 'company_id' and not a.attisdropped)
    )
    select con.conname as constraint, con.conrelid::regclass::text as child,
      con.confrelid::regclass::text as parent,
      (select array_agg(a.attname::text order by k.ord) from unnest(con.conkey) with ordinality k(attnum, ord)
        join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum) as child_cols,
      (select array_agg(a.attname::text order by k.ord) from unnest(con.confkey) with ordinality k(attnum, ord)
        join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.attnum) as parent_cols
    from pg_constraint con
    where con.contype = 'f'
      and con.conrelid in (select oid from tenant)
      and con.confrelid in (select oid from tenant)
    order by 2, 1`);
  return res.rows.map((r) => ({
    constraint: r.constraint,
    child: r.child,
    parent: r.parent,
    childCols: r.child_cols,
    parentCols: r.parent_cols,
  }));
}

describe("composite tenant foreign keys", () => {
  it("every FK between two tenant tables carries company_id on both sides", async () => {
    const fks = await tenantFks();
    expect(fks.length).toBeGreaterThan(40);
    const single = fks
      .filter((fk) => !fk.childCols.includes("company_id") || !fk.parentCols.includes("company_id"))
      .map(
        (fk) =>
          `${fk.child}(${fk.childCols.join(",")}) -> ${fk.parent}(${fk.parentCols.join(",")})`,
      );
    expect(single).toEqual([]);
  });

  it("every tenant FK's referenced key is (company_id, id), so the parent's tenant is bound", async () => {
    const fks = await tenantFks();
    const odd = fks
      .filter((fk) => fk.parentCols.join(",") !== "company_id,id")
      .map((fk) => `${fk.constraint}: ${fk.parent}(${fk.parentCols.join(",")})`);
    expect(odd).toEqual([]);
  });

  it("a row of shop B that points at shop A's order is refused even without RLS", async () => {
    const a = await createCompany();
    const b = await createCompany();
    const conn = await createConnection(a.id);
    const { order } = await createOrder(a.id, conn.id);
    // withSystem runs as the owner role (no RLS), the way a cross-tenant job or the seed would.
    // Only the composite FK stands between shop B and shop A's order here.
    await expect(
      withSystem((tx) =>
        tx.insert(orderItems).values({
          companyId: b.id,
          orderId: order.id,
          channelSku: "CROSS-1",
          shipBy: order.shipBy,
        }),
      ),
    ).rejects.toMatchObject({
      cause: { code: "23503", constraint: "order_items_order_id_fk" },
    });
  });
});
