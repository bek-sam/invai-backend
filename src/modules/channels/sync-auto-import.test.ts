import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { withSystem, withTenant } from "../../db/client";
import { channelConnections, jobs, orders } from "../../db/schema";
import { createCompany } from "../../test/fixtures";
import { syncConnection } from "./sync";

/* T-28-5 (B-261): poll-started syncs skip when auto-import is off; manual syncs still run. */

async function mockShopify(companyId: string, autoImport: boolean) {
  const [row] = await withSystem((tx) =>
    tx
      .insert(channelConnections)
      .values({
        companyId,
        channel: "shopify",
        name: "Shopify t285",
        status: "connected",
        mode: "api",
        provider: "mock",
        externalShopId: `t285-${crypto.randomUUID()}.myshopify.com`,
        settings: { autoImport },
      })
      .returning(),
  );
  if (!row) throw new Error("insert failed");
  return row;
}

const orderCount = (companyId: string) =>
  withTenant(companyId, async (tx) => (await tx.select({ id: orders.id }).from(orders)).length);
const reload = (companyId: string, id: string) =>
  withTenant(companyId, async (tx) => {
    const [r] = await tx.select().from(channelConnections).where(eq(channelConnections.id, id));
    return r;
  });
const setAutoImport = (id: string, autoImport: boolean) =>
  withSystem((tx) =>
    tx
      .update(channelConnections)
      .set({ settings: { autoImport } })
      .where(eq(channelConnections.id, id)),
  );

describe("syncConnection with auto-import off", () => {
  it("a poll-started sync imports nothing and leaves the connection untouched", async () => {
    const co = (await createCompany()).id;
    const conn = await mockShopify(co, false);
    const before = await reload(co, conn.id);
    const res = await syncConnection(co, conn.id);
    expect(res).toMatchObject({ imported: 0, skipped: true });
    expect(await orderCount(co)).toBe(0);
    const after = await reload(co, conn.id);
    expect(after?.lastSyncAt).toEqual(before?.lastSyncAt);
    expect(after?.status).toBe("connected");
    expect(after?.lastError ?? null).toBe(before?.lastError ?? null);
    // run twice: still nothing
    await syncConnection(co, conn.id, null);
    expect(await orderCount(co)).toBe(0);
  });

  it("a manual sync (has a jobId) still runs and its job ends done", async () => {
    const co = (await createCompany()).id;
    const conn = await mockShopify(co, false);
    const [job] = await withSystem((tx) =>
      tx
        .insert(jobs)
        .values({ companyId: co, kind: "sync", status: "queued", input: { connectionId: conn.id } })
        .returning({ id: jobs.id }),
    );
    if (!job) throw new Error("job insert failed");
    const res = await syncConnection(co, conn.id, job.id);
    expect(res.skipped).not.toBe(true);
    const [row] = await withTenant(co, (tx) => tx.select().from(jobs).where(eq(jobs.id, job.id)));
    expect(row?.status).toBe("done");
    expect((await reload(co, conn.id))?.lastSyncAt).not.toBeNull();
  });

  it("reads the setting when the job runs: on at enqueue, off at run", async () => {
    const co = (await createCompany()).id;
    const conn = await mockShopify(co, true);
    await setAutoImport(conn.id, false); // switched off after the tick queued it
    const res = await syncConnection(co, conn.id);
    expect(res).toMatchObject({ imported: 0, skipped: true });
    expect(await orderCount(co)).toBe(0);
  });

  it("with auto-import on, a poll sync still runs", async () => {
    const co = (await createCompany()).id;
    const conn = await mockShopify(co, true);
    const res = await syncConnection(co, conn.id);
    expect(res.skipped).not.toBe(true);
    expect((await reload(co, conn.id))?.lastSyncAt).not.toBeNull();
  });
});
