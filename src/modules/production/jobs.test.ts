import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystem, withTenant } from "../../db/client";
import { gangSheetBatches, jobs } from "../../db/schema";
import { runJobInline, safeJobId } from "../../lib/queues";
import { createCompany } from "../../test/fixtures";

/*
 * T-3-4 (B-100): build and regenerate retry with backoff, a retry of a finished run is a no-op,
 * and the scrap job id carries a hash of the transfer set.
 */

const imagingMock = vi.hoisted(() => ({ isUp: vi.fn(async () => false) }));
vi.mock("../../integrations/imaging/client", async (orig) => {
  const actual = await orig<typeof import("../../integrations/imaging/client")>();
  return { ...actual, imaging: { ...actual.imaging, ...imagingMock } };
});
const run = vi.hoisted(() => ({ build: vi.fn(async () => ({ sheetIds: [] })) }));
vi.mock("./service", async (orig) => {
  const actual = await orig<typeof import("./service")>();
  return { ...actual, runBuildSheets: run.build };
});

const { buildSheetsJob, regenerateSheetJob, scrapCancelledJob, transferSetHash } = await import(
  "./jobs"
);

let companyId: string;

async function batchWithJob() {
  return withSystem(async (tx) => {
    const [job] = await tx
      .insert(jobs)
      .values({ companyId, kind: "build_sheets", input: {} })
      .returning();
    const [batch] = await tx
      .insert(gangSheetBatches)
      .values({ companyId, name: "Test batch", jobId: job?.id })
      .returning();
    return { batchId: batch?.id as string, jobId: job?.id as string };
  });
}

const jobRow = async (id: string) =>
  (await withTenant(companyId, (tx) => tx.select().from(jobs).where(eq(jobs.id, id))))[0];
const batchRow = async (id: string) =>
  (
    await withTenant(companyId, (tx) =>
      tx.select().from(gangSheetBatches).where(eq(gangSheetBatches.id, id)),
    )
  )[0];

beforeAll(async () => {
  companyId = (await createCompany()).id;
});

beforeEach(() => {
  imagingMock.isUp.mockResolvedValue(false);
  run.build.mockClear();
});

describe("production jobs", () => {
  it("retry with backoff and jitter", () => {
    for (const job of [buildSheetsJob, regenerateSheetJob]) {
      expect(job.options?.attempts).toBeGreaterThan(1);
      expect(job.options?.backoff).toMatchObject({ type: "exponential", jitter: 0.5 });
    }
  });

  it("build: imaging down retries without failing the job, the last attempt fails it", async () => {
    const { batchId, jobId } = await batchWithJob();
    await expect(
      runJobInline(buildSheetsJob, { companyId, batchId, jobId }, { attempt: 1, attempts: 4 }),
    ).rejects.toThrow(/imaging is not reachable/);
    expect(await jobRow(jobId)).toMatchObject({ status: "queued" });
    expect((await jobRow(jobId))?.message).toMatch(/^Retrying/);
    expect((await batchRow(batchId))?.status).toBe("building");

    await expect(
      runJobInline(buildSheetsJob, { companyId, batchId, jobId }, { attempt: 4, attempts: 4 }),
    ).rejects.toThrow();
    expect(await jobRow(jobId)).toMatchObject({ status: "failed" });
    expect((await batchRow(batchId))?.status).toBe("failed");
    expect(run.build).not.toHaveBeenCalled();
  });

  it("build: runs when imaging is up, and a retry of a finished run does nothing", async () => {
    imagingMock.isUp.mockResolvedValue(true);
    const { batchId, jobId } = await batchWithJob();
    await runJobInline(buildSheetsJob, { companyId, batchId, jobId }, { attempt: 2, attempts: 4 });
    expect(run.build).toHaveBeenCalledTimes(1);
    await withSystem((tx) =>
      tx.update(gangSheetBatches).set({ status: "ready" }).where(eq(gangSheetBatches.id, batchId)),
    );
    expect(await runJobInline(buildSheetsJob, { companyId, batchId, jobId })).toEqual({
      skipped: true,
    });
    expect(run.build).toHaveBeenCalledTimes(1);
  });

  it("scrap job ids differ for two partial cancels of one order", () => {
    const orderId = "00000000-0000-4000-8000-000000000001";
    const a = ["00000000-0000-4000-8000-00000000000a"];
    const b = ["00000000-0000-4000-8000-00000000000b"];
    const id = (transferIds: string[]) =>
      safeJobId(scrapCancelledJob.jobId?.({ companyId, orderId, transferIds }) ?? "");
    expect(id(a)).not.toBe(id(b)); // same order, same count: used to collide
    expect(id([...a, ...b])).toBe(id([...b, ...a]));
    expect(transferSetHash(a)).toMatch(/^[0-9a-f]{16}$/);
  });
});
