import { call } from "@orpc/server";
import { describe, expect, it } from "vitest";
import { anonymousContext, type Context, permissionsFor } from "../../api/context";
import { router } from "../../api/router";
import { withSystem } from "../../db/client";
import { files, jobs } from "../../db/schema";
import { createCompany, createUser } from "../../test/fixtures";

/*
 * B-340 (architect ruling 5/6): production.jobs.get answers an expired tenant export the way
 * privacy.exportStatus does; any other job, or an export whose zip is still there, is unchanged.
 */

function owner(companyId: string, userId: string): Context {
  return {
    ...anonymousContext(new Headers(), null),
    sessionKind: "user",
    user: { id: userId, name: "owner", email: "owner@test.local" },
    companyId,
    orgType: "shop",
    role: "owner",
    permissions: permissionsFor("owner"),
  };
}

async function job(
  companyId: string,
  kind: "tenant_export" | "build_sheets",
  resultIds: string[],
  message = "Exported 3 tables",
) {
  const [row] = await withSystem((tx) =>
    tx
      .insert(jobs)
      .values({ companyId, kind, status: "done", progress: 1, resultIds, message, input: {} })
      .returning(),
  );
  return row?.id as string;
}

async function zipRow(companyId: string, id: string) {
  await withSystem((tx) =>
    tx.insert(files).values({
      id,
      companyId,
      key: `${companyId}/exports/${id}.zip`,
      kind: "export",
      contentType: "application/zip",
      status: "ready",
    }),
  );
}

describe("production.jobs.get on a tenant export (B-340)", () => {
  it("an export whose zip row is gone says expired, like exportStatus; a live zip and other kinds are unchanged", async () => {
    const c = (await createCompany()).id;
    const ctx = owner(c, (await createUser(c, "owner")).id);
    const get = (id: string) => call(router.production.jobs.get, { id }, { context: ctx });

    const goneFile = crypto.randomUUID();
    const expired = await job(c, "tenant_export", [goneFile]);
    const got = await get(expired);
    expect(got).toMatchObject({ status: "done", resultIds: [], message: "expired" });
    expect(got).toEqual(
      await call(router.privacy.exportStatus, { jobId: expired }, { context: ctx }),
    );

    const liveFile = crypto.randomUUID();
    await zipRow(c, liveFile);
    const live = await job(c, "tenant_export", [liveFile]);
    expect(await get(live)).toMatchObject({ resultIds: [liveFile], message: "Exported 3 tables" });

    const sheets = await job(c, "build_sheets", [crypto.randomUUID()], "2 sheets");
    expect(await get(sheets)).toMatchObject({ message: "2 sheets" });
    expect((await get(sheets)).resultIds).toHaveLength(1);
  });

  it("another company's job id is NOT_FOUND", async () => {
    const a = (await createCompany()).id;
    const id = await job(a, "tenant_export", [crypto.randomUUID()]);
    const b = (await createCompany()).id;
    const ctx = owner(b, (await createUser(b, "owner")).id);
    await expect(call(router.production.jobs.get, { id }, { context: ctx })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
