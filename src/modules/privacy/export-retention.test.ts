import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { anonymousContext, type Context, permissionsFor } from "../../api/context";
import { router } from "../../api/router";
import { withSystem, withTenant } from "../../db/client";
import { files } from "../../db/schema";
import { runJobInline } from "../../lib/queues";
import { putObject } from "../../lib/s3";
import { createCompany, createUser } from "../../test/fixtures";
import { exists } from "./buyer-text.fixtures";
import {
  EXPORT_RETENTION_DAYS,
  expireAllTenantExports,
  expireTenantExports,
} from "./export-retention";
import { privacyRetentionSweepJob } from "./jobs";
import { exportKey } from "./service";

/* Real MinIO, recording every delete, with a switch to make chosen keys fail. */
const s3 = vi.hoisted(() => ({ failing: new Set<string>(), deleted: [] as string[] }));
vi.mock("../../lib/s3", async (orig) => {
  const actual = await orig<typeof import("../../lib/s3")>();
  return {
    ...actual,
    deleteObject: async (key: string) => {
      s3.deleted.push(key);
      if (s3.failing.has(key)) throw new Error("storage unavailable");
      return actual.deleteObject(key);
    },
  };
});
/* Warnings, captured with their data (the real logger still writes). */
const logs = vi.hoisted(() => ({ warn: [] as { msg: string; data?: Record<string, unknown> }[] }));
vi.mock("../../lib/log", async (orig) => {
  const actual = await orig<typeof import("../../lib/log")>();
  return {
    ...actual,
    logger: (scope: string) => {
      const real = actual.logger(scope);
      return {
        ...real,
        warn: (msg: string, data?: Record<string, unknown>) => {
          logs.warn.push({ msg, data });
          real.warn(msg, data);
        },
      };
    },
  };
});

const DAY = 86400_000;
const KEEP_MS = EXPORT_RETENTION_DAYS * DAY;

/** An export zip in storage and its `files` row, made at `createdAt` (the zip's clock). */
async function makeExport(c: string, createdAt: Date, opts: { row?: boolean } = {}) {
  const id = crypto.randomUUID();
  const key = await putObject(exportKey(c, id), "PK", "application/zip");
  if (opts.row !== false)
    await withSystem((tx) =>
      tx.insert(files).values({
        id,
        companyId: c,
        key,
        kind: "export",
        contentType: "application/zip",
        status: "ready",
        createdAt,
      }),
    );
  return { id, key };
}

const rowOf = async (c: string, id: string) =>
  (await withTenant(c, (tx) => tx.select().from(files).where(eq(files.id, id))))[0];

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

