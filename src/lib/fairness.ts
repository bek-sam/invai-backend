import { DelayedError, type Job } from "bullmq";
import { logger } from "./log";
import { QUEUE_CONCURRENCY, type QueueName, redis } from "./queues";

const log = logger("fairness");

/*
 * Per-tenant job fairness (T-12-3, B-20). BullMQ Pro's "groups" (a fair per-group round robin,
 * with its own per-group concurrency) isn't installed -- only open-source `bullmq` is in the
 * lockfile, and adding `@taskforcesh/bullmq-pro` is an owner-track decision, not this wave's
 * (see wave.md "Fairness"). This is the free alternative:
 *
 *   1. A per-`{queue, companyId}` Valkey semaphore (this file): at most `cap` of one tenant's
 *      jobs run at once on one queue. A job over the cap re-delays itself (`moveToDelayed` +
 *      `DelayedError`) instead of occupying a worker slot or failing, so one shop's 3,000-row
 *      import can't starve another shop's single order sync on the same queue.
 *   2. Lower BullMQ `priority` for bulk job kinds (`csv_import`, batch AI, `reports`) so an
 *      interactive job (label buy, single render) enqueued after a bulk backlog is still picked
 *      up first: BullMQ priority 0 (the default -- no explicit priority) is dequeued before any
 *      explicitly prioritized job, whatever order they were added in.
 *
 * If a load test shows this isn't enough at higher tenant counts, sharding a hot queue by
 * `hash(companyId) % K` is the documented next step (wave.md) -- not built here.
 */

/**
 * Fallback cap for a queue `withFairness` doesn't recognize (a test queue name, for instance).
 * Real queues get a cap scaled off their own `QUEUE_CONCURRENCY` (`capForQueue` below) instead of
 * this flat number: a flat cap of 2 would, on `sync` (concurrency 10), throttle a single
 * uncontested tenant to 2 of 10 slots even with nobody else in the queue -- the load test in the
 * task report caught this (tenant B's own small backlog got slower, not just tenant A's).
 */
export const TENANT_CONCURRENCY_CAP = 2;

/**
 * A single tenant's cap on `queue`, scaled off that queue's real concurrency so the semaphore
 * protects OTHER tenants without needlessly throttling a lone one: always leaves at least one
 * slot free (so a second tenant's job is never stuck behind a full cap), but otherwise lets one
 * tenant use most of the queue when it's the only one in it. `render` (concurrency 2) still gets
 * cap 1 -- the minimum that leaves a slot free -- matching wave.md's "at most 2" example loosely
 * (that number was illustrative, not literal; a cap equal to the queue's total concurrency would
 * let one tenant occupy every slot, which defeats the point).
 */
export function capForQueue(queue: string): number {
  const concurrency = QUEUE_CONCURRENCY[queue as QueueName];
  if (!concurrency) return TENANT_CONCURRENCY_CAP;
  return Math.max(1, concurrency - 1);
}

/** How long a job that couldn't take a slot waits before the next attempt. */
export const FAIRNESS_RETRY_DELAY_MS = 250;

/** Slots expire on their own if a worker crashes before releasing (safety net, not the happy path). */
const SLOT_TTL_SEC = 300;

/** Bulk kinds (csv_import, batch AI, batch label buy) get this priority; interactive jobs keep the
 * default (0 = "no explicit priority", which BullMQ dequeues before any prioritized job). */
export const BULK_PRIORITY = 10;

function semaphoreKey(queue: string, companyId: string): string {
  return `sem:${queue}:${companyId}`;
}

/**
 * Add `member` to `queue`'s per-`companyId` slot set if it's under `cap`, or if it already holds
 * a slot (a re-delayed retry of the same job must not double-count). One EVAL: SISMEMBER +
 * SCARD + SADD would race across two workers checking the same count at once otherwise.
 */
const ACQUIRE_SCRIPT = `
local key = KEYS[1]
local member = ARGV[1]
local cap = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])

if redis.call('SISMEMBER', key, member) == 1 then
  redis.call('EXPIRE', key, ttl)
  return 1
end

if redis.call('SCARD', key) < cap then
  redis.call('SADD', key, member)
  redis.call('EXPIRE', key, ttl)
  return 1
end

return 0
`;

/**
 * Try to take one of `cap` concurrent slots for `{queue, companyId}`. Fails open (allowed) on a
 * Redis error: a stuck Valkey must not stall every tenant's jobs, only the fairness guarantee
 * between them.
 */
export async function acquireSlot(
  queue: string,
  companyId: string,
  member: string,
  cap = TENANT_CONCURRENCY_CAP,
): Promise<boolean> {
  const key = semaphoreKey(queue, companyId);
  try {
    const took = (await redis.eval(ACQUIRE_SCRIPT, 1, key, member, cap, SLOT_TTL_SEC)) as number;
    return took === 1;
  } catch (err) {
    log.warn("fairness semaphore check failed (allowing)", {
      queue,
      companyId,
      error: String(err),
    });
    return true;
  }
}

export async function releaseSlot(queue: string, companyId: string, member: string): Promise<void> {
  try {
    await redis.srem(semaphoreKey(queue, companyId), member);
  } catch (err) {
    log.warn("fairness semaphore release failed", { queue, companyId, error: String(err) });
  }
}

/** Slots currently held for `{queue, companyId}` (test/diagnostic use). */
export async function heldSlots(queue: string, companyId: string): Promise<number> {
  return redis.scard(semaphoreKey(queue, companyId));
}

/**
 * Wraps the worker's normal processor (`processJob`, src/lib/queues.ts) with the per-tenant
 * semaphore. Jobs with no `companyId` in their input (platform-wide sweeps) run unthrottled --
 * there's no tenant to be fair between.
 */
export function withFairness(
  companyIdOf: (job: Job) => string | undefined,
  process: (job: Job, token?: string) => Promise<unknown>,
) {
  return async function fairProcessJob(job: Job, token?: string): Promise<unknown> {
    const companyId = companyIdOf(job);
    if (!companyId) return process(job, token);

    const member = job.id ?? `${job.name}:${job.data ? JSON.stringify(job.data) : ""}`;
    const took = await acquireSlot(job.queueName, companyId, member, capForQueue(job.queueName));
    if (!took) {
      // Over the cap: re-delay rather than fail or hold a worker slot. `skipAttempt` (inside
      // moveToDelayed) means this never burns one of the job's real retry attempts.
      await job.moveToDelayed(Date.now() + FAIRNESS_RETRY_DELAY_MS, token);
      throw new DelayedError();
    }
    try {
      return await process(job, token);
    } finally {
      await releaseSlot(job.queueName, companyId, member);
    }
  };
}

/** `companyIdOf` for the common case: job input carries a plain `companyId` field. */
export function companyIdFromData(job: Job): string | undefined {
  const data = job.data as { companyId?: unknown } | null | undefined;
  return typeof data?.companyId === "string" ? data.companyId : undefined;
}
