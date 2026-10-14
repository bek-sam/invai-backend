import { CONTRACT_VERSION } from "@invai/contracts";
import { call } from "@orpc/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { redis } from "../lib/queues";
import {
  checkRateLimit,
  checkScanRateLimit,
  RATE_BUCKET_LIMITS,
  rateLimitKey,
  SCAN_STATION_LIMITS,
  scanStationKey,
} from "../lib/ratelimit";
import { createCompany, createLocation, createStation, createUser } from "../test/fixtures";
import { anonymousContext, type Context, permissionsFor } from "./context";
import { router } from "./router";

/*
 * T-56-1 (B-479, ADR 0040): floor scans have their own limiter buckets. Routing tests go through
 * `call()` with a real floor Context and assert the Valkey key state (not the handler's outcome);
 * volume tests drive `checkScanRateLimit` on simulated time (Date only, no sleeps).
 */

type AnyProcedure = Parameters<typeof call>[0];
function procedureAt(path: string): AnyProcedure {
  let node: unknown = router;
  for (const key of path.split(".")) node = (node as Record<string, unknown>)[key];
  return node as AnyProcedure;
}

const SCAN = ["production", "scan"] as const;

async function setup(stationCount = 2) {
  const company = await createCompany();
  const user = await createUser(company.id, "presser");
  const owner = await createUser(company.id, "owner");
  const location = await createLocation(company.id);
  const stations = [];
  for (let i = 0; i < stationCount; i++) {
    stations.push(await createStation(company.id, location.id, `Press ${i + 1}`));
  }
  const floorCtx = (stationId: string): Context => ({
    ...anonymousContext(new Headers({ "x-contract-version": CONTRACT_VERSION }), null),
    sessionKind: "floor",
    user: { id: user.id, name: "p", email: "p@test.local" },
    emailVerified: true,
    companyId: company.id,
    orgType: "shop",
    role: "presser",
    permissions: permissionsFor("presser"),
    station: { id: stationId, name: "Press", kind: "press", tokenId: crypto.randomUUID() },
    resHeaders: new Headers(),
  });
  const userCtx: Context = {
    ...anonymousContext(new Headers(), null),
    sessionKind: "user",
    user: { id: owner.id, name: "o", email: "o@test.local" },
    emailVerified: true,
    companyId: company.id,
    orgType: "shop",
    role: "owner",
    permissions: permissionsFor("owner"),
    resHeaders: new Headers(),
  };
  return { companyId: company.id, stations, floorCtx, userCtx };
}

function scanInput(stationId?: string) {
  return {
    clientScanId: crypto.randomUUID(),
    station: "press",
    stationId,
    transferCode: "NOPE-0000",
    blankCode: null,
    scannedAt: new Date().toISOString(),
  };
}

/** Run a scan through the whole middleware chain; the handler's own outcome does not matter. */
async function scan(ctx: Context, stationId?: string) {
  return call(procedureAt("production.scan"), scanInput(stationId), {
    context: ctx,
    path: SCAN,
  }).then(
    () => null,
    (err: { code?: string }) => err.code ?? "ERROR",
  );
}

const tokens = async (key: string) => {
  const v = await redis.hget(key, "tokens");
  return v === null ? null : Number(v);
};
const exists = async (key: string) => (await redis.exists(key)) === 1;

afterEach(() => vi.useRealTimers());

function freeze(at = Date.now()) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at);
}

