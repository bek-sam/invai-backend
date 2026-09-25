import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem, withTenant } from "../../db/client";
import { companies, locations, subscriptions } from "../../db/schema";
import {
  createCompany,
  createLocation,
  createStation,
  createUser,
  tenantContext,
} from "../../test/fixtures";
import { ensureCostSettings, updateCostSettings } from "../finance/service";
import { getSettings } from "../shipping/service";
import { issueStationToken } from "./floor-auth";
import { onboardingChecklist, setChecklistDismissed } from "./onboarding";

describe("onboarding checklist", () => {
  let companyId: string;
  let ctx: ReturnType<typeof tenantContext>;
  const checklist = () => withTenant(companyId, (tx) => onboardingChecklist(tx, companyId));

  beforeAll(async () => {
    companyId = (await createCompany()).id;
    const owner = await createUser(companyId, "owner");
    ctx = tenantContext(companyId, owner.id, "owner");
  });

  it("starts with every step open and not dismissed", async () => {
    expect(await checklist()).toEqual({
      channelConnected: false,
      blanksImported: false,
      skusMapped: false,
      vendorAdded: false,
      staffInvited: false,
      shipFromAddress: false,
      carrier: false,
      tabletPaired: false,
      designsUploaded: false,
      costsSet: false,
      planChosen: false,
      dismissed: false,
      dismissedAt: null,
    });
  });

  it("ticks the new steps from the shop's own data", async () => {
    // Shipping settings (created on first open) hold the default carriers; no from address yet.
    await withTenant(companyId, (tx) => getSettings(tx, ctx));
    let c = await checklist();
    expect(c.carrier).toBe(true);
    expect(c.shipFromAddress).toBe(false);

    const loc = await createLocation(companyId);
    await withSystem((tx) =>
      tx
        .update(locations)
        .set({
          address: {
            name: "Shop",
            company: null,
            street1: "1 Main St",
            street2: null,
            phone: null,
            email: null,
            city: "Phoenix",
            state: "AZ",
            zip: "85001",
            country: "US",
          },
        })
        .where(eq(locations.id, loc.id)),
    );
    const station = await createStation(companyId, loc.id);
    c = await checklist();
    expect(c.shipFromAddress).toBe(true);
    expect(c.tabletPaired).toBe(false);
    await withTenant(companyId, (tx) =>
      issueStationToken(tx, { companyId, stationId: station.id, userId: ctx.userId }),
    );
    expect((await checklist()).tabletPaired).toBe(true);

    // Default cost settings (made by a profit run) don't count; a save by the shop does.
    await withTenant(companyId, (tx) => ensureCostSettings(tx, companyId));
    expect((await checklist()).costsSet).toBe(false);
    await withTenant(companyId, (tx) => updateCostSettings(tx, ctx, { packagingPerOrder: 60 }));
    expect((await checklist()).costsSet).toBe(true);
  });

  it("counts a paid plan as chosen, not a trial", async () => {
    await withSystem((tx) =>
      tx.insert(subscriptions).values({ companyId, planKey: "trial", status: "trialing" }),
    );
    expect((await checklist()).planChosen).toBe(false);
    await withSystem((tx) =>
      tx
        .update(subscriptions)
        .set({ planKey: "starter", status: "active" })
        .where(eq(subscriptions.companyId, companyId)),
    );
    expect((await checklist()).planChosen).toBe(true);
  });

  it("dismisses and brings back the checklist, keeping other settings", async () => {
    await withSystem((tx) =>
      tx
        .update(companies)
        .set({ settings: { itemsPerHour: 20 } })
        .where(eq(companies.id, companyId)),
    );
    const hidden = await withTenant(companyId, (tx) => setChecklistDismissed(tx, companyId, true));
    expect(hidden.dismissed).toBe(true);
    expect(hidden.dismissedAt).toEqual(expect.any(String));
    const shown = await withTenant(companyId, (tx) => setChecklistDismissed(tx, companyId, false));
    expect(shown).toMatchObject({ dismissed: false, dismissedAt: null });
    const [row] = await withSystem((tx) =>
      tx
        .select({ settings: companies.settings })
        .from(companies)
        .where(eq(companies.id, companyId)),
    );
    expect(row?.settings).toEqual({ itemsPerHour: 20 });
  });

  it("is per company", async () => {
    const other = (await createCompany()).id;
    await withTenant(companyId, (tx) => setChecklistDismissed(tx, companyId, true));
    const theirs = await withTenant(other, (tx) => onboardingChecklist(tx, other));
    expect(theirs.dismissed).toBe(false);
    expect(theirs.carrier).toBe(false);
    expect(theirs.costsSet).toBe(false);
  });
});
