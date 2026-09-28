import {
  contract,
  listProcedures,
  PERMISSIONS,
  type Permission,
  ROLE_PERMISSIONS,
} from "@invai/contracts";
import { call } from "@orpc/server";
import { beforeAll, describe, expect, it } from "vitest";
import { createCompany, createUser } from "../test/fixtures";
import { anonymousContext, type Context, permissionsFor, roleFits } from "./context";
import { router } from "./router";

/*
 * The permission guard covers every procedure: each contract procedure declares a permission,
 * and calling any of them without the right session kind or permission is rejected before the
 * handler (or input validation) runs.
 */

const procedures = listProcedures(contract);

type AnyProcedure = Parameters<typeof call>[0];
function procedureAt(path: string): AnyProcedure {
  let node: unknown = router;
  for (const key of path.split(".")) node = (node as Record<string, unknown>)[key];
  return node as AnyProcedure;
}

async function codeOf(path: string, context: Context): Promise<string> {
  try {
    await call(procedureAt(path), undefined as never, { context });
    return "OK";
  } catch (err) {
    return (err as { code?: string }).code ?? String(err);
  }
}

describe("permission guard", () => {
  let companyId: string;
  let vendorId: string;
  let userId: string;
  const base = () => anonymousContext(new Headers(), null);

  beforeAll(async () => {
    companyId = (await createCompany()).id;
    vendorId = (await createCompany({ type: "vendor" })).id;
    userId = (await createUser(companyId, "presser")).id;
  });

  it("every procedure declares a known permission and auth mode", () => {
    expect(procedures.length).toBeGreaterThan(150);
    for (const p of procedures) {
      expect(p.meta, p.path).toBeDefined();
      expect([...PERMISSIONS, "none"], p.path).toContain(p.meta.permission);
      expect(["user", "floor", "station", "public", undefined], p.path).toContain(p.meta.auth);
    }
    // Only the PIN login screen runs without a user or floor session.
    const open = procedures.filter((p) => p.meta.auth === "public" || p.meta.auth === "station");
    expect(open.map((p) => p.path).sort()).toEqual(["floor.login", "floor.staff"]);
    const none = procedures.filter((p) => p.meta.permission === "none").map((p) => p.path);
    expect(none.sort()).toEqual([
      "floor.login",
      "floor.logout",
      "floor.staff",
      "me.get",
      "me.switchOrg",
    ]);
  });

  it("anonymous callers get UNAUTHORIZED everywhere except the station procedures", async () => {
    for (const p of procedures) {
      if (p.meta.auth === "public" || p.meta.auth === "station") continue;
      expect(await codeOf(p.path, base()), p.path).toBe("UNAUTHORIZED");
    }
  });

  it("a session without the procedure's permission gets FORBIDDEN", async () => {
    const noPerms: Context = {
      ...base(),
      sessionKind: "user",
      user: { id: userId, name: "x", email: "x@test.local" },
      companyId,
      orgType: "shop",
      role: "presser",
      permissions: new Set(),
    };
    for (const p of procedures) {
      if (p.meta.permission === "none" || p.meta.auth === "station") continue;
      expect(await codeOf(p.path, noPerms), p.path).toBe("FORBIDDEN");
    }
  });

  it("floor sessions reach only `auth: floor` procedures", async () => {
    const floor: Context = {
      ...base(),
      sessionKind: "floor",
      user: { id: userId, name: "x", email: "x@test.local" },
      companyId,
      orgType: "shop",
      role: "owner",
      permissions: permissionsFor("owner"),
    };
    for (const p of procedures) {
      if ((p.meta.auth ?? "user") !== "user") continue;
      expect(await codeOf(p.path, floor), p.path).toBe("UNAUTHORIZED");
    }
  });

  it("a bare station token reaches no user or floor procedure", async () => {
    const station: Context = {
      ...base(),
      sessionKind: "station",
      companyId,
      orgType: "shop",
      permissions: permissionsFor("owner"),
    };
    for (const p of procedures) {
      const mode = p.meta.auth ?? "user";
      if (mode === "public" || mode === "station") continue;
      expect(await codeOf(p.path, station), p.path).toBe("UNAUTHORIZED");
    }
  });

  it("vendor users hold only vendor-portal and own-org permissions", async () => {
    const vendorPerms = new Set<Permission>(ROLE_PERMISSIONS.vendor);
    const reachable = procedures
      .filter((p) => p.meta.permission !== "none" && vendorPerms.has(p.meta.permission))
      .map((p) => p.path.split(".")[0]);
    // "me" is reachable too: contract 0.7.0 put me.notifications.* on org.read (wave 19, A1) so
    // any signed-in member, vendors included, can manage their own email preferences. That's by
    // design (docs: invai-contracts/src/contract/tenancy.ts). Vendors still hold neither
    // finance.read nor org.manage, so every digest.* procedure (all finance.read or org.manage)
    // stays out of reach, checked explicitly below.
    expect([...new Set(reachable)].sort()).toEqual([
      "alerts",
      "files",
      "locations",
      "me",
      "stations",
      "team",
      "vendorPortal",
    ]);
    const vendorUser: Context = {
      ...base(),
      sessionKind: "user",
      user: { id: userId, name: "v", email: "v@test.local" },
      companyId: vendorId,
      orgType: "vendor",
      role: "vendor",
      permissions: permissionsFor("vendor"),
    };
    for (const path of ["orders.list", "production.sheets.list", "finance.profit", "channels.list"])
      expect(await codeOf(path, vendorUser), path).toBe("FORBIDDEN");
    // Digest content and settings are finance.read/org.manage; a vendor has neither, so it never
    // reaches any digest procedure even though it can reach "me.notifications.*".
    const digestPaths = procedures.filter((p) => p.path.startsWith("digest.")).map((p) => p.path);
    expect(digestPaths.length).toBeGreaterThan(0);
    for (const path of digestPaths) expect(await codeOf(path, vendorUser), path).toBe("FORBIDDEN");
  });

  it("a role that does not fit the org type carries no permissions", () => {
    expect(roleFits("vendor", "owner")).toBe(false);
    expect(roleFits("shop", "vendor")).toBe(false);
    expect(roleFits("shop", "owner")).toBe(true);
    expect(roleFits("vendor", "vendor")).toBe(true);
  });
});
