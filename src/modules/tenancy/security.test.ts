import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { buildContext } from "../../api/context";
import { db, withTenant } from "../../db/client";
import { members } from "../../db/schema";
import { clearFailures } from "../../lib/ratelimit";
import {
  createCompany,
  createLocation,
  createStation,
  createUser,
  tenantContext,
} from "../../test/fixtures";
import {
  issueStationToken,
  PIN_MAX_FAILURES,
  pinLogin,
  resolveStationToken,
  revokeFloorSession,
  setPin,
} from "./floor-auth";
import * as svc from "./service";

const floorCtx = (token: string) =>
  buildContext(
    new Request("http://localhost/rpc", { headers: { authorization: `Bearer ${token}` } }),
  );

describe("team role changes", () => {
  let companyId: string;
  let ownerId: string;
  let adminId: string;
  let officeId: string;

  beforeAll(async () => {
    companyId = (await createCompany()).id;
    ownerId = (await createUser(companyId, "owner")).id;
    adminId = (await createUser(companyId, "admin")).id;
    officeId = (await createUser(companyId, "office")).id;
  });

  const as = (userId: string, role: "owner" | "admin") => tenantContext(companyId, userId, role);

  it("an admin cannot grant owner, touch an owner or invite an owner", async () => {
    await expect(
      withTenant(companyId, (tx) =>
        svc.changeRole(tx, as(adminId, "admin"), { userId: officeId, role: "owner" }),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      withTenant(companyId, (tx) =>
        svc.changeRole(tx, as(adminId, "admin"), { userId: ownerId, role: "office" }),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      withTenant(companyId, (tx) =>
        svc.setMemberStatus(tx, as(adminId, "admin"), ownerId, "deactivated"),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      withTenant(companyId, (tx) =>
        svc.inviteUser(tx, as(adminId, "admin"), {
          email: `boss-${Date.now()}@test.local`,
          name: "Boss",
          role: "owner",
        }),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      withTenant(companyId, (tx) =>
        svc.setUserPin(tx, as(adminId, "admin"), { userId: ownerId, pin: "4321" }),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("nobody changes their own role, and shop roles stay shop roles", async () => {
    await expect(
      withTenant(companyId, (tx) =>
        svc.changeRole(tx, as(adminId, "admin"), { userId: adminId, role: "owner" }),
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      withTenant(companyId, (tx) =>
        svc.changeRole(tx, as(ownerId, "owner"), { userId: officeId, role: "vendor" }),
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("the last active owner cannot be demoted or deactivated", async () => {
    const second = (await createUser(companyId, "office")).id;
    const promoted = await withTenant(companyId, (tx) =>
      svc.changeRole(tx, as(ownerId, "owner"), { userId: second, role: "owner" }),
    );
    expect(promoted.role).toBe("owner");
    // Two owners: the second may demote the first.
    await withTenant(companyId, (tx) =>
      svc.changeRole(tx, as(second, "owner"), { userId: ownerId, role: "admin" }),
    );
    await expect(
      withTenant(companyId, (tx) =>
        svc.changeRole(tx, as(ownerId, "owner"), { userId: second, role: "admin" }),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      withTenant(companyId, (tx) =>
        svc.setMemberStatus(tx, as(ownerId, "owner"), second, "deactivated"),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("floor session hardening", () => {
  let companyId: string;
  let stationId: string;
  let presserId: string;
  let token: string;

  beforeAll(async () => {
    companyId = (await createCompany()).id;
    const owner = await createUser(companyId, "owner");
    const location = await createLocation(companyId);
    stationId = (await createStation(companyId, location.id)).id;
    presserId = (await createUser(companyId, "presser")).id;
    token = await withTenant(companyId, async (tx) => {
      await setPin(tx, { companyId, userId: presserId, pin: "2468", actorUserId: owner.id });
      return (await issueStationToken(tx, { companyId, stationId, userId: owner.id })).token;
    });
  });

  it("locks the station after repeated wrong PINs, even for the right PIN", async () => {
    const station = await resolveStationToken(token);
    if (!station) throw new Error("station");
    const key = `pin:${station.tokenId}`;
    await clearFailures(key);
    for (let i = 1; i < PIN_MAX_FAILURES; i++) {
      await expect(pinLogin({ stationToken: token, pin: "0000", ip: null })).rejects.toMatchObject({
        code: "INVALID_PIN",
      });
    }
    await expect(pinLogin({ stationToken: token, pin: "0000", ip: null })).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    await expect(pinLogin({ stationToken: token, pin: "2468", ip: null })).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    await clearFailures(key);
    const ok = await pinLogin({ stationToken: token, pin: "2468", ip: null });
    expect(ok.user.id).toBe(presserId);
  });

  it("logout revokes the floor session token", async () => {
    const session = await pinLogin({ stationToken: token, pin: "2468", ip: null });
    expect((await floorCtx(session.token)).sessionKind).toBe("floor");
    await revokeFloorSession(session.token);
    expect((await floorCtx(session.token)).sessionKind).toBeNull();
  });

  it("role changes and deactivation apply to live floor sessions", async () => {
    const session = await pinLogin({ stationToken: token, pin: "2468", ip: null });
    await db.update(members).set({ role: "packer" }).where(eq(members.userId, presserId));
    const ctx = await floorCtx(session.token);
    expect(ctx.role).toBe("packer");
    expect(ctx.permissions.has("shipping.buy")).toBe(true);
    await db.update(members).set({ status: "deactivated" }).where(eq(members.userId, presserId));
    expect((await floorCtx(session.token)).sessionKind).toBeNull();
    await db
      .update(members)
      .set({ status: "active", role: "presser" })
      .where(eq(members.userId, presserId));
  });

  it("revoking a station token ends its floor sessions immediately", async () => {
    const session = await pinLogin({ stationToken: token, pin: "2468", ip: null });
    expect((await floorCtx(session.token)).sessionKind).toBe("floor");
    const owner = tenantContext(companyId, null, "owner");
    await withTenant(companyId, (tx) => svc.revokeToken(tx, owner, stationId));
    // No cache wait: revocation drops the token from the live cache.
    expect((await floorCtx(session.token)).sessionKind).toBeNull();
    expect(await resolveStationToken(token)).toBeNull();
  });
});

/*
 * T-28-2 security review (ADR 0025). Both tests are `it.fails` acceptance markers: they pass
 * (as expected failures) while the gap is open, and turn red once fixed; then drop `.fails`.
 */
describe("T-28-2 account controls (security review)", () => {
  // S-57: the lock is checked before the endpoint and counted after the scrypt verify, so a burst
  // of parallel attempts all pass the check before any of them is counted. The number of
  // passwords one burst can test is bounded by concurrency (per-IP limit x IPs), not by 10.
  it("S-57: one burst of parallel sign-ins can test at most ACCOUNT_LOCK_THRESHOLD passwords", async () => {
    const { app } = await import("../../api/app");
    const { env } = await import("../../env");
    const email = `s57-${Date.now()}@nobody.test`;
    const attempt = async () => {
      const res = await app.request("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: env.WEB_ORIGIN },
        body: JSON.stringify({ email, password: "wrong password 9" }),
      });
      return res.status;
    };
    const statuses = await Promise.all(Array.from({ length: 40 }, attempt));
    // 401 = the password was actually checked; everything past the threshold must be 423.
    expect(statuses.filter((s) => s === 401).length).toBeLessThanOrEqual(
      env.ACCOUNT_LOCK_THRESHOLD,
    );
  });

  // S-58: the grace restart fires whenever a not-required user becomes required, including a
  // demote-then-promote (or deactivate-then-reactivate) of the same person, so two admins can
  // keep each other's two-step deadline in the future forever.
  it("S-58: demoting and re-promoting a past-deadline admin does not restart the grace", async () => {
    const { users } = await import("../../db/schema");
    const { loadMfaState, mfaBlocks } = await import("../../lib/mfa");
    const companyId = (await createCompany()).id;
    const ownerId = (await createUser(companyId, "owner")).id;
    const adminId = (await createUser(companyId, "admin")).id;
    await db
      .update(users)
      .set({ mfaGraceStartsAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000) })
      .where(eq(users.id, adminId));
    expect(mfaBlocks((await loadMfaState(adminId)) ?? undefined), "blocked before").toBe(true);
    const owner = tenantContext(companyId, ownerId, "owner");
    await withTenant(companyId, (tx) =>
      svc.changeRole(tx, owner, { userId: adminId, role: "office" }),
    );
    await withTenant(companyId, (tx) =>
      svc.changeRole(tx, owner, { userId: adminId, role: "admin" }),
    );
    expect(
      mfaBlocks((await loadMfaState(adminId)) ?? undefined),
      "still blocked after re-promotion",
    ).toBe(true);
  });
});
