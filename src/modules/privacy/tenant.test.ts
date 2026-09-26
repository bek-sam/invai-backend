import type { Role } from "@invai/contracts";
import { call } from "@orpc/server";
import { and, count, eq, inArray, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { anonymousContext, type Context, permissionsFor } from "../../api/context";
import { router } from "../../api/router";
import { withSystem, withTenant } from "../../db/client";
import {
  auditLog,
  blankVariants,
  buyerPii,
  channelConnections,
  companies,
  files,
  floorRequests,
  inventoryMovements,
  members,
  orderItems,
  orders,
} from "../../db/schema";
import { queues, runJobInline, safeJobId } from "../../lib/queues";
import { headObject, listObjects, putObject } from "../../lib/s3";
import {
  createCompany,
  createConnection,
  createLocation,
  createOrder,
  createUser,
} from "../../test/fixtures";
import { tenantExportJob, tenantHardPurgeJob } from "./jobs";
import {
  buyerPiiCutoff,
  exportKey,
  HARD_PURGE_DELAY_MS,
  purgeOldFloorRequests,
  redactStaleBuyerPii,
  tenantTables,
} from "./service";
import { readZip } from "./zip";

/*
 * Whole-company export, deletion and retention (T-12-4, B-23). Every flow runs against two real
 * companies on the RLS-enforced test database and checks that the other company's rows, files
 * and audit log are untouched.
 */

type Shop = { id: string; ownerId: string; orderIds: string[]; fileKey: string };

function as(companyId: string, userId: string, role: Role): Context {
  return {
    ...anonymousContext(new Headers(), null),
    sessionKind: "user",
    user: { id: userId, name: role, email: `${role}@test.local` },
    companyId,
    orgType: "shop",
    role,
    permissions: permissionsFor(role),
  };
}

/**
 * A shop with an owner, `n` orders carrying buyer PII, one uploaded design in storage and one row
 * in the append-only stock ledger.
 */
async function shop(n: number): Promise<Shop> {
  const id = (await createCompany()).id;
  const ownerId = (await createUser(id, "owner")).id;
  const conn = await createConnection(id);
  await withSystem((tx) =>
    tx
      .update(channelConnections)
      .set({ credentials: "super-secret-token" })
      .where(eq(channelConnections.id, conn.id)),
  );
  const orderIds: string[] = [];
  for (let i = 0; i < n; i++) {
    const { order } = await createOrder(id, conn.id, { units: 2 });
    orderIds.push(order.id);
    await withSystem((tx) =>
      tx.insert(buyerPii).values({ companyId: id, orderId: order.id, name: `Buyer ${i}` }),
    );
  }
  const fileKey = `${id}/design/2026/09/${crypto.randomUUID()}.png`;
  await putObject(fileKey, Buffer.from("png-bytes"), "image/png");
  await withSystem((tx) =>
    tx.insert(files).values({ companyId: id, key: fileKey, kind: "design", status: "ready" }),
  );
  const location = await createLocation(id);
  await withSystem(async (tx) => {
    const [variant] = await tx
      .insert(blankVariants)
      .values({
        companyId: id,
        brand: "Gildan",
        style: "Softstyle",
        styleCode: "G64000",
        color: "Black",
        colorCode: "BLK",
        size: "M",
        sizeCode: "M",
        sku: `G64000-BLK-M-${crypto.randomUUID().slice(0, 8)}`,
        costCents: 300,
      })
      .returning();
    await tx.insert(inventoryMovements).values({
      companyId: id,
      blankVariantId: (variant as { id: string }).id,
      locationId: location.id,
      kind: "receive",
      qty: 12,
    });
  });
  return { id, ownerId, orderIds, fileKey };
}

async function countWhere(companyId: string) {
  return withTenant(companyId, async (tx) => ({
    orders: (await tx.select({ n: count() }).from(orders))[0]?.n ?? 0,
    items: (await tx.select({ n: count() }).from(orderItems))[0]?.n ?? 0,
    pii: (await tx.select({ n: count() }).from(buyerPii))[0]?.n ?? 0,
    files: (await tx.select({ n: count() }).from(files))[0]?.n ?? 0,
    audit: (await tx.select({ n: count() }).from(auditLog))[0]?.n ?? 0,
    ledger: (await tx.select({ n: count() }).from(inventoryMovements))[0]?.n ?? 0,
  }));
}

async function auditRows(companyId: string, action: string) {
  return withTenant(companyId, (tx) =>
    tx
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.companyId, companyId), eq(auditLog.action, action))),
  );
}

