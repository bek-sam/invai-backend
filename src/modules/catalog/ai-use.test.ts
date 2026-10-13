import { call } from "@orpc/server";
import { and, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { anonymousContext, type Context, permissionsFor } from "../../api/context";
import { router } from "../../api/router";
import { db, withSystem } from "../../db/client";
import { auditLog, designs } from "../../db/schema";
import { createCompany, createUser } from "../../test/fixtures";

/*
 * T-48-4 (B-274): a design's `aiUse`, through the oRPC router so the contract's zod parsing runs.
 * Spec `listing-ai-disclosure.md` AC4, AC9-AC12 and AC3 (the column).
 */

type Role = "owner" | "designer" | "office" | "presser";

describe("designs.aiUse (T-48-4)", () => {
  let companyId: string;
  let otherCompanyId: string;
  const users: Record<string, { id: string; name: string; email: string }> = {};
  let otherOwner: { id: string; name: string; email: string };
  let seq = 0;

  const ctxFor = (
    co: string,
    role: Role,
    u: { id: string; name: string; email: string },
  ): Context => ({
    ...anonymousContext(new Headers(), null),
    sessionKind: "user",
    user: { id: u.id, name: u.name, email: u.email },
    companyId: co,
    orgType: "shop",
    role,
    permissions: permissionsFor(role),
  });
  const as = (role: Role) => ctxFor(companyId, role, users[role] as (typeof users)[string]);

  beforeAll(async () => {
    companyId = (await createCompany()).id;
    otherCompanyId = (await createCompany()).id;
    for (const role of ["owner", "designer", "office", "presser"] as const)
      users[role] = await createUser(companyId, role);
    otherOwner = await createUser(otherCompanyId, "owner");
  });

  const input = (extra: Record<string, unknown> = {}) => {
    seq += 1;
    return {
      code: `AIU-${seq}`,
      name: `AI use ${seq}`,
      tags: ["cactus", "sun"],
      placements: [
        {
          placement: "front" as const,
          fileKey: `${companyId}/design/x.png`,
          widthIn: 11,
          heightIn: 12,
        },
      ],
      ...extra,
    };
  };
  const create = (extra?: Record<string, unknown>, role: Role = "owner") =>
    call(router.designs.create, input(extra) as never, { context: as(role) });
  const storedAiUse = async (id: string) =>
    (
      await withSystem((tx) =>
        tx.select({ v: designs.aiUse }).from(designs).where(eq(designs.id, id)),
      )
    )[0]?.v;
  const auditRows = (designId: string) =>
    withSystem((tx) =>
      tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.entityId, designId), eq(auditLog.entityType, "design"))),
    );

  it("AC3: the column is NOT NULL with default 'unknown', and a row inserted without it reads unknown", async () => {
    const res = await db.execute<{ is_nullable: string; column_default: string }>(
      sql`select is_nullable, column_default from information_schema.columns where table_name = 'designs' and column_name = 'ai_use'`,
    );
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]?.is_nullable).toBe("NO");
    expect(res.rows[0]?.column_default).toContain("'unknown'");
    const [d] = await withSystem((tx) =>
      tx.insert(designs).values({ companyId, code: "AIU-SQL", name: "Plain insert" }).returning(),
    );
    const got = await call(router.designs.get, { id: d?.id as string }, { context: as("owner") });
    expect(got.aiUse).toBe("unknown");
  });

  it("AC4: create without aiUse reads back unknown; with aiUse it stores the value", async () => {
    const plain = await create();
    expect(plain.aiUse).toBe("unknown");
    expect(await storedAiUse(plain.id)).toBe("unknown");
    const none = await create({ aiUse: "none" });
    expect(none.aiUse).toBe("none");
    expect(await storedAiUse(none.id)).toBe("none");
  });

  it("AC9: update without aiUse leaves it; update with only {id, aiUse} leaves tags and template", async () => {
    const d = await create({ aiUse: "none" });
    const renamed = await call(
      router.designs.update,
      { id: d.id, name: "Renamed" },
      { context: as("designer") },
    );
    expect(renamed.aiUse).toBe("none");
    expect(await storedAiUse(d.id)).toBe("none");
    const set = await call(
      router.designs.update,
      { id: d.id, aiUse: "ai" },
      { context: as("designer") },
    );
    expect(set.aiUse).toBe("ai");
    expect(set.tags).toEqual(["cactus", "sun"]);
    expect(set.name).toBe("Renamed");
    expect(set.placements).toHaveLength(1);
    expect(set.personalizationTemplateId).toBeNull();
  });

  it("AC10: get and list return the field; office and presser cannot create or update; tenant B gets NOT_FOUND", async () => {
    const d = await create({ aiUse: "none" });
    const got = await call(router.designs.get, { id: d.id }, { context: as("office") });
    expect(got.aiUse).toBe("none");
    const list = await call(router.designs.list, { limit: 200 }, { context: as("office") });
    expect(list.items.find((x) => x.id === d.id)?.aiUse).toBe("none");
    for (const role of ["office", "presser"] as const) {
      await expect(create({ aiUse: "none" }, role)).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        call(router.designs.update, { id: d.id, aiUse: "ai" }, { context: as(role) }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    expect(await storedAiUse(d.id)).toBe("none");
    const b = ctxFor(otherCompanyId, "owner", otherOwner);
    await expect(call(router.designs.get, { id: d.id }, { context: b })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      call(router.designs.update, { id: d.id, aiUse: "ai" }, { context: b }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await storedAiUse(d.id)).toBe("none");
  });

  it("AC11: an unknown aiUse value is BAD_REQUEST and the row is unchanged", async () => {
    const d = await create({ aiUse: "none" });
    await expect(
      call(router.designs.update, { id: d.id, aiUse: "maybe" } as never, { context: as("owner") }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(create({ aiUse: "maybe" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await storedAiUse(d.id)).toBe("none");
  });

  it("AC12: a value change writes one audit row with old, new and user; the same value writes none", async () => {
    const d = await create();
    const before = (await auditRows(d.id)).length;
    await call(router.designs.update, { id: d.id, aiUse: "none" }, { context: as("designer") });
    const rows = await auditRows(d.id);
    expect(rows).toHaveLength(before + 1);
    const row = rows.find((r) => (r.data as { field?: string }).field === "aiUse");
    expect(row?.data).toMatchObject({ field: "aiUse", from: "unknown", to: "none" });
    expect(row?.actorUserId).toBe(users.designer?.id);
    expect(row?.entityId).toBe(d.id);
    await call(router.designs.update, { id: d.id, aiUse: "none" }, { context: as("designer") });
    await call(
      router.designs.update,
      { id: d.id, name: "Other name" },
      { context: as("designer") },
    );
    expect(await auditRows(d.id)).toHaveLength(before + 1);
  });
});
