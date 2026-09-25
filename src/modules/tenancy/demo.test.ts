import { and, count, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { anonymousContext, type Context, type TenantContext } from "../../api/context";
import { auth } from "../../auth";
import { withSystem, withTenant } from "../../db/client";
import {
  channelConnections,
  companies,
  members,
  orderItems,
  orders,
  subscriptions,
} from "../../db/schema";
import { env } from "../../env";
import {
  createCompany,
  createConnection,
  createOrder,
  createUser,
  tenantContext,
} from "../../test/fixtures";
import { assertPaidActionAllowed, assertWithinPlan, expireTrials } from "../billing/service";
import { connect } from "../channels/service";
import { onOrganizationCreated } from "../today/org-hooks";
import { DEMO_VOLUME, findDemoCompany, leaveDemo, resetDemo, startDemo } from "./demo";
import { sendInviteEmail } from "./invites";

/*
 * tenancy.demo: one sample-data company per user, filled by the seed builder under withTenant,
 * isolated from the user's real company by the ordinary company_id RLS, and left out of
 * billing, email and real marketplace calls.
 */

type RequestContext = Context & { tenant: TenantContext };

function requestContext(companyId: string, userId: string, orgType: "shop" | "vendor" = "shop") {
  const tenant = tenantContext(
    companyId,
    userId,
    orgType === "vendor" ? "vendor" : "owner",
    orgType,
  );
  return {
    ...anonymousContext(new Headers(), null),
    sessionKind: "user",
    user: tenant.user,
    emailVerified: true,
    companyId,
    orgType,
    role: tenant.role,
    permissions: tenant.permissions,
    memberships: [],
    authSessionId: "test-session",
    tenant,
  } satisfies RequestContext;
}

const ORDERS_IN_DEMO = DEMO_VOLUME.historicalOrders + DEMO_VOLUME.dueSoonOrders;

async function countRows(companyId: string, table: typeof orders | typeof orderItems) {
  const [row] = await withTenant(companyId, (tx) => tx.select({ n: count() }).from(table));
  return row?.n ?? 0;
}

describe("demo workspace", () => {
  let realId: string;
  let userId: string;
  let realOrderId: string;
  let demoId: string;
  const setActive = vi.spyOn(auth.api, "setActiveOrganization");

  beforeAll(async () => {
    setActive.mockResolvedValue(null as never);
    const real = await createCompany({ name: "Real Shop" });
    realId = real.id;
    userId = (await createUser(realId, "owner")).id;
    const conn = await createConnection(realId);
    realOrderId = (await createOrder(realId, conn.id, { units: 1, state: "ready" })).order.id;
  }, 120_000);

  afterAll(() => setActive.mockRestore());

  it("start creates the user's demo company, fills it and switches into it", async () => {
    const me = await startDemo(requestContext(realId, userId));
    demoId = me.org.id;
    expect(demoId).not.toBe(realId);
    expect(me.org.demo).toBe(true);
    expect(me.role).toBe("owner");
    expect(me.orgs.map((o) => o.id).sort()).toEqual([realId, demoId].sort());
    expect(setActive).toHaveBeenLastCalledWith(
      expect.objectContaining({ body: { organizationId: demoId } }),
    );
    const demo = await findDemoCompany(userId);
    expect(demo?.id).toBe(demoId);
    expect(demo?.demoOwnerUserId).toBe(userId);
    expect(await countRows(demoId, orders)).toBe(ORDERS_IN_DEMO);
    expect(await countRows(demoId, orderItems)).toBeGreaterThan(ORDERS_IN_DEMO);
    // The checklist on the demo reflects its sample data.
    expect(me.onboarding).toMatchObject({
      channelConnected: true,
      blanksImported: true,
      skusMapped: true,
      vendorAdded: true,
      shipFromAddress: true,
      designsUploaded: true,
      planChosen: true,
    });
  }, 120_000);

  it("keeps the demo's rows out of the real company (RLS, no withSystem leaks)", async () => {
    expect(await countRows(realId, orders)).toBe(1);
    const demoOrderIds = await withTenant(demoId, (tx) =>
      tx.select({ id: orders.id }).from(orders).limit(5),
    );
    const leaked = await withTenant(realId, (tx) =>
      tx
        .select({ id: orders.id })
        .from(orders)
        .where(
          sql`${orders.id} in (${sql.join(
            demoOrderIds.map((o) => sql`${o.id}`),
            sql`, `,
          )})`,
        ),
    );
    expect(leaked).toEqual([]);
    const fromDemo = await withTenant(demoId, (tx) =>
      tx.select().from(orders).where(eq(orders.id, realOrderId)),
    );
    expect(fromDemo).toEqual([]);
    // Every row the builder wrote carries the demo's company id (checked with the owner role).
    const stray = await withSystem((tx) =>
      tx.execute<{ n: number }>(sql`
        select count(*)::int as n from order_item_transitions t
        join order_items i on i.id = t.order_item_id
        where i.company_id = ${demoId} and t.company_id <> ${demoId}`),
    );
    expect(stray.rows[0]?.n).toBe(0);
  });

  it("start again reuses the same demo without refilling it", async () => {
    const before = await withTenant(demoId, (tx) =>
      tx.select({ id: orders.id }).from(orders).orderBy(orders.id).limit(3),
    );
    const me = await startDemo(requestContext(realId, userId));
    expect(me.org.id).toBe(demoId);
    const after = await withTenant(demoId, (tx) =>
      tx.select({ id: orders.id }).from(orders).orderBy(orders.id).limit(3),
    );
    expect(after).toEqual(before);
  }, 120_000);

  it("is excluded from billing: no trial, no plan limits, never expired", async () => {
    const subs = await withTenant(demoId, (tx) => tx.select().from(subscriptions));
    expect(subs).toEqual([]);
    const within = await withTenant(demoId, (tx) =>
      assertWithinPlan(tx, { companyId: demoId }, "users", 10_000),
    );
    expect(within).toEqual({ used: 0, limit: null, overLimit: false });
    // Even an expired trial row (the org hook used to write one) is ignored and never expired.
    await withSystem((tx) =>
      tx.insert(subscriptions).values({
        companyId: demoId,
        planKey: "trial",
        status: "trialing",
        trialEndsAt: new Date(Date.now() - 86_400_000),
      }),
    );
    await withTenant(demoId, (tx) => assertPaidActionAllowed(tx, { companyId: demoId }));
    await expireTrials();
    const [sub] = await withTenant(demoId, (tx) => tx.select().from(subscriptions));
    expect(sub?.status).toBe("trialing");
    await withSystem((tx) => tx.delete(subscriptions).where(eq(subscriptions.companyId, demoId)));
  });

  it("the org hook gives a sample workspace no trial subscription", async () => {
    const other = await createCompany();
    const owner = await createUser(other.id, "owner");
    await withSystem((tx) =>
      tx
        .update(companies)
        .set({ demo: true, demoOwnerUserId: owner.id })
        .where(eq(companies.id, other.id)),
    );
    await onOrganizationCreated({ id: other.id, type: "shop" });
    const subs = await withTenant(other.id, (tx) => tx.select().from(subscriptions));
    expect(subs).toEqual([]);
  });

  it("connects Shopify with the mock provider even when real keys are configured", async () => {
    const mocks = env.mocks as { shopify: boolean };
    const was = mocks.shopify;
    mocks.shopify = false;
    try {
      const ctx = tenantContext(demoId, userId, "owner");
      const res = await withTenant(demoId, (tx) =>
        connect(tx, ctx, { channel: "shopify", shopDomain: "someones-store.myshopify.com" }),
      );
      expect(res.kind).toBe("oauth");
      const [row] = await withTenant(demoId, (tx) =>
        tx
          .select({ provider: channelConnections.provider })
          .from(channelConnections)
          .where(eq(channelConnections.id, (res as { connectionId: string }).connectionId)),
      );
      expect(row?.provider).toBe("mock");
      // The same call for a real company picks the live provider.
      const realCtx = tenantContext(realId, userId, "owner");
      const real = await withTenant(realId, (tx) =>
        connect(tx, realCtx, { channel: "shopify", shopDomain: "real-store.myshopify.com" }),
      );
      const [realRow] = await withTenant(realId, (tx) =>
        tx
          .select({ provider: channelConnections.provider })
          .from(channelConnections)
          .where(eq(channelConnections.id, (real as { connectionId: string }).connectionId)),
      );
      expect(realRow?.provider).toBe("live");
    } finally {
      mocks.shopify = was;
    }
  });

  it("never sends invite email from a demo company", async () => {
    // A 1 ms mail timeout would fail any real send; the demo returns before sending.
    await expect(
      sendInviteEmail(
        "someone@example.com",
        {
          companyId: demoId,
          locale: "en",
          kind: "staff",
          companyName: "Sample shop",
          inviterName: null,
          role: "office",
          link: "http://localhost/accept-invite/x",
          expiresAt: new Date(),
        },
        1,
      ),
    ).resolves.toBeUndefined();
  });

  it("leave goes back to the real company and keeps the demo", async () => {
    const me = await leaveDemo(requestContext(demoId, userId));
    expect(me.org.id).toBe(realId);
    expect(me.org.demo).toBe(false);
    expect((await findDemoCompany(userId))?.id).toBe(demoId);
  });

  it("reset replaces the demo with a freshly filled one and retires the old one", async () => {
    const me = await resetDemo(requestContext(demoId, userId));
    expect(me.org.demo).toBe(true);
    expect(me.org.id).not.toBe(demoId);
    expect(me.orgs.map((o) => o.id)).not.toContain(demoId);
    expect((await findDemoCompany(userId))?.id).toBe(me.org.id);
    // The old one is unlinked and has no members left: nobody can open it again.
    const [old] = await withSystem((tx) =>
      tx.select().from(companies).where(eq(companies.id, demoId)),
    );
    expect(old?.demoOwnerUserId).toBeNull();
    expect(old?.demo).toBe(true);
    const [oldMembers] = await withSystem((tx) =>
      tx.select({ n: count() }).from(members).where(eq(members.organizationId, demoId)),
    );
    expect(oldMembers?.n).toBe(0);
    expect(await countRows(me.org.id, orders)).toBe(ORDERS_IN_DEMO);
    expect(await countRows(realId, orders)).toBe(1);
    demoId = me.org.id;
  }, 120_000);

  it("is one demo per user: another user gets their own", async () => {
    const other = await createUser(realId, "office");
    const me = await startDemo(requestContext(realId, other.id));
    expect(me.org.id).not.toBe(demoId);
    const [membership] = await withSystem((tx) =>
      tx
        .select()
        .from(members)
        .where(and(eq(members.organizationId, demoId), eq(members.userId, other.id))),
    );
    expect(membership).toBeUndefined();
  }, 120_000);

  it("refuses a vendor org and a user with no real company to go back to", async () => {
    const vendor = await createCompany({ type: "vendor" });
    const vendorUser = await createUser(vendor.id, "vendor");
    await expect(startDemo(requestContext(vendor.id, vendorUser.id, "vendor"))).rejects.toThrow(
      /for shops/,
    );
    const loner = await createUser(demoId, "office");
    await withSystem((tx) =>
      tx
        .delete(members)
        .where(and(eq(members.userId, loner.id), eq(members.organizationId, demoId))),
    );
    await expect(leaveDemo(requestContext(demoId, loner.id))).rejects.toThrow(/no other company/);
  });
});
