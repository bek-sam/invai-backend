import { beforeAll, describe, expect, it } from "vitest";
import { buildContext } from "../../api/context";
import { withTenant } from "../../db/client";
import {
  createCompany,
  createLocation,
  createStation,
  createUser,
  tenantContext,
} from "../../test/fixtures";
import {
  issueStationToken,
  pinLogin,
  resolveStationToken,
  revokeStationTokens,
  setPin,
} from "./floor-auth";
import { floorStaff } from "./service";

describe("floor login", () => {
  let companyId: string;
  let stationId: string;
  let presserId: string;
  let token: string;

  beforeAll(async () => {
    companyId = (await createCompany()).id;
    const owner = await createUser(companyId, "owner");
    const location = await createLocation(companyId);
    stationId = (await createStation(companyId, location.id)).id;
    presserId = (await createUser(companyId, "presser", { name: "Pat Presser" })).id;
    const ctx = tenantContext(companyId, owner.id, "owner");
    token = await withTenant(companyId, async (tx) => {
      await setPin(tx, { companyId, userId: presserId, pin: "1234", actorUserId: ctx.userId });
      return (await issueStationToken(tx, { companyId, stationId, userId: owner.id })).token;
    });
  });

  it("resolves a station token and lists PIN staff", async () => {
    const station = await resolveStationToken(token);
    expect(station?.station.id).toBe(stationId);
    expect(await resolveStationToken("st1.garbage")).toBeNull();
    const staff = await withTenant(companyId, (tx) => floorStaff(tx, companyId));
    expect(staff.items.map((s) => s.name)).toEqual(["Pat Presser"]);
  });

  it("station token + PIN gives a floor session that builds a context", async () => {
    const session = await pinLogin({ stationToken: token, pin: "1234", ip: null });
    expect(session.user.role).toBe("presser");
    const ctx = await buildContext(
      new Request("http://localhost/rpc", {
        headers: { authorization: `Bearer ${session.token}` },
      }),
    );
    expect(ctx.sessionKind).toBe("floor");
    expect(ctx.companyId).toBe(companyId);
    expect(ctx.station?.id).toBe(stationId);
    expect(ctx.permissions.has("production.scan")).toBe(true);
    expect(ctx.permissions.has("catalog.manage")).toBe(false);
  });

  it("rejects wrong PINs, duplicate PINs and revoked tokens", async () => {
    await expect(pinLogin({ stationToken: token, pin: "9999", ip: null })).rejects.toMatchObject({
      code: "INVALID_PIN",
    });
    const other = await createUser(companyId, "packer");
    await expect(
      withTenant(companyId, (tx) =>
        setPin(tx, { companyId, userId: other.id, pin: "1234", actorUserId: null }),
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const session = await pinLogin({ stationToken: token, pin: "1234", ip: null });
    await withTenant(companyId, (tx) => revokeStationTokens(tx, { companyId, stationId }));
    const { forgetStationToken } = await import("./floor-auth");
    const resolved = await resolveStationToken(token);
    expect(resolved).toBeNull();
    // The floor session dies with its station token.
    const parsed = (await import("./floor-auth")).verifyFloorSessionToken(session.token);
    if (parsed) forgetStationToken(parsed.stationTokenId);
    const ctx = await buildContext(
      new Request("http://localhost/rpc", {
        headers: { authorization: `Bearer ${session.token}` },
      }),
    );
    expect(ctx.sessionKind).toBeNull();
  });
});
