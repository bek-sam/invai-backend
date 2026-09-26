import { type Job, UnrecoverableError, Worker } from "bullmq";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  BACKOFF_JITTER,
  DEFAULT_BACKOFF,
  defineJob,
  isPermanentHttpStatus,
  permanentFailure,
  processJob,
  queues,
  redis,
  withJitter,
} from "./queues";

/*
 * T-12-1 (B-17): retries use jittered backoff for every job type, and permanent failures
 * (invalid input, a provider's 4xx) fail after one attempt instead of five.
 * These run a real BullMQ Worker with the worker's own processor (`processJob`) on the `render`
 * queue of this card's Valkey DB, emptied before and after.
 */

const queue = queues.render;
let worker: Worker;

async function settle(job: Job, states: string[], ms = 15_000): Promise<string> {
  const until = Date.now() + ms;
  for (;;) {
    const state = await job.getState();
    if (states.includes(state)) return state;
    if (Date.now() > until) throw new Error(`job ${job.id} still ${state}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** A provider mock that answers like an HTTP API. */
const provider = {
  status: 400,
  async call() {
    return { status: this.status };
  },
};

const flakyJob = defineJob({
  queue: "render",
  name: "test.t121.flaky",
  input: z.object({ n: z.number() }),
  handler: async () => {
    throw new Error("upstream timeout");
  },
});

const strictJob = defineJob({
  queue: "render",
  name: "test.t121.strict",
  input: z.object({ companyId: z.uuid() }),
  handler: async () => "ok",
});

const providerJob = defineJob({
  queue: "render",
  name: "test.t121.provider",
  input: z.object({ n: z.number() }),
  handler: async () => {
    const res = await provider.call();
    if (isPermanentHttpStatus(res.status)) permanentFailure(`provider said ${res.status}`);
    if (res.status >= 400) throw new Error(`provider said ${res.status}`);
    return "ok";
  },
});

const ownBackoffJob = defineJob({
  queue: "render",
  name: "test.t121.ownBackoff",
  input: z.object({ n: z.number() }),
  options: { attempts: 3, backoff: { type: "exponential", delay: 10_000 } },
  handler: async () => "ok",
});

beforeAll(async () => {
  await queue.obliterate({ force: true });
  worker = new Worker("render", processJob, { connection: redis, concurrency: 20 });
});

afterAll(async () => {
  await worker.close();
  await queue.obliterate({ force: true });
});

describe("retry backoff (B-17)", () => {
  it("every job type gets jitter, including jobs with their own backoff", () => {
    expect(DEFAULT_BACKOFF).toMatchObject({ type: "exponential", jitter: BACKOFF_JITTER });
    expect(withJitter({ type: "exponential", delay: 10_000 })).toEqual({
      type: "exponential",
      delay: 10_000,
      jitter: BACKOFF_JITTER,
    });
    expect(withJitter(3_000)).toEqual({ type: "fixed", delay: 3_000, jitter: BACKOFF_JITTER });
    expect(withJitter({ type: "fixed", delay: 1, jitter: 0 })).toEqual({
      type: "fixed",
      delay: 1,
      jitter: 0,
    });
  });

  it("a job's own backoff is enqueued with jitter", async () => {
    const job = await ownBackoffJob.enqueue({ n: 1 }, { delay: 60_000 });
    expect(job.opts.backoff).toEqual({ type: "exponential", delay: 10_000, jitter: 0.5 });
    await job.remove();
  });

  it("20 failures of the same job type retry after different, jittered delays", async () => {
    const jobs = await Promise.all(Array.from({ length: 20 }, (_, n) => flakyJob.enqueue({ n })));
    for (const job of jobs) expect(job.opts.backoff).toEqual(DEFAULT_BACKOFF);
    for (const job of jobs) await settle(job, ["delayed"]);
    const delays: number[] = [];
    for (const job of jobs) {
      const fresh = await queue.getJob(job.id as string);
      expect(fresh?.attemptsMade).toBe(1);
      delays.push(fresh?.delay ?? -1);
    }
    // First retry of exponential 2000 ms with jitter 0.5: somewhere in [1000, 2000].
    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(DEFAULT_BACKOFF.delay * (1 - BACKOFF_JITTER));
      expect(d).toBeLessThanOrEqual(DEFAULT_BACKOFF.delay);
    }
    expect(new Set(delays).size).toBeGreaterThan(1);
    await Promise.all(jobs.map((j) => j.remove()));
  });
});

describe("permanent failures (UnrecoverableError)", () => {
  it("permanentFailure throws BullMQ's UnrecoverableError", () => {
    expect(() => permanentFailure("revoked")).toThrow(UnrecoverableError);
    expect([400, 401, 403, 404, 422].every(isPermanentHttpStatus)).toBe(true);
    expect([408, 409, 425, 429, 500, 503].some(isPermanentHttpStatus)).toBe(false);
  });

  it("Zod-invalid input fails after 1 attempt, not 5", async () => {
    // Bypass enqueue()'s own parse, as a stale or hand-made job would.
    const job = await queue.add(strictJob.name, { companyId: "not-a-uuid" });
    expect(job.opts.attempts).toBe(5);
    expect(await settle(job, ["failed", "completed"])).toBe("failed");
    const fresh = await queue.getJob(job.id as string);
    expect(fresh?.attemptsMade).toBe(1);
    expect(fresh?.failedReason).toMatch(/invalid input for test\.t121\.strict/);
  });

  it("a provider 4xx fails after 1 attempt; a 5xx is retried", async () => {
    provider.status = 422;
    const job = await providerJob.enqueue({ n: 1 });
    expect(await settle(job, ["failed", "completed"])).toBe("failed");
    expect((await queue.getJob(job.id as string))?.attemptsMade).toBe(1);

    provider.status = 503;
    const retried = await providerJob.enqueue({ n: 2 });
    expect(await settle(retried, ["delayed", "failed"])).toBe("delayed");
    expect((await queue.getJob(retried.id as string))?.attemptsMade).toBe(1);
    await retried.remove();
  });
});
