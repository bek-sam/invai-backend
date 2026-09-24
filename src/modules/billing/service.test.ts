import { BillingStatus } from "@invai/contracts";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem, withTenant } from "../../db/client";
import { subscriptions, usage } from "../../db/schema";
import { createCompany, createUser, tenantContext } from "../../test/fixtures";
import * as svc from "./service";

describe("billing", () => {
  let companyId: string;
  let ctx: ReturnType<typeof tenantContext>;

  beforeAll(async () => {
    companyId = (await createCompany()).id;
    const owner = await createUser(companyId, "owner");
    ctx = tenantContext(companyId, owner.id, "owner");
  });

  it("lists the v1 plans", async () => {
    const { items } = await withTenant(companyId, (tx) => svc.listPlans(tx));
    const byKey = Object.fromEntries(items.map((p) => [p.key, p]));
    expect(byKey.starter).toMatchObject({ ordersPerMonth: 3000, priceMonthly: 14900 });
    expect(byKey.growth).toMatchObject({ ordersPerMonth: 10000, priceMonthly: 34900 });
    expect(byKey.pro).toMatchObject({ ordersPerMonth: 30000, priceMonthly: 69900 });
    expect(byKey.scale?.ordersPerMonth).toBeNull();
  });

  it("reports usage and changes plan without Stripe", async () => {
    const status = await withTenant(companyId, (tx) => svc.getStatus(tx, ctx));
    expect(() => BillingStatus.parse(status)).not.toThrow();
    expect(status.plan.key).toBe("trial");
    const res = await withTenant(companyId, (tx) => svc.changePlan(tx, ctx, "starter"));
    expect(res.checkoutUrl).toBeNull();
    expect(res.status.plan.key).toBe("starter");
    expect(res.status.status).toBe("active");
  });

  it("enforces plan limits", async () => {
    await withSystem((tx) =>
      tx.insert(usage).values({ companyId, period: svc.periodOf().key, ordersImported: 2999 }),
    );
    const ok = await withTenant(companyId, (tx) => svc.assertWithinPlan(tx, ctx, "orders", 1));
    expect(ok).toMatchObject({ used: 2999, limit: 3000, overLimit: false });
    // Default behavior is warn: imports continue.
    const warn = await withTenant(companyId, (tx) => svc.assertWithinPlan(tx, ctx, "orders", 5));
    expect(warn.overLimit).toBe(true);
    await withSystem((tx) =>
      tx
        .update(subscriptions)
        .set({ overLimitBehavior: "block_imports" })
        .where(eq(subscriptions.companyId, companyId)),
    );
    await expect(
      withTenant(companyId, (tx) => svc.assertWithinPlan(tx, ctx, "orders", 5)),
    ).rejects.toMatchObject({ code: "PLAN_LIMIT_REACHED" });
  });
});
