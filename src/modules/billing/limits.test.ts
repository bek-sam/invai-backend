import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem, withTenant } from "../../db/client";
import { auditLog, companies, subscriptions, usage } from "../../db/schema";
import { runJobInline } from "../../lib/queues";
import { createCompany, createUser, tenantContext } from "../../test/fixtures";
import { connect } from "../channels/service";
import { inviteUser } from "../tenancy/service";
import { expireTrialsJob, purgeBillingWebhookEvents, recordSheetBuiltJob } from "./jobs";
import * as svc from "./service";

/*
 * Plan limits (users on invite, connections on connect), the trial-expiry job and its
 * PAYMENT_REQUIRED gate on imports, and the sheetsBuilt meter. Trial: 3 users, 2 connections.
 */

const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

async function trialShop(trialEndsAt = new Date(Date.now() + 7 * 86_400_000)) {
  const companyId = (await createCompany()).id;
  const owner = await createUser(companyId, "owner");
  await withSystem((tx) =>
    tx
      .insert(subscriptions)
      .values({ companyId, planKey: "trial", status: "trialing", trialEndsAt }),
  );
  return { companyId, ctx: tenantContext(companyId, owner.id, "owner") };
}

const invite = (c: Awaited<ReturnType<typeof trialShop>>, email: string) =>
  withTenant(c.companyId, (tx) => inviteUser(tx, c.ctx, { email, name: "Rosa", role: "office" }));

const connectCsv = (c: Awaited<ReturnType<typeof trialShop>>, name: string) =>
  withTenant(c.companyId, (tx) =>
    connect(tx, c.ctx, { channel: "etsy", mode: "csv", name } as never),
  );

describe("plan limits", () => {
  it("maxUsers: pending invites hold seats; the next invite gets PLAN_LIMIT_REACHED (users)", async () => {
    const c = await trialShop();
    const first = `a-${uniq()}@test.local`;
    await invite(c, first);
    await invite(c, `b-${uniq()}@test.local`);
    // Owner + 2 pending = 3 seats (the trial's limit).
    await expect(invite(c, `c-${uniq()}@test.local`)).rejects.toMatchObject({
      code: "PLAN_LIMIT_REACHED",
      data: { meter: "users", used: 3, limit: 3 },
    });
    // Re-sending an invite to someone already invited doesn't take another seat.
    await expect(invite(c, first)).resolves.toMatchObject({ email: first });
  });

  it("maxConnections: the third connection gets PLAN_LIMIT_REACHED (connections)", async () => {
    const c = await trialShop();
    await connectCsv(c, "One");
    await connectCsv(c, "Two");
    await expect(connectCsv(c, "Three")).rejects.toMatchObject({
      code: "PLAN_LIMIT_REACHED",
      data: { meter: "connections", used: 2, limit: 2 },
    });
  });

  it("vendor organizations have no plan limits", async () => {
    const vendorId = (await createCompany({ type: "vendor" })).id;
    for (const meter of ["users", "connections", "orders"] as const) {
      await expect(
        withTenant(vendorId, (tx) => svc.assertWithinPlan(tx, { companyId: vendorId }, meter, 99)),
      ).resolves.toMatchObject({ overLimit: false, limit: null });
    }
  });

  it("a bigger plan lifts the limit", async () => {
    const c = await trialShop();
    await withSystem((tx) =>
      tx.update(companies).set({ plan: "growth" }).where(eq(companies.id, c.companyId)),
    );
    for (const n of ["One", "Two", "Three"]) await connectCsv(c, n);
  });
});

describe("trial expiry", () => {
  it("a trial past its end is trial_expired at once, and imports get PAYMENT_REQUIRED", async () => {
    const c = await trialShop(new Date(Date.now() - 60_000));
    const status = await withTenant(c.companyId, (tx) => svc.getStatus(tx, c.ctx));
    expect(status.status).toBe("trial_expired");
    await expect(
      withTenant(c.companyId, (tx) => svc.assertWithinPlan(tx, c.ctx, "orders", 1)),
    ).rejects.toMatchObject({ code: "PAYMENT_REQUIRED", data: { checkoutUrl: null } });
    await expect(
      withTenant(c.companyId, (tx) => svc.assertPaidActionAllowed(tx, c.ctx)),
    ).rejects.toMatchObject({ code: "PAYMENT_REQUIRED" });
    // Reading still works.
    await expect(withTenant(c.companyId, (tx) => svc.listPlans(tx))).resolves.toBeTruthy();
  });

  it("the nightly job writes trial_expired only for expired trials with no subscription", async () => {
    const expired = await trialShop(new Date(Date.now() - 60_000));
    const running = await trialShop(new Date(Date.now() + 86_400_000));
    const paying = await trialShop(new Date(Date.now() - 60_000));
    await withSystem((tx) =>
      tx
        .update(subscriptions)
        .set({ stripeSubscriptionId: `sub_${uniq()}` })
        .where(eq(subscriptions.companyId, paying.companyId)),
    );
    const first = (await runJobInline(expireTrialsJob, {})) as { expired: number };
    expect(first.expired).toBeGreaterThanOrEqual(1);
    const statusOf = async (id: string) =>
      (
        await withSystem((tx) =>
          tx.select().from(subscriptions).where(eq(subscriptions.companyId, id)),
        )
      )[0]?.status;
    expect(await statusOf(expired.companyId)).toBe("trial_expired");
    expect(await statusOf(running.companyId)).toBe("trialing");
    expect(await statusOf(paying.companyId)).toBe("trialing");
    // Run twice: nothing more happens to the same company.
    await runJobInline(expireTrialsJob, {});
    const audits = await withSystem((tx) =>
      tx
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.companyId, expired.companyId),
            eq(auditLog.action, "billing.trial_expired"),
          ),
        ),
    );
    expect(audits).toHaveLength(1);
  });

  it("an active trial is not gated", async () => {
    const c = await trialShop();
    await expect(
      withTenant(c.companyId, (tx) => svc.assertPaidActionAllowed(tx, c.ctx)),
    ).resolves.toBeUndefined();
  });
});

describe("usage meters and housekeeping", () => {
  let c: Awaited<ReturnType<typeof trialShop>>;
  beforeAll(async () => {
    c = await trialShop();
  });

  it("records sheetsBuilt per built sheet", async () => {
    const sheetId = crypto.randomUUID();
    await runJobInline(recordSheetBuiltJob, { companyId: c.companyId, sheetId });
    await runJobInline(recordSheetBuiltJob, {
      companyId: c.companyId,
      sheetId: crypto.randomUUID(),
    });
    const [row] = await withSystem((tx) =>
      tx
        .select()
        .from(usage)
        .where(and(eq(usage.companyId, c.companyId), eq(usage.period, svc.periodOf().key))),
    );
    expect(row?.sheetsBuilt).toBe(2);
  });

  it("purges webhook event records past retention", async () => {
    await expect(purgeBillingWebhookEvents(new Date())).resolves.toHaveProperty("deleted");
  });
});
