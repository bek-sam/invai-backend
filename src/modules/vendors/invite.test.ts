import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { withSystem, withTenant } from "../../db/client";
import { vendorConnections } from "../../db/schema";
import { createCompany, createUser, tenantContext } from "../../test/fixtures";
import { inviteVendor, updateConnection, vendorInbox, vendorShops } from "./service";

describe("vendor invitations need the vendor's acceptance", () => {
  it("a known vendor org stays invited until it opens its shop list", async () => {
    const shopId = (await createCompany()).id;
    const shop = tenantContext(shopId, (await createUser(shopId, "owner")).id, "owner");
    const vendorOrg = (await createCompany({ type: "vendor" })).id;
    const email = `vendor-${Date.now()}@test.local`;
    const vendorUser = await createUser(vendorOrg, "vendor", { email });
    const vendor = tenantContext(vendorOrg, vendorUser.id, "vendor", "vendor");

    const conn = await withTenant(shopId, (tx) =>
      inviteVendor(tx, shop, {
        name: "Known DTF",
        email,
        spec: {},
        isDefault: false,
        turnaroundDays: 2,
      }),
    );
    expect(conn.status).toBe("invited");
    const status = async () =>
      (
        await withSystem((tx) =>
          tx
            .select({ status: vendorConnections.status, delivery: vendorConnections.delivery })
            .from(vendorConnections)
            .where(eq(vendorConnections.id, conn.id)),
        )
      )[0];
    // The shop cannot flip it to active itself, and the inbox alone does not accept.
    await expect(
      withTenant(shopId, (tx) => updateConnection(tx, shop, { id: conn.id, status: "active" })),
    ).rejects.toBeTruthy();
    await vendorInbox(vendor, { limit: 10 });
    expect((await status())?.status).toBe("invited");

    const shops = await vendorShops(vendor);
    expect(shops.items.map((s) => s.orgId)).toContain(shopId);
    expect(await status()).toEqual({ status: "active", delivery: "portal" });
  });
});
