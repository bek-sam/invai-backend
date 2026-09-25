import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "../../api/context";
import { withSystem, withTenant } from "../../db/client";
import { companies, importRuns, jobs, orderItems, orders, outboxEvents } from "../../db/schema";
import { runJobInline } from "../../lib/queues";
import { ensureBucket, objectKey, putObject } from "../../lib/s3";
import {
  createCompany,
  createConnection,
  createLocation,
  createUser,
  tenantContext,
} from "../../test/fixtures";
import * as importModule from "../orders/import";
import {
  CSV_CHUNK_ORDERS,
  CSV_INLINE_MAX_ROWS,
  importCsv,
  importCsvJob,
  listCsvImports,
} from "./sync";

/*
 * T-3-4 (B-61): a CSV import at or under CSV_INLINE_MAX_ROWS finishes in the request; a larger
 * one answers `queued` and runs as a job in chunk transactions that resume after a crash.
 */

vi.mock("../orders/import", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../orders/import")>();
  return { ...actual, importNormalizedOrders: vi.fn(actual.importNormalizedOrders) };
});

const HEADER =
  "order_id,order_no,placed_at,ship_by,buyer_name,buyer_email,address1,address2,city,state,zip,country,phone,sku,title,variant,quantity,unit_price,shipping,tax,discount,total,note,personalization,rush";

/** `n` orders of two rows each (2n rows), unmapped SKUs; `bad` adds one row with no quantity. */
function genericCsv(prefix: string, n: number, bad = false) {
  const lines = [HEADER];
  for (let i = 1; i <= n; i++) {
    const id = `${prefix}-${i}`;
    const base = `${id},${id},2026-09-22 10:00,2026-09-29,Test Buyer,,1 Main St,,Phoenix,AZ,85004,US,`;
    lines.push(`${base},NOPE-SKU-A,Tee A,Black / M,1,20.00,5.00,0,0,45.00,,,no`);
    lines.push(`${base},NOPE-SKU-B,Tee B,Black / L,1,20.00,5.00,0,0,45.00,,,no`);
  }
  if (bad)
    lines.push(
      `${prefix}-bad,${prefix}-bad,2026-09-22 10:00,,Test Buyer,,1 Main St,,Phoenix,AZ,85004,US,,NOPE-SKU-A,Tee A,Black / M,,20.00,0,0,0,20.00,,,no`,
    );
  return `${lines.join("\n")}\n`;
}

let companyId: string;
let ctx: TenantContext;
let connId: string;

async function upload(text: string) {
  const key = objectKey(companyId, "csv", "csv");
  await putObject(key, text, "text/csv");
  return key;
}

const orderCount = (prefix: string) =>
  withTenant(companyId, async (tx) =>
    (await tx.select({ id: orders.channelOrderId }).from(orders)).filter((o) =>
      o.id.startsWith(`${prefix}-`),
    ),
  );

beforeAll(async () => {
  companyId = (await createCompany()).id;
  // Unlimited orders: these files are bigger than the trial allowance.
  await withSystem((tx) =>
    tx.update(companies).set({ plan: "scale" }).where(eq(companies.id, companyId)),
  );
  const owner = await createUser(companyId, "owner");
  ctx = tenantContext(companyId, owner.id, "owner");
  await createLocation(companyId);
  connId = (await createConnection(companyId, "csv")).id;
  await ensureBucket();
});

