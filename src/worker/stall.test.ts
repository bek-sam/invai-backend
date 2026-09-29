import { Worker } from "bullmq";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  defineJob,
  processJob,
  QUEUE_NAMES,
  queues,
  redis,
  WORKER_STALL_SETTINGS,
} from "../lib/queues";

/*
 * T-22-2 (B-166): every worker has explicit stall settings, and a stalled job (its worker died
 * or froze past lockDuration) runs once more, then fails for good on a second stall. This runs
 * a real BullMQ Worker on the `render` queue of this card's Valkey DB with the production
 * `maxStalledCount` and a scaled-down lock/stall interval; `skipLockRenewal` plays a worker
 * whose event loop is stuck, and a handler that never resolves plays the frozen job.
 */

const queue = queues.render;
const stall = WORKER_STALL_SETTINGS.render;
let runs = 0;

const frozenJob = defineJob({
  queue: "render",
  name: "test.t222.frozen",
  input: z.object({ n: z.number() }),
  handler: () => {
    runs += 1;
    return new Promise<never>(() => {});
  },
});

let worker: Worker;

beforeAll(async () => {
  await queue.obliterate({ force: true });
  worker = new Worker("render", processJob, {
    connection: redis,
    concurrency: 4,
    lockDuration: 1_000,
    stalledInterval: 500,
    maxStalledCount: stall.maxStalledCount,
    skipLockRenewal: true,
  });
});

afterAll(async () => {
  await worker.close(true);
  await queue.obliterate({ force: true });
});

describe("worker stall settings (B-166)", () => {
  it("every queue sets lockDuration, stalledInterval and maxStalledCount explicitly", () => {
    for (const name of QUEUE_NAMES) {
      const s = WORKER_STALL_SETTINGS[name];
      expect(s.lockDuration).toBeGreaterThanOrEqual(30_000);
      expect(s.stalledInterval).toBeGreaterThanOrEqual(10_000);
      expect(s.stalledInterval).toBeLessThanOrEqual(s.lockDuration);
      expect(s.maxStalledCount).toBe(1);
    }
  });

  it("a stalled job runs once more, then fails instead of stalling a third worker", async () => {
    const job = await frozenJob.enqueue({ n: 1 });
    const until = Date.now() + 15_000;
    while ((await job.getState()) !== "failed") {
      if (Date.now() > until)
        throw new Error(`job still ${await job.getState()} after ${runs} runs`);
      await new Promise((r) => setTimeout(r, 100));
    }
    const failed = await queue.getJob(job.id as string);
    expect(failed?.failedReason).toMatch(/stalled/i);
    // Initial run + exactly one retry after the first stall; the second stall fails it.
    expect(runs).toBe(1 + stall.maxStalledCount);
  });
});