describe("scan routing through the oRPC middleware", () => {
  it("a floor scan at station A (input stationId = B) moves only the A and company scans keys", async () => {
    const { companyId, stations, floorCtx } = await setup();
    const [a, b] = stations;
    if (!a || !b) throw new Error("fixture");
    freeze();
    await scan(floorCtx(a.id), b.id);
    expect(await exists(scanStationKey(companyId, a.id))).toBe(true);
    expect(await exists(rateLimitKey("scans", companyId))).toBe(true);
    expect(await exists(scanStationKey(companyId, b.id))).toBe(false);
    expect(await exists(rateLimitKey("writes", companyId))).toBe(false);
    expect(await exists(rateLimitKey("reads", companyId))).toBe(false);
    expect(await tokens(scanStationKey(companyId, a.id))).toBe(SCAN_STATION_LIMITS.capacity - 1);
    expect(await tokens(rateLimitKey("scans", companyId))).toBe(
      RATE_BUCKET_LIMITS.scans.capacity - 1,
    );
  });

  it("a web user session scanning stays on writes and never touches the scans keys", async () => {
    const { companyId, stations, userCtx } = await setup();
    const a = stations[0];
    if (!a) throw new Error("fixture");
    freeze();
    await scan(userCtx, a.id);
    expect(await tokens(rateLimitKey("writes", companyId))).toBe(
      RATE_BUCKET_LIMITS.writes.capacity - 1,
    );
    expect(await exists(rateLimitKey("scans", companyId))).toBe(false);
    expect(await exists(scanStationKey(companyId, a.id))).toBe(false);
  });

  it("a station past its 60 burst gets RATE_LIMITED with Retry-After 1 and spends no company token", async () => {
    const { companyId, stations, floorCtx } = await setup();
    const a = stations[0];
    if (!a) throw new Error("fixture");
    freeze();
    const ctx = floorCtx(a.id);
    for (let i = 0; i < SCAN_STATION_LIMITS.capacity; i++) {
      expect(await scan(ctx)).not.toBe("RATE_LIMITED");
    }
    expect(await scan(ctx)).toBe("RATE_LIMITED");
    expect(ctx.resHeaders?.get("Retry-After")).toBe("1");
    expect(await tokens(rateLimitKey("scans", companyId))).toBe(
      RATE_BUCKET_LIMITS.scans.capacity - SCAN_STATION_LIMITS.capacity,
    );
  });

  it("once the company scans cap is spent another station is refused, and keeps its station token spent", async () => {
    const { companyId, stations, floorCtx } = await setup(1);
    const x = stations[0];
    if (!x) throw new Error("fixture");
    freeze();
    const fillers = Array.from({ length: 10 }, () => crypto.randomUUID());
    for (const s of fillers) {
      for (let i = 0; i < SCAN_STATION_LIMITS.capacity; i++) {
        expect((await checkScanRateLimit(companyId, s)).allowed).toBe(true);
      }
    }
    expect(await tokens(rateLimitKey("scans", companyId))).toBe(0);
    const ctx = floorCtx(x.id);
    expect(await scan(ctx)).toBe("RATE_LIMITED");
    expect(Number(ctx.resHeaders?.get("Retry-After"))).toBeGreaterThanOrEqual(1);
    // Documented: a company refusal does not refund the station token.
    expect(await tokens(scanStationKey(companyId, x.id))).toBe(SCAN_STATION_LIMITS.capacity - 1);
  });
});

describe("separation between scans and writes", () => {
  it("with the scans buckets drained, shipping.batchBuy and another writes call still take writes tokens", async () => {
    const { companyId, userCtx } = await setup(0);
    freeze();
    for (let s = 0; s < 10; s++) {
      const id = crypto.randomUUID();
      for (let i = 0; i < SCAN_STATION_LIMITS.capacity; i++)
        await checkScanRateLimit(companyId, id);
    }
    expect((await checkScanRateLimit(companyId, crypto.randomUUID())).allowed).toBe(false);
    for (const path of ["shipping.batchBuy", "orders.hold"]) {
      const err = await call(
        procedureAt(path),
        {},
        { context: userCtx, path: path.split(".") },
      ).then(
        () => null,
        (e: { code?: string }) => e.code,
      );
      expect(err, path).not.toBe("RATE_LIMITED");
    }
    expect(await tokens(rateLimitKey("writes", companyId))).toBe(
      RATE_BUCKET_LIMITS.writes.capacity - 2,
    );
  });

  it("with writes drained, a floor scan is still admitted", async () => {
    const { companyId, stations, floorCtx } = await setup();
    const a = stations[0];
    if (!a) throw new Error("fixture");
    freeze();
    for (let i = 0; i < RATE_BUCKET_LIMITS.writes.capacity; i++)
      await checkRateLimit("writes", companyId);
    expect((await checkRateLimit("writes", companyId)).allowed).toBe(false);
    expect(await scan(floorCtx(a.id))).not.toBe("RATE_LIMITED");
    expect(await tokens(scanStationKey(companyId, a.id))).toBe(SCAN_STATION_LIMITS.capacity - 1);
  });
});

