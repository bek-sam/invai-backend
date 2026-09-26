import { CONTRACT_VERSION, FLOOR_COMPAT_BASELINE } from "@invai/contracts";
import { call } from "@orpc/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { env } from "../env";
import { createCompany, createUser } from "../test/fixtures";
import { app } from "./app";
import { anonymousContext, type Context, permissionsFor } from "./context";
import { enforceFloorContractVersion } from "./orpc";
import { router } from "./router";

/*
 * Floor API version handshake (T-13-1, B-82, ADR 0012): floor/station calls below
 * MIN_FLOOR_CONTRACT_VERSION (or with no X-Contract-Version) get CLIENT_TOO_OLD (426).
 */

type AnyProcedure = Parameters<typeof call>[0];
function procedureAt(path: string): AnyProcedure {
  let node: unknown = router;
  for (const key of path.split(".")) node = (node as Record<string, unknown>)[key];
  return node as AnyProcedure;
}
async function errorOf(path: string, context: Context, input: unknown = {}) {
  try {
    await call(procedureAt(path), input as never, { context, path: path.split(".") });
    return { code: "OK", data: null as unknown };
  } catch (err) {
    const e = err as { code?: string; data?: unknown };
    return { code: e.code ?? String(err), data: e.data };
  }
}
const withVersion = (v: string | null) =>
  new Headers(v === null ? {} : { "x-contract-version": v });

describe("enforceFloorContractVersion", () => {
  const floor = (v: string | null) => ({ headers: withVersion(v), sessionKind: "floor" as const });

  it("refuses an old or missing version on floor and station procedures", () => {
    for (const mode of ["floor", "station"] as const) {
      expect(() => enforceFloorContractVersion(mode, floor("0.2.0"), "0.3.0")).toThrow(
        expect.objectContaining({
          code: "CLIENT_TOO_OLD",
          status: 426,
          data: { minVersion: "0.3.0", current: "0.2.0" },
        }),
      );
      expect(() => enforceFloorContractVersion(mode, floor(null), "0.3.0")).toThrow(
        expect.objectContaining({ data: { minVersion: "0.3.0", current: null } }),
      );
    }
  });

  it("lets a current or newer version through, and ignores user and web-only procedures", () => {
    expect(() => enforceFloorContractVersion("floor", floor("0.3.0"), "0.3.0")).not.toThrow();
    expect(() => enforceFloorContractVersion("station", floor("0.10.0"), "0.3.0")).not.toThrow();
    expect(() => enforceFloorContractVersion("user", floor(null), "0.3.0")).not.toThrow();
    // A web user session calling an `auth: "floor"` procedure isn't a tablet.
    expect(() =>
      enforceFloorContractVersion(
        "floor",
        { headers: withVersion(null), sessionKind: "user" },
        "0.3.0",
      ),
    ).not.toThrow();
  });
});

describe("default minimum (FLOOR_COMPAT_BASELINE)", () => {
  it("defaults to the floor baseline, not CONTRACT_VERSION", () => {
    if (!process.env.MIN_FLOOR_CONTRACT_VERSION) {
      expect(env.MIN_FLOOR_CONTRACT_VERSION).toBe(FLOOR_COMPAT_BASELINE);
    }
  });

  it("a contracts version bump alone doesn't refuse current tablets", async () => {
    // Simulate a later backend build on contracts 9.9.0 with no floor-facing break: the
    // baseline doesn't move, so a tablet still on today's version keeps working.
    vi.resetModules();
    vi.doMock("@invai/contracts", async (orig) => ({
      ...(await orig<typeof import("@invai/contracts")>()),
      CONTRACT_VERSION: "9.9.0",
    }));
    try {
      const bumped = await import("../env");
      const { enforceFloorContractVersion: enforce } = await import("./orpc");
      if (!process.env.MIN_FLOOR_CONTRACT_VERSION) {
        expect(bumped.env.MIN_FLOOR_CONTRACT_VERSION).toBe(FLOOR_COMPAT_BASELINE);
      }
      const tablet = {
        headers: new Headers({ "x-contract-version": CONTRACT_VERSION }),
        sessionKind: "floor" as const,
      };
      expect(() => enforce("floor", tablet)).not.toThrow();
      expect(() => enforce("station", tablet)).not.toThrow();
    } finally {
      vi.doUnmock("@invai/contracts");
      vi.resetModules();
    }
  });
});

describe("guard: floor contract version", () => {
  let companyId: string;
  let userId: string;
  const floorSession = (v: string | null): Context => ({
    ...anonymousContext(withVersion(v), null),
    sessionKind: "floor",
    user: { id: userId, name: "p", email: "p@test.local" },
    emailVerified: true,
    companyId,
    orgType: "shop",
    role: "presser",
    permissions: permissionsFor("presser"),
  });

  beforeAll(async () => {
    companyId = (await createCompany()).id;
    userId = (await createUser(companyId, "presser")).id;
  });

  it("an old floor session is refused before the handler; a current one gets through", async () => {
    const old = await errorOf("production.queue", floorSession("0.0.1"), {
      station: "press",
      limit: 5,
    });
    expect(old).toEqual({
      code: "CLIENT_TOO_OLD",
      data: { minVersion: FLOOR_COMPAT_BASELINE, current: "0.0.1" },
    });
    expect(
      (await errorOf("production.queue", floorSession(null), { station: "press", limit: 5 })).code,
    ).toBe("CLIENT_TOO_OLD");
    expect(
      (
        await errorOf("production.queue", floorSession(CONTRACT_VERSION), {
          station: "press",
          limit: 5,
        })
      ).code,
    ).toBe("OK");
  });

  it("over HTTP: floor.staff (first contact, no session yet) answers 426 to an old tablet", async () => {
    const post = (headers: Record<string, string>) =>
      app.request("/rpc/floor/staff", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ json: {} }),
      });
    const old = await post({ "x-contract-version": "0.1.0" });
    expect(old.status).toBe(426);
    const body = (await old.json()) as { json: { code: string; data: unknown } };
    expect(body.json.code).toBe("CLIENT_TOO_OLD");
    expect(body.json.data).toEqual({ minVersion: FLOOR_COMPAT_BASELINE, current: "0.1.0" });
    expect((await post({})).status).toBe(426);
    // A current tablet reaches the handler, which then wants a station token.
    const current = await post({ "x-contract-version": CONTRACT_VERSION });
    expect(current.status).not.toBe(426);
  });
});
