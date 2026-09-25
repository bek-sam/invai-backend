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
