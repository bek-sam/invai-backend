import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "../db/client";
import { companies, designs, listingDrafts } from "../db/schema";
import { createCompany, createUser } from "../test/fixtures";
import { type Context, permissionsFor } from "./context";
import { router } from "./router";

/*
 * T-8-6 (follow-up to T-8-2 r3 / OI-5): a NUL byte in any oRPC input string used to crash the
 * first Postgres text/jsonb write it reached. `pub`'s `sanitizeInput` middleware (src/api/orpc.ts)
 * now strips it from every procedure's input before the handler runs. This exercises the
 * boundary through a real, representative procedure end to end (not just the helper in
 * isolation): `ai.listings.create`, whose `brief` used to crash `listing_drafts.brief`'s insert.
 */

type AnyProcedure = Parameters<typeof call>[0];
function procedureAt(path: string): AnyProcedure {
  let node: unknown = router;
  for (const key of path.split(".")) node = (node as Record<string, unknown>)[key];
  return node as AnyProcedure;
}

describe("oRPC input boundary strips NUL bytes", () => {
  let companyId: string;
  let userId: string;
  let designId: string;

  beforeAll(async () => {
    companyId = (await createCompany()).id;
    userId = (await createUser(companyId, "owner")).id;
    // Etsy's validator requires a production partner (T-8-1); set one so create() doesn't fail
    // for an unrelated reason.
    await withSystem((tx) =>
      tx
        .update(companies)
        .set({ settings: { productionPartner: { name: "Cactus Print Co", etsyPartnerId: null } } })
        .where(eq(companies.id, companyId)),
    );
    const [d] = await withSystem((tx) =>
      tx
        .insert(designs)
        .values({ companyId, code: "D-NUL", name: "NUL Test Design", tags: ["test"] })
        .returning(),
    );
    designId = d?.id as string;
  });

  it("a NUL byte in ai.listings.create's brief doesn't crash the listing_drafts insert", async () => {
    const context: Context = {
      requestId: crypto.randomUUID(),
      ip: null,
      headers: new Headers(),
      sessionKind: "user",
      user: { id: userId, name: "Owner", email: "owner@test.local" },
      emailVerified: true,
      companyId,
      orgType: "shop",
      role: "owner",
      permissions: permissionsFor("owner"),
      station: null,
      memberships: [],
      authSessionId: null,
    };
    const res = (await call(
      procedureAt("ai.listings.create"),
      { designId, channels: ["etsy"], brief: "warm tone\u0000 for gift buyers" },
      { context },
    )) as { drafts: { id: string }[] };

    expect(res.drafts).toHaveLength(1);
    const [row] = await withSystem((tx) =>
      tx
        .select({ brief: listingDrafts.brief })
        .from(listingDrafts)
        .where(eq(listingDrafts.id, res.drafts[0]?.id as string)),
    );
    expect(row?.brief).toBe("warm tone for gift buyers");
  });
});
