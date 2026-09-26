import { type Job, Queue, Worker } from "bullmq";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  acquireSlot,
  BULK_PRIORITY,
  companyIdFromData,
  heldSlots,
  releaseSlot,
  withFairness,
} from "./fairness";
import { redis } from "./queues";

/*
 * T-12-3 (B-20): per-tenant job fairness. A per-{queue, companyId} Valkey semaphore (this file)
 * caps how many of one tenant's jobs run at once on a queue; a job over the cap re-delays itself
 * instead of running or failing. Bulk job kinds get a lower BullMQ priority so an interactive job
 * isn't stuck behind a bulk backlog. Real BullMQ Queue/Worker against this card's Redis DB, on the
 * `render` queue (the same one src/lib/queues.test.ts uses; each obliterates before/after so the
 * two files don't interfere).
 */

const queue = new Queue("render", { connection: redis });
let worker: Worker | undefined;

async function settle(job: Job, states: string[], ms = 15_000): Promise<string> {
  const until = Date.now() + ms;
  for (;;) {
    const state = await job.getState();
    if (states.includes(state)) return state;
    if (Date.now() > until) throw new Error(`job ${job.id} still ${state}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeAll(async () => {
  await queue.obliterate({ force: true });
});

afterEach(async () => {
  await worker?.close();
  worker = undefined;
});

afterAll(async () => {
  await queue.obliterate({ force: true });
});

describe("per-tenant semaphore (acquireSlot/releaseSlot)", () => {
  it("caps concurrent slots per {queue, companyId} and releases them", async () => {
    const companyId = crypto.randomUUID();
    expect(await acquireSlot("test-fairness", companyId, "a", 2)).toBe(true);
    expect(await acquireSlot("test-fairness", companyId, "b", 2)).toBe(true);
    expect(await acquireSlot("test-fairness", companyId, "c", 2)).toBe(false);
    expect(await heldSlots("test-fairness", companyId)).toBe(2);

    // Re-acquiring a slot you already hold is idempotent, not a 3rd slot.
    expect(await acquireSlot("test-fairness", companyId, "a", 2)).toBe(true);
    expect(await heldSlots("test-fairness", companyId)).toBe(2);

    await releaseSlot("test-fairness", companyId, "a");
    expect(await acquireSlot("test-fairness", companyId, "c", 2)).toBe(true);

    await releaseSlot("test-fairness", companyId, "b");
    await releaseSlot("test-fairness", companyId, "c");
    expect(await heldSlots("test-fairness", companyId)).toBe(0);
  });

  it("a different queue name and a different company each get their own cap", async () => {
    const companyId = crypto.randomUUID();
    expect(await acquireSlot("test-fairness-2", companyId, "x", 1)).toBe(true);
    // Same company, different queue: separate cap.
    expect(await acquireSlot("test-fairness-3", companyId, "x", 1)).toBe(true);
    // Different company, same queue: separate cap.
    expect(await acquireSlot("test-fairness-2", crypto.randomUUID(), "y", 1)).toBe(true);
  });

  it("fails open (allows the slot) when Redis errors", async () => {
    const spy = vi.spyOn(redis, "eval").mockRejectedValueOnce(new Error("ECONNREFUSED"));
    expect(await acquireSlot("test-fairness", crypto.randomUUID(), "z", 2)).toBe(true);
    spy.mockRestore();
  });
});

describe("tenant fairness under load (T-12-3 AC4)", () => {
  it("tenant B's small backlog finishes within a bounded time despite tenant A's 200-job backlog", async () => {
    const tenantA = crypto.randomUUID();
    const tenantB = crypto.randomUUID();
    const JOB_MS = 40;

    const handler = async () => {
      await new Promise((r) => setTimeout(r, JOB_MS));
      return "ok";
    };
    worker = new Worker("render", withFairness(companyIdFromData, handler), {
      connection: redis,
      concurrency: 10,
    });

    const aJobs = await Promise.all(
      Array.from({ length: 200 }, (_, i) => queue.add("fairness.a", { companyId: tenantA, i })),
    );
    const bJobs = await Promise.all(
      Array.from({ length: 5 }, (_, i) => queue.add("fairness.b", { companyId: tenantB, i })),
    );

    const start = Date.now();
    await Promise.all(bJobs.map((j) => settle(j, ["completed"], 8_000)));
    const elapsed = Date.now() - start;

    // Concrete wall-clock bound, not "eventually": tenant A alone would need
    // 200 jobs / 2 concurrent slots * 40 ms =~ 4 s just for its own admitted work, so 8 s is a
    // real bound, not a rubber stamp -- and B finishes well inside it because the semaphore lets
    // the worker skip past most of A's backlog (a failed acquire re-delays almost instantly)
    // instead of running it all before B gets a turn.
    expect(elapsed).toBeLessThan(8_000);

    // Tenant A's backlog is nowhere near drained when B finishes -- B wasn't just first in line.
    const aStates = await Promise.all(aJobs.slice(0, 20).map((j) => j.getState()));
    expect(aStates.some((s) => s !== "completed")).toBe(true);

    await worker.close();
    worker = undefined;
    await Promise.all([...aJobs, ...bJobs].map((j) => j.remove().catch(() => {})));
  }, 20_000);
});

describe("bulk vs interactive priority (T-12-3 AC5)", () => {
  it("an interactive job queued after a full bulk backlog is picked up before it", async () => {
    await queue.obliterate({ force: true });
    const order: number[] = [];
    const handler = async (job: Job<{ n: number }>) => {
      order.push(job.data.n);
      await new Promise((r) => setTimeout(r, 5));
    };

    // The whole backlog sits in the queue, cold, before any worker exists: 50 bulk jobs at
    // BULK_PRIORITY, then one interactive job with no explicit priority.
    for (let n = 0; n < 50; n++) {
      await queue.add("bulk", { n }, { priority: BULK_PRIORITY });
    }
    const interactive = await queue.add("interactive", { n: -1 });

    worker = new Worker("render", handler, { connection: redis, concurrency: 1 });
    await settle(interactive, ["completed"], 5_000);

    // BullMQ dequeues unprioritized jobs before any prioritized one, whatever order they were
    // added in: the interactive job runs first, well before "most of" the 50-job bulk backlog.
    const position = order.indexOf(-1);
    expect(position).toBeGreaterThanOrEqual(0);
    expect(position).toBeLessThan(25);
  });
});