describe("tenant-export zips expire after 7 days (decision 0033)", () => {
  it("deletes a zip older than 7 days, object and row; the download answers NOT_FOUND; a rerun deletes nothing", async () => {
    const c = (await createCompany()).id;
    const ownerId = (await createUser(c, "owner")).id;
    const old = await makeExport(c, new Date(Date.now() - KEEP_MS - DAY));
    const young = await makeExport(c, new Date(Date.now() - DAY));

    const res = await expireTenantExports(c);

    expect(res).toEqual({ exportsDeleted: 1, exportsFailed: 0 });
    expect(await exists(old.key)).toBe(false);
    expect(await rowOf(c, old.id)).toBeUndefined();
    expect(await exists(young.key)).toBe(true);
    expect(await rowOf(c, young.id)).toBeDefined();
    await expect(
      call(
        router.files.downloadUrl,
        { fileKey: old.key, disposition: "attachment" },
        { context: owner(c, ownerId) },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const signed = await call(
      router.files.downloadUrl,
      { fileKey: young.key, disposition: "attachment" },
      { context: owner(c, ownerId) },
    );
    expect((await fetch(signed.url)).status).toBe(200);

    s3.deleted.length = 0;
    expect(await expireTenantExports(c)).toEqual({ exportsDeleted: 0, exportsFailed: 0 });
    expect(s3.deleted).toEqual([]);
  });

  it("boundary: a zip of exactly 7 days is kept, one second older is deleted", async () => {
    const c = (await createCompany()).id;
    // Made a minute before the object was written, so the object listing (LastModified) never
    // decides this case: the row's createdAt does.
    const t = new Date(Date.now() - 60_000);
    const zip = await makeExport(c, t);

    expect((await expireTenantExports(c, new Date(t.getTime() + KEEP_MS))).exportsDeleted).toBe(0);
    expect(await exists(zip.key)).toBe(true);
    expect(await rowOf(c, zip.id)).toBeDefined();

    const res = await expireTenantExports(c, new Date(t.getTime() + KEEP_MS + 1000));
    expect(res.exportsDeleted).toBe(1);
    expect(await exists(zip.key)).toBe(false);
    expect(await rowOf(c, zip.id)).toBeUndefined();
  });

  it("expiry is total: a zip no row points at goes by its age in storage; a young one stays", async () => {
    const c = (await createCompany()).id;
    const orphan = await makeExport(c, new Date(), { row: false });

    expect((await expireTenantExports(c)).exportsDeleted).toBe(0);
    expect(await exists(orphan.key)).toBe(true);

    const later = new Date(Date.now() + KEEP_MS + DAY);
    expect((await expireTenantExports(c, later)).exportsDeleted).toBe(1);
    expect(await exists(orphan.key)).toBe(false);
    expect((await expireTenantExports(c, later)).exportsDeleted).toBe(0);
  });

  it("a failed delete keeps the row for the next run and logs the company and file id only", async () => {
    const c = (await createCompany()).id;
    const zip = await makeExport(c, new Date(Date.now() - KEEP_MS - DAY));
    s3.failing.add(zip.key);
    logs.warn.length = 0;
    try {
      const res = await expireTenantExports(c);
      expect(res).toEqual({ exportsDeleted: 0, exportsFailed: 1 });
      expect(await rowOf(c, zip.id)).toBeDefined();
      expect(await exists(zip.key)).toBe(true);
      const warned = logs.warn.filter((l) => l.data?.fileId === zip.id);
      expect(warned).toHaveLength(1);
      expect(warned[0]?.data).toMatchObject({ companyId: c, fileId: zip.id });
      expect(JSON.stringify(warned[0]?.data)).not.toContain(zip.key);
    } finally {
      s3.failing.clear();
    }

    expect((await expireTenantExports(c)).exportsDeleted).toBe(1);
    expect(await rowOf(c, zip.id)).toBeUndefined();
    expect(await exists(zip.key)).toBe(false);
  });

  it("only rows whose key is exportKey(company, id) are expired: a key outside the company prefix is never touched", async () => {
    const a = (await createCompany()).id;
    const b = (await createCompany()).id;
    // B's young zip, and a row in A (kind export, old) that points at it.
    const bZip = await makeExport(b, new Date(), { row: false });
    const stray = crypto.randomUUID();
    await withSystem((tx) =>
      tx.insert(files).values({
        id: stray,
        companyId: a,
        key: bZip.key,
        kind: "export",
        status: "ready",
        createdAt: new Date(Date.now() - KEEP_MS - DAY),
      }),
    );
    // An old row in A of another kind under A's tenant-export prefix is not an export row.
    const other = crypto.randomUUID();
    const otherKey = await putObject(`${a}/tenant-export/x-${other}.bin`, "x", "text/plain");
    await withSystem((tx) =>
      tx.insert(files).values({
        id: other,
        companyId: a,
        key: otherKey,
        kind: "other",
        status: "ready",
        createdAt: new Date(Date.now() - KEEP_MS - DAY),
      }),
    );
    // An old export row in A whose key is in A's prefix but is not exportKey(A, its id).
    const mismatched = crypto.randomUUID();
    const mismatchedKey = await putObject(
      exportKey(a, crypto.randomUUID()),
      "PK",
      "application/zip",
    );
    await withSystem((tx) =>
      tx.insert(files).values({
        id: mismatched,
        companyId: a,
        key: mismatchedKey,
        kind: "export",
        status: "ready",
        createdAt: new Date(Date.now() - KEEP_MS - DAY),
      }),
    );
    s3.deleted.length = 0;

    expect((await expireTenantExports(a)).exportsDeleted).toBe(0);
    expect(s3.deleted).toEqual([]);
    expect(await exists(bZip.key)).toBe(true);
    expect(await exists(mismatchedKey)).toBe(true);
    expect(await rowOf(a, stray)).toBeDefined();
    expect(await rowOf(a, other)).toBeDefined();
    expect(await rowOf(a, mismatched)).toBeDefined();
  });

  it("company A's run never lists or deletes company B's zips", async () => {
    const a = (await createCompany()).id;
    const b = (await createCompany()).id;
    const aOld = await makeExport(a, new Date(Date.now() - KEEP_MS - DAY));
    const bOld = await makeExport(b, new Date(Date.now() - KEEP_MS - DAY));
    const bOrphan = await makeExport(b, new Date(), { row: false });
    s3.deleted.length = 0;

    const res = await expireAllTenantExports(new Date(Date.now() + KEEP_MS + DAY), [a]);

    expect(res.exportsDeleted).toBe(1);
    expect(s3.deleted).toEqual([aOld.key]);
    expect(await exists(bOld.key)).toBe(true);
    expect(await exists(bOrphan.key)).toBe(true);
    expect(await rowOf(b, bOld.id)).toBeDefined();
  });

  it("runs in the daily privacy.retentionSweep job; a second run deletes nothing", async () => {
    const c = (await createCompany()).id;
    const zip = await makeExport(c, new Date(Date.now() - KEEP_MS - DAY));
    const first = (await runJobInline(privacyRetentionSweepJob, {})) as { exportsDeleted: number };
    expect(first.exportsDeleted).toBeGreaterThanOrEqual(1);
    expect(await exists(zip.key)).toBe(false);
    expect(await rowOf(c, zip.id)).toBeUndefined();
    const second = (await runJobInline(privacyRetentionSweepJob, {})) as {
      exportsDeleted: number;
    };
    expect(second.exportsDeleted).toBe(0);
  });
});
