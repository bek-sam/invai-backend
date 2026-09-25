import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { app } from "../../api/app";
import { db, withSystem, withTenant } from "../../db/client";
import { accounts, companies, users } from "../../db/schema";
import { env } from "../../env";
import { isPlaceholderEmail, sendMail } from "../../integrations/vendors/mailer";
import {
  createCompany,
  createLocation,
  createStation,
  createUser,
  tenantContext,
} from "../../test/fixtures";
import { issueStationToken, pinLogin } from "./floor-auth";
import * as svc from "./service";

describe("PIN-only floor staff", () => {
  let companyId: string;
  let owner: ReturnType<typeof tenantContext>;

  beforeAll(async () => {
    companyId = (await createCompany({ name: "Pin Test" })).id;
    owner = tenantContext(companyId, (await createUser(companyId, "owner")).id, "owner");
    await withSystem((tx) =>
      tx.update(companies).set({ plan: "scale" }).where(eq(companies.id, companyId)),
    );
  });

  const add = (name: string, role: "packer" | "presser" | "receiver" | "office" = "packer") =>
    svc.inviteTeammate(owner, { name, role: role as "packer", pinOnly: true });

  it("adds an active member with a placeholder email, no password and no accounts row", async () => {
    const user = await add("Paco Packer");
    expect(user).toMatchObject({
      name: "Paco Packer",
      role: "packer",
      status: "active",
      pinOnly: true,
      hasPin: false,
    });
    expect(isPlaceholderEmail(user.email)).toBe(true);
    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(row).toMatchObject({ pinOnly: true, emailVerified: false });
    expect(await db.select().from(accounts).where(eq(accounts.userId, user.id))).toHaveLength(0);
    const list = await withTenant(companyId, (tx) =>
      svc.listTeam(tx, owner, { limit: 50, includeDeactivated: false }),
    );
    expect(list.items.find((u) => u.id === user.id)).toMatchObject({ pinOnly: true });
    expect(list.items.find((u) => u.id === owner.userId)).toMatchObject({ pinOnly: false });
  });

  it("signs in on the floor with a PIN and never on the web", async () => {
    const user = await add("Rita Receiver", "receiver");
    const location = await createLocation(companyId);
    const station = await createStation(companyId, location.id);
    const token = await withTenant(companyId, async (tx) => {
      await svc.setUserPin(tx, owner, { userId: user.id, pin: "4821" });
      return (
        await issueStationToken(tx, { companyId, stationId: station.id, userId: owner.userId })
      ).token;
    });
    const session = await pinLogin({ stationToken: token, pin: "4821", ip: null });
    expect(session.user).toMatchObject({ id: user.id, role: "receiver" });

    const res = await app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: env.WEB_ORIGIN },
      body: JSON.stringify({ email: user.email, password: "anything at all 1" }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.headers.getSetCookie().some((c) => c.includes("session_token="))).toBe(false);
  });

  it("only floor roles, and they keep one", async () => {
    await expect(add("Olga Office", "office")).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const user = await add("Pia Presser", "presser");
    await expect(
      withTenant(companyId, (tx) => svc.changeRole(tx, owner, { userId: user.id, role: "office" })),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const moved = await withTenant(companyId, (tx) =>
      svc.changeRole(tx, owner, { userId: user.id, role: "packer" }),
    );
    expect(moved).toMatchObject({ role: "packer", pinOnly: true });
  });

  it("the placeholder is never mailed or invited", async () => {
    const user = await add("Nemo Nomail");
    expect(await sendMail({ to: user.email, subject: "x", text: "x" }, { companyId })).toEqual({
      messageId: "skipped:pin-only",
    });
    await expect(
      svc.inviteTeammate(owner, { email: user.email, name: "Nemo", role: "office" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("the last owner can't be demoted or deactivated", async () => {
    const coId = (await createCompany()).id;
    const sole = tenantContext(coId, (await createUser(coId, "owner")).id, "owner");
    const admin = tenantContext(coId, (await createUser(coId, "admin")).id, "admin");
    const soleId = sole.userId as string;
    type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];
    const tries: [(tx: Tx) => Promise<unknown>, string][] = [
      [(tx) => svc.changeRole(tx, sole, { userId: soleId, role: "admin" }), "BAD_REQUEST"],
      [(tx) => svc.setMemberStatus(tx, sole, soleId, "deactivated"), "BAD_REQUEST"],
      [(tx) => svc.changeRole(tx, admin, { userId: soleId, role: "admin" }), "FORBIDDEN"],
      [(tx) => svc.setMemberStatus(tx, admin, soleId, "deactivated"), "FORBIDDEN"],
    ];
    for (const [attempt, code] of tries)
      await expect(withTenant(coId, attempt)).rejects.toMatchObject({ code });
  });
});
