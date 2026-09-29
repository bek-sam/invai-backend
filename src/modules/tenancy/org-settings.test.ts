import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { withSystem, withTenant } from "../../db/client";
import { companies } from "../../db/schema";
import { createCompany, createUser, tenantContext } from "../../test/fixtures";
import { updateOrg } from "./service";

/* me.updateOrg: `printsInHouse` lives in the settings jsonb and never clobbers other keys. */
describe("org settings: printsInHouse", () => {
  it("defaults to false, is written by updateOrg and keeps the other settings", async () => {
    const company = await createCompany();
    const owner = await createUser(company.id, "owner");
    await withSystem((tx) =>
      tx
        .update(companies)
        .set({ settings: { riskWindowHours: 12 } })
        .where(eq(companies.id, company.id)),
    );
    const ctx = tenantContext(company.id, owner.id, "owner");

    const renamed = await withTenant(company.id, (tx) => updateOrg(tx, ctx, { name: "Renamed" }));
    expect(renamed.printsInHouse).toBe(false);

    const on = await withTenant(company.id, (tx) => updateOrg(tx, ctx, { printsInHouse: true }));
    expect(on.printsInHouse).toBe(true);
    expect(on.name).toBe("Renamed");
    const [row] = await withSystem((tx) =>
      tx.select().from(companies).where(eq(companies.id, company.id)),
    );
    expect(row?.settings).toMatchObject({ riskWindowHours: 12, printsInHouse: true });

    const off = await withTenant(company.id, (tx) => updateOrg(tx, ctx, { printsInHouse: false }));
    expect(off.printsInHouse).toBe(false);
  });
});

/* Contracts 0.8.0 (T-22-2): shipsSaturday and transferAgeWarnDays are stored and returned. */
describe("org settings: shipsSaturday and transferAgeWarnDays", () => {
  it("are absent until set, round-trip through updateOrg and keep the other settings", async () => {
    const company = await createCompany();
    const owner = await createUser(company.id, "owner");
    const ctx = tenantContext(company.id, owner.id, "owner");

    const before = await withTenant(company.id, (tx) => updateOrg(tx, ctx, { name: "Fresh" }));
    expect(before.shipsSaturday).toBeUndefined();
    expect(before.transferAgeWarnDays).toBeUndefined();

    const sat = await withTenant(company.id, (tx) =>
      updateOrg(tx, ctx, { shipsSaturday: true, printsInHouse: true }),
    );
    expect(sat.shipsSaturday).toBe(true);
    expect(sat.transferAgeWarnDays).toBeUndefined();

    const days = await withTenant(company.id, (tx) =>
      updateOrg(tx, ctx, { transferAgeWarnDays: 45 }),
    );
    expect(days).toMatchObject({
      shipsSaturday: true,
      transferAgeWarnDays: 45,
      printsInHouse: true,
    });
    const [row] = await withSystem((tx) =>
      tx.select().from(companies).where(eq(companies.id, company.id)),
    );
    expect(row?.settings).toMatchObject({
      printsInHouse: true,
      shipsSaturday: true,
      transferAgeWarnDays: 45,
    });

    const off = await withTenant(company.id, (tx) => updateOrg(tx, ctx, { shipsSaturday: false }));
    expect(off.shipsSaturday).toBe(false);
    expect(off.transferAgeWarnDays).toBe(45);
  });
});
