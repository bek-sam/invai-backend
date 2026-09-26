import { UnrecoverableError, Worker } from "bullmq";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { withSystem, withTenant } from "../db/client";
import { aiJobs, alerts, jobs } from "../db/schema";
import { queues, redis } from "../lib/queues";
import * as realtime from "../lib/realtime";
import { createCompany } from "../test/fixtures";
import { checkFailedSpikes, sweepStuckAiJobs, sweepStuckJobRows } from "./sweeps";

/*
 * T-12-1: stuck `jobs`/`ai_jobs` rows are failed by the sweep, and a burst of failed jobs raises
 * one `queue_failed_spike` alert per spike.
 */

let companyId: string;
const old = () => new Date(Date.now() - 2 * 3600_000);

beforeAll(async () => {
  companyId = (await createCompany()).id;
  await Promise.all([
    queues.reports.obliterate({ force: true }),
    queues.render.obliterate({ force: true }),
  ]);
  await redis.del("dlq:spike:reports");
});
afterAll(async () => {
  await Promise.all([
    queues.reports.obliterate({ force: true }),
    queues.render.obliterate({ force: true }),
  ]);
  await redis.del("dlq:spike:reports");
});

async function jobRow(status: "queued" | "running", updatedAt: Date) {
  const [row] = await withSystem((tx) =>
    tx
      .insert(jobs)
      .values({ companyId, kind: "render_artwork", status, input: {}, updatedAt })
      .returning(),
  );
  return row?.id as string;
}
const rowOf = async (id: string) =>
  (await withTenant(companyId, (tx) => tx.select().from(jobs).where(eq(jobs.id, id))))[0];

describe("stuck jobs rows", () => {
  it("a running row with an old updatedAt and no job in Redis flips to failed and notifies", async () => {
    const publish = vi.spyOn(realtime, "publish");
    const id = await jobRow("running", old());
    const res = await sweepStuckJobRows();
    expect(res.failed).toBeGreaterThanOrEqual(1);
    const row = await rowOf(id);
    expect(row).toMatchObject({ status: "failed", progress: 1 });
    expect(row?.error).toMatch(/stopped without finishing/);
    expect(row?.finishedAt).not.toBeNull();
    expect(publish).toHaveBeenCalledWith(
      companyId,
      "job.progress",
      expect.objectContaining({ jobId: id, status: "failed", kind: "render_artwork" }),
    );
    publish.mockRestore();
  });

  it("leaves rows alone that are recent, or that a live BullMQ job still backs", async () => {
    const recent = await jobRow("running", new Date());
    const backed = await jobRow("queued", old());
    const live = await queues.render.add(
      "test.t121.pending",
      { companyId, jobId: backed },
      { delay: 3600_000 },
    );
    await sweepStuckJobRows();
    expect((await rowOf(recent))?.status).toBe("running");
    expect((await rowOf(backed))?.status).toBe("queued");
    await live.remove();
    await sweepStuckJobRows();
    expect((await rowOf(backed))?.status).toBe("failed");
  });

  it("an ai_jobs row left running by a dead process is failed", async () => {
    const [stale] = await withSystem((tx) =>
      tx
        .insert(aiJobs)
        .values({ companyId, kind: "assistant", status: "running", startedAt: old() })
        .returning({ id: aiJobs.id }),
    );
    const [fresh] = await withSystem((tx) =>
      tx
        .insert(aiJobs)
        .values({ companyId, kind: "assistant", status: "running", startedAt: new Date() })
        .returning({ id: aiJobs.id }),
    );
    await sweepStuckAiJobs();
    const rows = await withTenant(companyId, (tx) => tx.select().from(aiJobs));
    expect(rows.find((r) => r.id === stale?.id)).toMatchObject({ status: "failed" });
    expect(rows.find((r) => r.id === fresh?.id)).toMatchObject({ status: "running" });
  });
});

describe("queue_failed_spike", () => {
  async function failJobs(n: number) {
    const worker = new Worker(
      "reports",
      async () => {
        throw new UnrecoverableError("provider rejected it");
      },
      { connection: redis, concurrency: 10 },
    );
    const added = await Promise.all(
      Array.from({ length: n }, (_, i) => queues.reports.add("test.t121.fails", { companyId, i })),
    );
    const until = Date.now() + 10_000;
    while ((await queues.reports.getFailedCount()) < n) {
      if (Date.now() > until) throw new Error("jobs did not fail");
      await new Promise((r) => setTimeout(r, 50));
    }
    await worker.close();
    return added;
  }
  const spikeAlerts = () =>
    withTenant(companyId, (tx) =>
      tx
        .select()
        .from(alerts)
        .where(and(eq(alerts.companyId, companyId), eq(alerts.kind, "queue_failed_spike"))),
    );

  it("stays quiet under the threshold", async () => {
    await failJobs(2);
    await checkFailedSpikes({ threshold: 5, queueNames: ["reports"] });
    expect(await spikeAlerts()).toHaveLength(0);
  });

  it("raises once per spike, not once per failed job or per sweep tick", async () => {
    await failJobs(4); // 6 failed in the window now
    const first = await checkFailedSpikes({ threshold: 5, queueNames: ["reports"] });
    expect(first.spikes).toEqual([{ queue: "reports", failed: 6, alerted: 1 }]);
    await failJobs(3);
    await checkFailedSpikes({ threshold: 5, queueNames: ["reports"] });
    await checkFailedSpikes({ threshold: 5, queueNames: ["reports"] });
    const rows = await spikeAlerts();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ severity: "critical", entityType: null });
    expect(rows[0]?.data).toMatchObject({ queue: "reports", failed: 6 });

    // The spike closes (its flag lapses); a later spike alerts again.
    await redis.del("dlq:spike:reports");
    await checkFailedSpikes({ threshold: 5, queueNames: ["reports"], now: Date.now() + 1 });
    expect(await spikeAlerts()).toHaveLength(2);
  });
});
