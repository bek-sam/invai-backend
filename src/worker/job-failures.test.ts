import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem, withTenant } from "../db/client";
import { channelConnections, importRuns, jobs } from "../db/schema";
import { getJob } from "../lib/queues";
import "../modules/jobs";
import { createCompany, createConnection } from "../test/fixtures";
import { onJobFailed } from "./job-failures";

/*
 * T-3-4 r2: when BullMQ gives up on a job outside its handler (stalled too often, bad input),
 * the user-visible row must not stay `running` forever.
 */

let companyId: string;

beforeAll(async () => {
  companyId = (await createCompany()).id;
});

async function jobRow(status: "queued" | "running" | "done", id?: string) {
  const [row] = await withSystem((tx) =>
    tx
      .insert(jobs)
      .values({ ...(id ? { id } : {}), companyId, kind: "batch_labels", status, input: {} })
      .returning(),
  );
  return row?.id as string;
}
const statusOf = async (id: string) =>
  (await withTenant(companyId, (tx) => tx.select().from(jobs).where(eq(jobs.id, id))))[0];

const stalled = new Error("job stalled more than allowable limit");

describe("worker: jobs BullMQ gave up on", () => {
  it("marks a running job row failed on the final failure only", async () => {
    const id = await jobRow("running");
    const def = getJob("shipping.batchBuy");
    // A failure BullMQ will retry: finishedOn is empty, nothing changes.
    await onJobFailed(def, { name: "shipping.batchBuy", data: { companyId, jobId: id } }, stalled);
    expect((await statusOf(id))?.status).toBe("running");
    await onJobFailed(
      def,
      { name: "shipping.batchBuy", data: { companyId, jobId: id }, finishedOn: Date.now() },
      stalled,
    );
    expect(await statusOf(id)).toMatchObject({
      status: "failed",
      error: "job stalled more than allowable limit",
    });
  });

  it("leaves a finished row alone and ignores data without ids", async () => {
    const id = await jobRow("done");
    await onJobFailed(
      getJob("shipping.batchBuy"),
      { name: "shipping.batchBuy", data: { companyId, jobId: id }, finishedOn: Date.now() },
      stalled,
    );
    expect((await statusOf(id))?.status).toBe("done");
    await expect(
      onJobFailed(undefined, { name: "x", data: { nope: 1 }, finishedOn: Date.now() }, stalled),
    ).resolves.toBeUndefined();
  });

  it("fails a stalled CSV import's run and job through the job's hook", async () => {
    const conn = await createConnection(companyId, "csv");
    const [run] = await withSystem((tx) =>
      tx
        .insert(importRuns)
        .values({ companyId, connectionId: conn.id, format: "generic", status: "running" })
        .returning(),
    );
    const runId = run?.id as string;
    await jobRow("running", runId);
    await onJobFailed(
      getJob("channels.importCsv"),
      {
        name: "channels.importCsv",
        data: { companyId, importRunId: runId },
        finishedOn: Date.now(),
      },
      stalled,
    );
    const [after] = await withTenant(companyId, (tx) =>
      tx.select().from(importRuns).where(eq(importRuns.id, runId)),
    );
    expect(after?.status).toBe("failed");
    expect(after?.errors.at(-1)?.message).toMatch(/stopped before the end/);
    expect((await statusOf(runId))?.status).toBe("failed");
    await withSystem((tx) =>
      tx.delete(channelConnections).where(eq(channelConnections.id, conn.id)),
    );
  });
});
