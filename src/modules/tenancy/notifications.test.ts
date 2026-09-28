import { call } from "@orpc/server";
import { describe, expect, it } from "vitest";
import { anonymousContext, type Context, permissionsFor } from "../../api/context";
import { router } from "../../api/router";
import { getEmailPreference } from "../../lib/notify";
import { createCompany, createUser } from "../../test/fixtures";

/* me.notifications.get/set (contracts 0.7.0, ADR 0016): the caller's own kind-keyed opt-ins. */

type AnyProcedure = Parameters<typeof call>[0];
function procedureAt(path: string): AnyProcedure {
  let node: unknown = router;
  for (const key of path.split(".")) node = (node as Record<string, unknown>)[key];
  return node as AnyProcedure;
}

function ctx(companyId: string, userId: string, role: "owner" | "office" | "presser"): Context {
  return {
    ...anonymousContext(new Headers(), null),
    sessionKind: "user",
    user: { id: userId, name: "P", email: "p@test.local" },
    emailVerified: true,
    companyId,
    orgType: "shop",
    role,
    permissions: permissionsFor(role),
    resHeaders: new Headers(),
  };
}

describe("me.notifications", () => {
  it("lists every kind (default off), sets one on with source settings, and is per company", async () => {
    const a = await createCompany();
    const b = await createCompany();
    const user = await createUser(a.id, "office");
    const before = await call(
      procedureAt("me.notifications.get"),
      {},
      { context: ctx(a.id, user.id, "office") },
    );
    expect(before).toEqual({
      items: [{ kind: "digest", on: false, source: null, updatedAt: null }],
    });

    const after = (await call(
      procedureAt("me.notifications.set"),
      { kind: "digest", on: true },
      { context: ctx(a.id, user.id, "office") },
    )) as { items: Array<{ kind: string; on: boolean; source: string | null }> };
    expect(after.items[0]).toMatchObject({ kind: "digest", on: true, source: "settings" });
    expect((await getEmailPreference(a.id, user.id, "digest")).on).toBe(true);
    // The same person in another company starts from off there.
    expect((await getEmailPreference(b.id, user.id, "digest")).on).toBe(false);

    const off = (await call(
      procedureAt("me.notifications.set"),
      { kind: "digest", on: false },
      { context: ctx(a.id, user.id, "office") },
    )) as { items: Array<{ on: boolean; source: string | null }> };
    expect(off.items[0]).toMatchObject({ on: false, source: "settings" });
  });

  it("every role may manage its own preference (org.read), a presser included", async () => {
    const shop = await createCompany();
    const presser = await createUser(shop.id, "presser");
    const res = (await call(
      procedureAt("me.notifications.set"),
      { kind: "digest", on: true },
      { context: ctx(shop.id, presser.id, "presser") },
    )) as { items: Array<{ on: boolean }> };
    expect(res.items[0]?.on).toBe(true);
  });
});
