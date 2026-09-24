import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { createCompany } from "../test/fixtures";
import { db, withSystem, withTenant, withVendor } from "./client";
import { designs, gangSheetBatches, gangSheets, vendorAccess } from "./schema";

/** Drizzle wraps driver errors ("Failed query: ..."); the Postgres message is in `cause`. */
const rlsViolation = (err: unknown) =>
  /row-level security/.test(String((err as { cause?: unknown }).cause ?? err));

/**
 * Row-level security is the tenant boundary. These tests run real queries as `invai_app`
 * against the test database and prove company A can neither read nor write company B's rows.
 */
describe("row-level security", () => {
  let a: string;
  let b: string;

  beforeAll(async () => {
    a = (await createCompany({ name: "Company A" })).id;
    b = (await createCompany({ name: "Company B" })).id;
    await withTenant(a, (tx) =>
      tx.insert(designs).values({ companyId: a, code: "A1", name: "A design" }),
    );
    await withTenant(b, (tx) =>
      tx.insert(designs).values({ companyId: b, code: "B1", name: "B design" }),
    );
  });

  it("a tenant sees only its own rows", async () => {
    const seenByA = await withTenant(a, (tx) => tx.select().from(designs));
    expect(seenByA.map((d) => d.companyId)).toEqual([a]);
    const seenByB = await withTenant(b, (tx) => tx.select().from(designs));
    expect(seenByB.map((d) => d.companyId)).toEqual([b]);
  });

  it("a tenant cannot read another company's row by id", async () => {
    const [bRow] = await withTenant(b, (tx) => tx.select().from(designs));
    if (!bRow) throw new Error("setup failed");
    const fromA = await withTenant(a, (tx) =>
      tx.select().from(designs).where(eq(designs.id, bRow.id)),
    );
    expect(fromA).toHaveLength(0);
    const updated = await withTenant(a, (tx) =>
      tx.update(designs).set({ name: "hacked" }).where(eq(designs.id, bRow.id)).returning(),
    );
    expect(updated).toHaveLength(0);
    const deleted = await withTenant(a, (tx) =>
      tx.delete(designs).where(eq(designs.id, bRow.id)).returning(),
    );
    expect(deleted).toHaveLength(0);
  });

  it("a tenant cannot insert rows for another company", async () => {
    await expect(
      withTenant(a, (tx) =>
        tx.insert(designs).values({ companyId: b, code: "X", name: "smuggled" }),
      ),
    ).rejects.toSatisfy(rlsViolation);
  });

  it("no tenant context means no rows at all", async () => {
    const rows = await db.select().from(designs);
    expect(rows).toHaveLength(0);
    await expect(
      db.insert(designs).values({ companyId: a, code: "N", name: "nope" }),
    ).rejects.toSatisfy(rlsViolation);
  });

  it("the owner connection sees everything (system scope only)", async () => {
    const rows = await withSystem((tx) => tx.select().from(designs));
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  it("vendors see only sheets explicitly shared through vendor_access", async () => {
    const vendor = (await createCompany({ name: "Vendor", type: "vendor" })).id;
    const { shared, hidden } = await withTenant(a, async (tx) => {
      const [batch] = await tx
        .insert(gangSheetBatches)
        .values({ companyId: a, name: "Batch" })
        .returning();
      if (!batch) throw new Error("batch");
      const [shared] = await tx
        .insert(gangSheets)
        .values({ companyId: a, batchId: batch.id, name: "shared sheet", status: "sent" })
        .returning();
      const [hidden] = await tx
        .insert(gangSheets)
        .values({ companyId: a, batchId: batch.id, name: "hidden sheet", status: "ready" })
        .returning();
      if (!shared || !hidden) throw new Error("sheets");
      await tx
        .insert(vendorAccess)
        .values({ companyId: a, vendorCompanyId: vendor, gangSheetId: shared.id });
      return { shared, hidden };
    });

    const seen = await withVendor(vendor, (tx) => tx.select().from(gangSheets));
    expect(seen.map((s) => s.id)).toEqual([shared.id]);

    // The vendor may advance a shared sheet but not touch a hidden one.
    const updated = await withVendor(vendor, (tx) =>
      tx
        .update(gangSheets)
        .set({ status: "printed" })
        .where(eq(gangSheets.id, shared.id))
        .returning(),
    );
    expect(updated).toHaveLength(1);
    const notUpdated = await withVendor(vendor, (tx) =>
      tx
        .update(gangSheets)
        .set({ status: "printed" })
        .where(eq(gangSheets.id, hidden.id))
        .returning(),
    );
    expect(notUpdated).toHaveLength(0);

    // Another vendor sees nothing.
    const other = (await createCompany({ name: "Other vendor", type: "vendor" })).id;
    expect(await withVendor(other, (tx) => tx.select().from(gangSheets))).toHaveLength(0);
  });
});