describe("CSV import: inline for small files, a chunked job for large ones", () => {
  it("imports a small file in the request and reports it completed, with no job", async () => {
    const key = await upload(genericCsv("S", 5, true));
    const report = await importCsv(ctx, { id: connId, fileKey: key, format: "generic" });
    expect(report).toMatchObject({
      status: "completed",
      jobId: null,
      rowsTotal: 11,
      ordersImported: 5,
      rowsFailed: 1,
      itemsNeedingMapping: 10,
    });
    expect(report.errors).toHaveLength(1);
    expect(await orderCount("S")).toHaveLength(5);
  });

  it(`answers queued above ${CSV_INLINE_MAX_ROWS} rows, then the job imports in chunks`, async () => {
    const n = 2 * CSV_CHUNK_ORDERS + 50; // 250 orders, 500 rows: 3 chunk transactions
    const key = await upload(genericCsv("L", n));
    vi.mocked(importModule.importNormalizedOrders).mockClear();
    const report = await importCsv(ctx, { id: connId, fileKey: key, format: "generic" });
    expect(report).toMatchObject({ status: "queued", rowsTotal: 2 * n, ordersImported: 0 });
    expect(report.jobId).toBe(report.importId);
    expect(importModule.importNormalizedOrders).not.toHaveBeenCalled();
    expect(await orderCount("L")).toHaveLength(0);

    // The job is started through the outbox, in the same transaction as the run.
    const events = await withSystem((tx) =>
      tx.select().from(outboxEvents).where(eq(outboxEvents.name, "channels.import_requested")),
    );
    expect(events.filter((e) => e.payload.importRunId === report.importId)).toHaveLength(1);
    const listed = await withTenant(companyId, (tx) =>
      listCsvImports(tx, ctx, { id: connId, limit: 10 }),
    );
    expect(listed.items.find((r) => r.importId === report.importId)?.status).toBe("queued");

    await runJobInline(importCsvJob, { companyId, importRunId: report.importId });
    expect(importModule.importNormalizedOrders).toHaveBeenCalledTimes(3);
    expect(
      vi.mocked(importModule.importNormalizedOrders).mock.calls.map((c) => c[3].length),
    ).toEqual([100, 100, 50]);
    expect(await orderCount("L")).toHaveLength(n);

    const after = await withTenant(companyId, (tx) =>
      listCsvImports(tx, ctx, { id: connId, limit: 10 }),
    );
    expect(after.items.find((r) => r.importId === report.importId)).toMatchObject({
      status: "completed",
      jobId: report.importId,
      ordersImported: n,
      ordersSkipped: 0,
      itemsNeedingMapping: 2 * n,
    });
    const [job] = await withTenant(companyId, (tx) =>
      tx.select().from(jobs).where(eq(jobs.id, report.importId)),
    );
    expect(job).toMatchObject({ kind: "csv_import", status: "done", progress: 1 });

    // A duplicate run of the finished job changes nothing.
    vi.mocked(importModule.importNormalizedOrders).mockClear();
    await runJobInline(importCsvJob, { companyId, importRunId: report.importId });
    expect(importModule.importNormalizedOrders).not.toHaveBeenCalled();
  });

  it("resumes after a crash from the last committed chunk and counts each order once", async () => {
    const n = 3 * CSV_CHUNK_ORDERS; // 300 orders, 600 rows
    const key = await upload(genericCsv("C", n));
    const report = await importCsv(ctx, { id: connId, fileKey: key, format: "generic" });
    expect(report.status).toBe("queued");

    // Attempt 1 of 3: the third chunk blows up (as if the worker died mid-chunk).
    const mocked = vi.mocked(importModule.importNormalizedOrders);
    let calls = 0;
    mocked.mockImplementation(async (...args) => {
      calls += 1;
      if (calls === 3) throw new Error("connection lost");
      const actual = await vi.importActual<typeof import("../orders/import")>("../orders/import");
      return actual.importNormalizedOrders(...args);
    });
    await expect(
      runJobInline(
        importCsvJob,
        { companyId, importRunId: report.importId },
        { attempt: 1, attempts: 3 },
      ),
    ).rejects.toThrow("connection lost");
    const [mid] = await withTenant(companyId, (tx) =>
      tx.select().from(importRuns).where(eq(importRuns.id, report.importId)),
    );
    expect(mid).toMatchObject({ status: "running", ordersImported: 200 });
    const [midJob] = await withTenant(companyId, (tx) =>
      tx.select().from(jobs).where(eq(jobs.id, report.importId)),
    );
    expect(midJob?.status).toBe("running");
    expect(midJob?.input).toMatchObject({ cursor: 200 });

    // Attempt 2 resumes at order 200.
    await runJobInline(
      importCsvJob,
      { companyId, importRunId: report.importId },
      { attempt: 2, attempts: 3 },
    );
    expect(calls).toBe(4);
    const [done] = await withTenant(companyId, (tx) =>
      tx.select().from(importRuns).where(eq(importRuns.id, report.importId)),
    );
    expect(done).toMatchObject({ status: "completed", ordersImported: n, ordersSkipped: 0 });
    expect(await orderCount("C")).toHaveLength(n);
    const units = await withTenant(companyId, (tx) =>
      tx
        .select({ id: orderItems.id })
        .from(orderItems)
        .innerJoin(orders, eq(orders.id, orderItems.orderId)),
    );
    expect(units.length).toBeGreaterThanOrEqual(2 * n);
    mocked.mockReset();
    mocked.mockImplementation(
      (await vi.importActual<typeof import("../orders/import")>("../orders/import"))
        .importNormalizedOrders,
    );
  });

  it("marks the run and its job failed on the last attempt, keeping committed chunks", async () => {
    const n = 2 * CSV_CHUNK_ORDERS;
    const key = await upload(genericCsv("F", n));
    const report = await importCsv(ctx, { id: connId, fileKey: key, format: "generic" });
    const mocked = vi.mocked(importModule.importNormalizedOrders);
    const actual = await vi.importActual<typeof import("../orders/import")>("../orders/import");
    let calls = 0;
    mocked.mockImplementation(async (...args) => {
      calls += 1;
      if (calls === 2) throw new Error("still broken");
      return actual.importNormalizedOrders(...args);
    });
    await expect(
      runJobInline(importCsvJob, { companyId, importRunId: report.importId }),
    ).rejects.toThrow("still broken");
    const listed = await withTenant(companyId, (tx) =>
      listCsvImports(tx, ctx, { id: connId, limit: 20 }),
    );
    const failed = listed.items.find((r) => r.importId === report.importId);
    expect(failed).toMatchObject({ status: "failed", ordersImported: CSV_CHUNK_ORDERS });
    expect(failed?.errors.at(-1)?.message).toMatch(/stopped before the end/);
    const [job] = await withTenant(companyId, (tx) =>
      tx.select().from(jobs).where(eq(jobs.id, report.importId)),
    );
    expect(job).toMatchObject({ status: "failed", error: "still broken" });
    mocked.mockImplementation(actual.importNormalizedOrders);
  });
});