async function purgeJobExists(companyId: string) {
  return !!(await queues.reports.getJob(safeJobId(`hard-purge:${companyId}`)));
}

describe("privacy: tenant export", () => {
  let a: Shop;
  let b: Shop;
  beforeAll(async () => {
    a = await shop(3);
    b = await shop(2);
  });

  it("exports every table and file as a zip fetched through files.downloadUrl", async () => {
    const bBefore = await countWhere(b.id);
    const job = await call(
      router.privacy.exportTrigger,
      {},
      { context: as(a.id, a.ownerId, "owner") },
    );
    expect(job).toMatchObject({ kind: "tenant_export", status: "queued", resultIds: [] });
    await runJobInline(tenantExportJob, { companyId: a.id, jobId: job.id });

    const done = await call(
      router.privacy.exportStatus,
      { jobId: job.id },
      { context: as(a.id, a.ownerId, "owner") },
    );
    expect(done.status).toBe("done");
    const fileId = done.resultIds[0] as string;
    expect(fileId).toBe(job.id);
    const [fileRow] = await withTenant(a.id, (tx) =>
      tx.select().from(files).where(eq(files.id, fileId)),
    );
    expect(fileRow).toMatchObject({
      kind: "export",
      status: "ready",
      key: exportKey(a.id, fileId),
    });

    const signed = await call(
      router.files.downloadUrl,
      { fileKey: exportKey(a.id, fileId), disposition: "attachment" },
      { context: as(a.id, a.ownerId, "owner") },
    );
    const res = await fetch(signed.url);
    expect(res.status).toBe(200);
    const zip = readZip(Buffer.from(await res.arrayBuffer()));

    const csv = zip.get("tables/orders.csv")?.toString("utf8").trim().split("\r\n") ?? [];
    expect(csv.length - 1).toBe(3); // header + a's 3 orders
    const json = JSON.parse(zip.get("tables/orders.json")?.toString("utf8") ?? "[]") as {
      id: string;
    }[];
    expect(json.map((o) => o.id).sort()).toEqual([...a.orderIds].sort());
    expect(zip.get("tables/order_items.csv")?.toString().trim().split("\r\n").length).toBe(7);
    // Buyer PII is decrypted for the shop (the controller); secrets never leave.
    expect(zip.get("tables/buyer_pii.json")?.toString()).toContain("Buyer 0");
    const conns = zip.get("tables/channel_connections.csv")?.toString() ?? "";
    expect(conns.split("\r\n")[0]).not.toContain("credentials");
    expect(conns).not.toContain("super-secret-token");
    // Stored files ride along under files/.
    expect(zip.get(`files/${a.fileKey.slice(a.id.length + 1)}`)?.toString()).toBe("png-bytes");
    const manifest = JSON.parse(zip.get("manifest.json")?.toString() ?? "{}");
    expect(manifest.tables.orders).toBe(3);
    expect(Object.keys(manifest.tables)).toHaveLength(tenantTables().length);

    // Cross-tenant: nothing of company b is in a's export, and b is unchanged.
    const all = [...zip.values()].map((v) => v.toString("latin1")).join("\n");
    expect(all).not.toContain(b.id);
    for (const id of b.orderIds) expect(all).not.toContain(id);
    expect(await countWhere(b.id)).toEqual(bBefore);
    // b cannot fetch a's export by key or read its job.
    await expect(
      call(
        router.files.downloadUrl,
        { fileKey: exportKey(a.id, fileId), disposition: "attachment" },
        { context: as(b.id, b.ownerId, "owner") },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      call(
        router.privacy.exportStatus,
        { jobId: job.id },
        { context: as(b.id, b.ownerId, "owner") },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("allows one export at a time per company (EXPORT_IN_PROGRESS), per company", async () => {
    const owner = as(a.id, a.ownerId, "owner");
    const first = await call(router.privacy.exportTrigger, {}, { context: owner });
    await expect(call(router.privacy.exportTrigger, {}, { context: owner })).rejects.toMatchObject({
      code: "EXPORT_IN_PROGRESS",
      status: 409,
      data: { jobId: first.id, startedAt: first.createdAt },
    });
    // Company b is not blocked by a's running export.
    const other = await call(
      router.privacy.exportTrigger,
      {},
      { context: as(b.id, b.ownerId, "owner") },
    );
    expect(other.id).not.toBe(first.id);
    await runJobInline(tenantExportJob, { companyId: a.id, jobId: first.id });
    await runJobInline(tenantExportJob, { companyId: b.id, jobId: other.id });
    // Finished: the next export is allowed again (happy path).
    const next = await call(router.privacy.exportTrigger, {}, { context: owner });
    expect(next.status).toBe("queued");
    await runJobInline(tenantExportJob, { companyId: a.id, jobId: next.id });
  });

  it("is the owner's alone: admin gets FORBIDDEN", async () => {
    const adminId = (await createUser(a.id, "admin")).id;
    const admin = as(a.id, adminId, "admin");
    for (const p of [router.privacy.exportTrigger, router.privacy.deleteRequest] as const)
      await expect(
        call(p as never, { confirm: true } as never, { context: admin }),
      ).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
  });
});

describe("privacy: deletion", () => {
  let a: Shop;
  let b: Shop;
  beforeAll(async () => {
    a = await shop(1);
    b = await shop(1);
  });

  it("soft-deletes with a purge 30 days out, and cancel makes the purge a no-op", async () => {
    const owner = as(a.id, a.ownerId, "owner");
    const before = Date.now();
    const req = await call(router.privacy.deleteRequest, { confirm: true }, { context: owner });
    const at = new Date(req.scheduledPurgeAt).getTime();
    expect(Math.abs(at - before - HARD_PURGE_DELAY_MS)).toBeLessThan(60_000);
    expect(await call(router.privacy.deleteStatus, {}, { context: owner })).toEqual({
      status: "soft_deleted",
      scheduledPurgeAt: req.scheduledPurgeAt,
    });
    const delayed = await queues.reports.getJob(safeJobId(`hard-purge:${a.id}`));
    expect(await delayed?.getState()).toBe("delayed");
    await expect(
      call(router.privacy.deleteRequest, { confirm: true }, { context: owner }),
    ).rejects.toMatchObject({
      code: "DELETION_ALREADY_REQUESTED",
      data: { scheduledPurgeAt: req.scheduledPurgeAt },
    });
    // Company b is unaffected.
    expect(
      await call(router.privacy.deleteStatus, {}, { context: as(b.id, b.ownerId, "owner") }),
    ).toEqual({ status: "active", scheduledPurgeAt: null });

    await expect(call(router.privacy.deleteCancel, {}, { context: owner })).resolves.toEqual({
      ok: true,
    });
    expect(await call(router.privacy.deleteStatus, {}, { context: owner })).toEqual({
      status: "active",
      scheduledPurgeAt: null,
    });
    expect(await purgeJobExists(a.id)).toBe(false);
    // A stale copy firing anyway (even "30 days later") does nothing.
    const later = await runJobInline(tenantHardPurgeJob, { companyId: a.id });
    expect(later).toEqual({ purged: false, reason: "not_requested" });
    expect((await countWhere(a.id)).orders).toBe(1);
    expect((await headObject(a.fileKey)).exists).toBe(true);
    await expect(call(router.privacy.deleteCancel, {}, { context: owner })).rejects.toMatchObject({
      code: "NO_DELETION_PENDING",
    });
  });

  it("a purge that fires early does nothing", async () => {
    const owner = as(b.id, b.ownerId, "owner");
    await call(router.privacy.deleteRequest, { confirm: true }, { context: owner });
    expect(await runJobInline(tenantHardPurgeJob, { companyId: b.id })).toEqual({
      purged: false,
      reason: "not_due",
    });
    await call(router.privacy.deleteCancel, {}, { context: owner });
  });
});

describe("privacy: hard purge", () => {
  let a: Shop;
  let b: Shop;
  let bBefore: Awaited<ReturnType<typeof countWhere>>;
  beforeAll(async () => {
    a = await shop(2);
    b = await shop(2);
    bBefore = await countWhere(b.id);
    await call(
      router.privacy.deleteRequest,
      { confirm: true },
      { context: as(a.id, a.ownerId, "owner") },
    );
    // Fast-forward 30 days: the request was made 31 days ago.
    await withSystem((tx) =>
      tx
        .update(companies)
        .set({ deletedAt: new Date(Date.now() - HARD_PURGE_DELAY_MS - 86400_000) })
        .where(eq(companies.id, a.id)),
    );
  });

  it("deletes every company row and stored object, keeping an anonymized tombstone", async () => {
    const res = await runJobInline(tenantHardPurgeJob, { companyId: a.id });
    expect(res).toMatchObject({ purged: true, alreadyPurged: false, objects: 1 });

    // (a) every company table is empty for a, except the audit log's tenant.* lifecycle rows.
    const left = await withSystem(async (tx) => {
      const out: Record<string, number> = {};
      for (const t of tenantTables()) {
        const [r] = await tx.select({ n: count() }).from(t.table).where(eq(t.companyId, a.id));
        if (r?.n) out[t.name] = r.n;
      }
      return out;
    });
    expect(left).toEqual({ audit_log: 2 });
    const kept = await withSystem((tx) =>
      tx.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.companyId, a.id)),
    );
    expect(kept.map((r) => r.action).sort()).toEqual(["tenant.delete_requested", "tenant.purged"]);
    const [tomb] = await withSystem((tx) =>
      tx.select().from(companies).where(eq(companies.id, a.id)),
    );
    expect(tomb).toMatchObject({
      name: "Deleted company",
      slug: `deleted-${a.id}`,
      metadata: null,
    });
    expect(tomb?.purgedAt).toBeInstanceOf(Date);
    const memberRows = await withSystem((tx) =>
      tx.select().from(members).where(eq(members.organizationId, a.id)),
    );
    expect(memberRows).toEqual([]);

    // (b) the objects are gone from the bucket, not just their rows.
    expect((await headObject(a.fileKey)).exists).toBe(false);
    expect(await listObjects(`${a.id}/`)).toEqual([]);

    // Company b: rows, files and storage untouched.
    expect(await countWhere(b.id)).toEqual(bBefore);
    expect((await headObject(b.fileKey)).exists).toBe(true);

    // The ledger's purge exception is the owner connection's alone: the app role still can't.
    await expect(
      withTenant(b.id, async (tx) => {
        await tx.execute(sql`select set_config('app.purge_company_id', ${b.id}, true)`);
        await tx.delete(inventoryMovements).where(eq(inventoryMovements.companyId, b.id));
      }),
    ).rejects.toThrow();
    expect((await countWhere(b.id)).ledger).toBe(1);

    // Idempotent: a second run only repeats the (empty) storage sweep.
    expect(await runJobInline(tenantHardPurgeJob, { companyId: a.id })).toMatchObject({
      purged: true,
      alreadyPurged: true,
      objects: 0,
    });
  });
});

describe("privacy: audit", () => {
  it("records export, delete, cancel (the acting user) and purge (system)", async () => {
    const a = await shop(1);
    const b = await shop(1);
    const bAudit = (await countWhere(b.id)).audit;
    const owner = as(a.id, a.ownerId, "owner");
    const job = await call(router.privacy.exportTrigger, {}, { context: owner });
    await runJobInline(tenantExportJob, { companyId: a.id, jobId: job.id });
    await call(router.privacy.deleteRequest, { confirm: true }, { context: owner });
    await call(router.privacy.deleteCancel, {}, { context: owner });
    await call(router.privacy.deleteRequest, { confirm: true }, { context: owner });
    await withSystem((tx) =>
      tx
        .update(companies)
        .set({ deletedAt: new Date(Date.now() - HARD_PURGE_DELAY_MS) })
        .where(eq(companies.id, a.id)),
    );
    await runJobInline(tenantHardPurgeJob, { companyId: a.id });

    const byUser = { actorKind: "user", actorUserId: a.ownerId };
    expect(await auditRows(a.id, "tenant.export_requested")).toMatchObject([
      { ...byUser, entityId: job.id },
    ]);
    expect(await auditRows(a.id, "tenant.delete_requested")).toMatchObject([byUser, byUser]);
    expect(await auditRows(a.id, "tenant.delete_cancelled")).toMatchObject([byUser]);
    expect(await auditRows(a.id, "tenant.purged")).toMatchObject([
      { actorKind: "system", actorUserId: null, entityId: a.id },
    ]);
    expect((await countWhere(b.id)).audit).toBe(bAudit);
  });
});

describe("privacy: retention sweeps", () => {
  it("redacts buyer PII on orders older than 18 months, keeping order facts", async () => {
    const a = await shop(2);
    const b = await shop(1);
    const old = new Date(buyerPiiCutoff().getTime() - 86400_000); // 18 months + 1 day
    const [oldId, recentId] = a.orderIds as [string, string];
    const personalization = [{ question: "Name", answer: "Private Name", fileUrl: null }];
    await withSystem(async (tx) => {
      await tx
        .update(orders)
        .set({ placedAt: old, buyerNote: "ring twice", buyerRef: "buyer-123" })
        .where(inArray(orders.id, [oldId, b.orderIds[0] as string]));
      await tx.update(orders).set({ buyerNote: "recent note" }).where(eq(orders.id, recentId));
      await tx
        .update(orderItems)
        .set({ personalization })
        .where(inArray(orderItems.orderId, a.orderIds));
    });
    // b's order is recent: the sweep must leave it alone.
    await withSystem((tx) =>
      tx
        .update(orders)
        .set({ placedAt: new Date() })
        .where(eq(orders.id, b.orderIds[0] as string)),
    );
    const snapshot = async (id: string, companyId: string) =>
      withTenant(companyId, async (tx) => ({
        order: (await tx.select().from(orders).where(eq(orders.id, id)))[0],
        pii: await tx.select().from(buyerPii).where(eq(buyerPii.orderId, id)),
        items: await tx.select().from(orderItems).where(eq(orderItems.orderId, id)),
      }));
    const beforeOld = await snapshot(oldId, a.id);
    const beforeB = await snapshot(b.orderIds[0] as string, b.id);

    const res = await redactStaleBuyerPii();
    expect(res.orders).toBeGreaterThanOrEqual(1);

    const afterOld = await snapshot(oldId, a.id);
    expect(afterOld.pii).toEqual([]);
    expect(afterOld.order).toMatchObject({ buyerNote: null, buyerRef: null, rawPayloadKey: null });
    expect(afterOld.items.every((i) => i.personalization.every((p) => p.answer === null))).toBe(
      true,
    );
    // Non-PII facts untouched.
    for (const k of ["totalCents", "subtotalCents", "itemCount", "placedAt", "orderNo"] as const)
      expect(afterOld.order?.[k]).toEqual(beforeOld.order?.[k]);
    expect(afterOld.items.length).toBe(beforeOld.items.length);
    // The recent order in a and company b's order keep their PII.
    const recent = await snapshot(recentId, a.id);
    expect(recent.pii).toHaveLength(1);
    expect(recent.order?.buyerNote).toBe("recent note");
    expect(recent.items[0]?.personalization[0]?.answer).toBe("Private Name");
    expect(await snapshot(b.orderIds[0] as string, b.id)).toEqual(beforeB);
    // Idempotent: nothing left to redact for a.
    await redactStaleBuyerPii();
    expect((await auditRows(a.id, "privacy.redacted")).length).toBe(1);
  });

  it("deletes floor_requests older than 30 days only", async () => {
    const a = await shop(0);
    const b = await shop(0);
    const row = (companyId: string, key: string, createdAt: Date) => ({
      companyId,
      kind: "pack_order" as const,
      idempotencyKey: key,
      result: { ok: true },
      createdAt,
    });
    const oldAt = new Date(Date.now() - 31 * 86400_000);
    await withSystem((tx) =>
      tx
        .insert(floorRequests)
        .values([
          row(a.id, "old", oldAt),
          row(a.id, "recent", new Date()),
          row(b.id, "recent", new Date()),
        ]),
    );
    const res = await purgeOldFloorRequests();
    expect(res.deleted).toBeGreaterThanOrEqual(1);
    const keys = async (companyId: string) =>
      (
        await withTenant(companyId, (tx) =>
          tx.select({ k: floorRequests.idempotencyKey }).from(floorRequests),
        )
      ).map((r) => r.k);
    expect(await keys(a.id)).toEqual(["recent"]);
    expect(await keys(b.id)).toEqual(["recent"]);
  });
});
