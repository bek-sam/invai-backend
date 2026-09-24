import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { app } from "../../api/app";
import { db, withSystem, withTenant } from "../../db/client";
import { companies, invitations, members, users, vendorConnections } from "../../db/schema";
import { env } from "../../env";
import { createCompany, createUser, tenantContext } from "../../test/fixtures";

type Sent = { to: string; subject: string; text: string; html?: string };
const mail = vi.hoisted(() => ({ sent: [] as Sent[], fail: false }));
vi.mock("../../integrations/vendors/mailer", async (orig) => ({
  ...(await orig<typeof import("../../integrations/vendors/mailer")>()),
  sendMail: vi.fn(async (m: Sent) => {
    if (mail.fail) throw new Error("smtp down");
    mail.sent.push(m);
    return { messageId: `<${mail.sent.length}@test>` };
  }),
}));

const { inviteVendor, updateConnection, vendorInbox, vendorShops } = await import("./service");

const post = (path: string, body: unknown, cookie?: string) =>
  app.request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: env.WEB_ORIGIN,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });

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

  it("a new vendor gets an /accept-invite link, signs up, and sees the shop in the portal", async () => {
    const shopId = (await createCompany({ name: "Bloom Shop" })).id;
    const shop = tenantContext(shopId, (await createUser(shopId, "owner")).id, "owner");
    const email = `newvendor-${Date.now()}@test.local`;
    const conn = await withTenant(shopId, (tx) =>
      inviteVendor(tx, shop, {
        name: "Fresh DTF",
        email,
        spec: {},
        isDefault: false,
        turnaroundDays: 2,
      }),
    );
    expect(conn.status).toBe("invited");
    const m = mail.sent.at(-1);
    expect(m?.to).toBe(email);
    expect(m?.text).not.toContain("/vendor/accept");
    const id = m?.text.match(/\/accept-invite\/([0-9a-f-]{36})/)?.[1];
    expect(id).toBeTruthy();
    const [inv] = await db
      .select()
      .from(invitations)
      .where(eq(invitations.id, id as string));
    expect(inv).toMatchObject({ email, role: "vendor", status: "pending" });
    const preview = await app.request(`/api/auth/invite-preview?id=${id}`);
    expect(await preview.json()).toMatchObject({
      status: "pending",
      organizationType: "vendor",
      invitedBy: "Bloom Shop",
    });

    const signUp = await post("/api/auth/sign-up/email", {
      email,
      password: "correct horse 1",
      name: "Fresh Vendor",
    });
    expect(signUp.status).toBe(200);
    const cookie = signUp.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    expect(
      (await post("/api/auth/organization/accept-invitation", { invitationId: id }, cookie)).status,
    ).toBe(200);
    const [member] = await db
      .select({ orgId: members.organizationId, role: members.role, status: members.status })
      .from(members)
      .innerJoin(users, eq(users.id, members.userId))
      .where(eq(users.email, email));
    expect(member).toMatchObject({ role: "vendor", status: "active" });
    const [org] = await db
      .select()
      .from(companies)
      .where(eq(companies.id, member?.orgId as string));
    expect(org?.type).toBe("vendor");

    const [vendorUser] = await db.select().from(users).where(eq(users.email, email));
    const vendor = tenantContext(org?.id as string, vendorUser?.id as string, "vendor", "vendor");
    const shops = await vendorShops(vendor);
    expect(shops.items.map((s) => s.orgId)).toContain(shopId);
  });

  it("a failed invite email fails the vendor invite and leaves nothing behind", async () => {
    const shopId = (await createCompany()).id;
    const shop = tenantContext(shopId, (await createUser(shopId, "owner")).id, "owner");
    const email = `nomail-vendor-${Date.now()}@test.local`;
    mail.fail = true;
    try {
      await expect(
        withTenant(shopId, (tx) =>
          inviteVendor(tx, shop, {
            name: "Ghost DTF",
            email,
            spec: {},
            isDefault: false,
            turnaroundDays: 2,
          }),
        ),
      ).rejects.toMatchObject({ code: "UPSTREAM_FAILED" });
    } finally {
      mail.fail = false;
    }
    expect(await db.select().from(invitations).where(eq(invitations.email, email))).toHaveLength(0);
    const conns = await withSystem((tx) =>
      tx
        .select()
        .from(vendorConnections)
        .where(and(eq(vendorConnections.companyId, shopId), eq(vendorConnections.email, email))),
    );
    expect(conns).toHaveLength(0);
  });
});
