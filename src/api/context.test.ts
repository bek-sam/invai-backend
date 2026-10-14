import { beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "../db/client";
import {
  createFloorSessionToken,
  issueStationToken,
  pinLogin,
  revokeStationTokens,
  setPin,
} from "../modules/tenancy/floor-auth";
import { updateStation } from "../modules/tenancy/service";
import {
  createCompany,
  createLocation,
  createStation,
  createUser,
  tenantContext,
} from "../test/fixtures";
import { buildContext } from "./context";

/*
 * B-487 (T-57-2): a floor session is refused at once, in every process, when its own station is
 * deactivated or its token revoked, and a session cannot name a station other than its token's.
 * These go through `buildContext` with real signed `fs1.` tokens on the harness DB.
 */

const ctxFor = (token: string) =>
  buildContext(
    new Request("http://localhost/rpc", { headers: { authorization: `Bearer ${token}` } }),
  );

describe("floor session station check (B-487)", () => {
  let companyId: string;
  let ownerId: string;
  let locationId: string;
  let stationA: string;
  let stationB: string;
  let tokenA: string;
  let tokenAId: string;
  let tokenBId: string;
  let presserId: string;

  const setActive = (id: string, active: boolean) =>
    withTenant(companyId, (tx) =>
      updateStation(tx, tenantContext(companyId, ownerId, "owner"), { id, active }),
    );

  beforeAll(async () => {
    companyId = (await createCompany()).id;
    ownerId = (await createUser(companyId, "owner")).id;
    presserId = (await createUser(companyId, "presser")).id;
    locationId = (await createLocation(companyId)).id;
    stationA = (await createStation(companyId, locationId, "Press A")).id;
    stationB = (await createStation(companyId, locationId, "Press B")).id;
    await withTenant(companyId, async (tx) => {
      await setPin(tx, { companyId, userId: presserId, pin: "4321", actorUserId: ownerId });
      const a = await issueStationToken(tx, { companyId, stationId: stationA, userId: ownerId });
      const b = await issueStationToken(tx, { companyId, stationId: stationB, userId: ownerId });
      tokenA = a.token;
      tokenAId = a.tokenId;
      tokenBId = b.tokenId;
    });
  });

  it("allows while active, refuses at once after deactivation (warm cache), allows after reactivation", async () => {
    const { token } = await pinLogin({ stationToken: tokenA, pin: "4321", ip: null });
    // Warm the 30 s liveness cache with one allowed call.
    const warm = await ctxFor(token);
    expect(warm.sessionKind).toBe("floor");
    expect(warm.station?.id).toBe(stationA);

    await setActive(stationA, false);
    expect((await ctxFor(token)).sessionKind).toBeNull();

    await setActive(stationA, true);
    expect((await ctxFor(token)).station?.id).toBe(stationA);
  });

  it("refuses a token for station A carrying the sid of a deactivated station B", async () => {
    await setActive(stationB, false);
    const forged = createFloorSessionToken({
      userId: presserId,
      companyId,
      stationId: stationB,
      stationTokenId: tokenAId,
      role: "presser",
    }).token;
    expect((await ctxFor(forged)).sessionKind).toBeNull();
    await setActive(stationB, true);
    // Active B still cannot be paired with A's token: the token must belong to the named station.
    expect((await ctxFor(forged)).sessionKind).toBeNull();
    const honest = createFloorSessionToken({
      userId: presserId,
      companyId,
      stationId: stationB,
      stationTokenId: tokenBId,
      role: "presser",
    }).token;
    expect((await ctxFor(honest)).station?.id).toBe(stationB);
  });

  it("refuses a session whose station token was revoked", async () => {
    const station = (await createStation(companyId, locationId, "Press C")).id;
    const issued = await withTenant(companyId, (tx) =>
      issueStationToken(tx, { companyId, stationId: station, userId: ownerId }),
    );
    const token = createFloorSessionToken({
      userId: presserId,
      companyId,
      stationId: station,
      stationTokenId: issued.tokenId,
      role: "presser",
    }).token;
    expect((await ctxFor(token)).station?.id).toBe(station);
    await withTenant(companyId, (tx) => revokeStationTokens(tx, { companyId, stationId: station }));
    expect((await ctxFor(token)).sessionKind).toBeNull();
  });
});