describe("limits sized from the measured rate (simulated time)", () => {
  it("pins both limit objects exactly", () => {
    expect(RATE_BUCKET_LIMITS.scans).toEqual({ capacity: 600, refillPerSec: 15 });
    expect(SCAN_STATION_LIMITS).toEqual({ capacity: 60, refillPerSec: 1 });
    // The other buckets are unchanged.
    expect(RATE_BUCKET_LIMITS.writes).toEqual({ capacity: 120, refillPerSec: 2 });
    expect(RATE_BUCKET_LIMITS.reads).toEqual({ capacity: 300, refillPerSec: 5 });
    expect(RATE_BUCKET_LIMITS.auth).toEqual({ capacity: 20, refillPerSec: 20 / 60 });
    expect(RATE_BUCKET_LIMITS.ai).toEqual({ capacity: 20, refillPerSec: 20 / 60 });
    expect(RATE_BUCKET_LIMITS.links).toEqual({ capacity: 60, refillPerSec: 1 });
  });

  it("20 stations x 20 scans/min for 10 minutes: 0 refusals", async () => {
    const companyId = crypto.randomUUID();
    const ids = Array.from({ length: 20 }, () => crypto.randomUUID());
    const base = Date.now();
    let refused = 0;
    let total = 0;
    for (let sec = 0; sec < 600; sec += 3) {
      for (let k = 0; k < ids.length; k++) {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(base + sec * 1000 + k * 100);
        const r = await checkScanRateLimit(companyId, ids[k] as string);
        total++;
        if (!r.allowed) refused++;
      }
    }
    expect(total).toBe(4000);
    expect(refused).toBe(0);
  });

  it("3 flooding stations (5/s) are refused while 3 normal ones (20/min) and the company are not", async () => {
    const companyId = crypto.randomUUID();
    const flooders = Array.from({ length: 3 }, () => crypto.randomUUID());
    const normals = Array.from({ length: 3 }, () => crypto.randomUUID());
    const base = Date.now();
    const refusedFlood = [0, 0, 0];
    const admittedFlood = [0, 0, 0];
    let refusedNormal = 0;
    for (let tick = 0; tick < 900; tick++) {
      // 0.2 s per tick, 3 minutes
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(base + tick * 200);
      for (let f = 0; f < 3; f++) {
        const r = await checkScanRateLimit(companyId, flooders[f] as string);
        if (r.allowed) admittedFlood[f] = (admittedFlood[f] ?? 0) + 1;
        else refusedFlood[f] = (refusedFlood[f] ?? 0) + 1;
      }
      if (tick % 15 === 0) {
        for (const n of normals) {
          if (!(await checkScanRateLimit(companyId, n)).allowed) refusedNormal++;
        }
      }
    }
    for (let f = 0; f < 3; f++) {
      expect(refusedFlood[f]).toBeGreaterThan(400);
      // burst 60 + 1 token/s for 180 s
      expect(admittedFlood[f]).toBeLessThanOrEqual(60 + 180 + 1);
    }
    expect(refusedNormal).toBe(0);
  });

  it("one station's offline outbox of 60 is admitted at once, the 61st waits 1 s", async () => {
    const companyId = crypto.randomUUID();
    const s = crypto.randomUUID();
    freeze();
    for (let i = 0; i < 60; i++)
      expect((await checkScanRateLimit(companyId, s)).allowed).toBe(true);
    expect(await checkScanRateLimit(companyId, s)).toEqual({ allowed: false, retryAfterSec: 1 });
  });

  it("15 stations replaying 60 each at t=0 hit the 600 company cap: 300 refusals", async () => {
    const companyId = crypto.randomUUID();
    freeze();
    let refused = 0;
    for (let s = 0; s < 15; s++) {
      const id = crypto.randomUUID();
      for (let i = 0; i < 60; i++)
        if (!(await checkScanRateLimit(companyId, id)).allowed) refused++;
    }
    expect(refused).toBe(300);
  });
});
