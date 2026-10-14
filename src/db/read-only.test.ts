import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { createCompany, createLocation } from "../test/fixtures";
import { db, withSystem, withTenant, withTenantReadOnly } from "./client";
import { locations } from "./schema";

/** Drizzle wraps driver errors; the Postgres code is on `cause` (or the error itself). */
const pgCode = (err: unknown) =>
  (err as { cause?: { code?: string }; code?: string }).cause?.code ??
  (err as { code?: string }).code;

const failure = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected the statement to fail");
};

describe("withTenantReadOnly", () => {
  let a: string;
  let b: string;
  let locA: string;

  beforeAll(async () => {
    a = (await createCompany({ name: "RO A" })).id;
    b = (await createCompany({ name: "RO B" })).id;
    locA = (await createLocation(a, "A main")).id;
    await createLocation(b, "B main");
  });

  const countA = () => withTenant(a, async (tx) => (await tx.select().from(locations)).length);

  it("runs as invai_app in a read-only transaction scoped to the company", async () => {
    const row = await withTenantReadOnly(a, async (tx) => {
      const r = await tx.execute<{ u: string; ro: string; c: string }>(
        sql`select current_user as u, current_setting('transaction_read_only') as ro, current_setting('app.company_id') as c`,
      );
      return r.rows[0];
    });
    expect(row).toEqual({ u: "invai_app", ro: "on", c: a });
  });

  it("refuses insert, update and delete with 25006 and changes nothing", async () => {
    const before = await countA();
    const ins = await failure(
      withTenantReadOnly(a, (tx) =>
        tx.insert(locations).values({ companyId: a, name: "Nope", isDefault: false }),
      ),
    );
    expect(pgCode(ins)).toBe("25006");
    const upd = await failure(
      withTenantReadOnly(a, (tx) =>
        tx.update(locations).set({ name: "Changed" }).where(eq(locations.id, locA)),
      ),
    );
    expect(pgCode(upd)).toBe("25006");
    const del = await failure(
      withTenantReadOnly(a, (tx) => tx.delete(locations).where(eq(locations.id, locA))),
    );
    expect(pgCode(del)).toBe("25006");
    expect(await countA()).toBe(before);
    const [row] = await withTenant(a, (tx) =>
      tx.select().from(locations).where(eq(locations.id, locA)),
    );
    expect(row?.name).toBe("A main");
  });

  it("refuses SET TRANSACTION READ WRITE after the first query with 25001", async () => {
    const err = await failure(
      withTenantReadOnly(a, async (tx) => {
        await tx.select().from(locations);
        await tx.execute(sql`set transaction read write`);
      }),
    );
    expect(pgCode(err)).toBe("25001");
  });

  it("sees only its own company's rows; no company set sees none", async () => {
    const own = await withTenantReadOnly(a, (tx) => tx.select().from(locations));
    expect(own.length).toBeGreaterThan(0);
    expect(own.every((r) => r.companyId === a)).toBe(true);
    const bRows = await withTenantReadOnly(b, (tx) => tx.select().from(locations));
    expect(bRows.every((r) => r.companyId === b)).toBe(true);
    // Same pool, no company set: RLS hides every row. Owner pool proves the rows exist.
    const none = await db.select().from(locations);
    expect(none).toHaveLength(0);
    const all = await withSystem((tx) => tx.select().from(locations));
    expect(all.length).toBeGreaterThanOrEqual(2);
  });
});
