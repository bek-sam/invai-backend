import { and, inArray, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { withSystem, withTenant } from "../db/client";
import { aiJobs, jobs } from "../db/schema";
import { env } from "../env";
import { errorData, logger } from "../lib/log";
import {
  defineJob,
  LIVE_JOB_STATES,
  QUEUE_NAMES,
  type QueueName,
  queues,
  redis,
} from "../lib/queues";
import { publish } from "../lib/realtime";
import { raiseAlert } from "../modules/today/service";
import { alertParkedOutbox, purgeDispatchedOutbox } from "./outbox-relay";

/*
 * Cross-tenant reliability sweeps (T-12-1, B-17). They run in the worker on the `reports` queue:
 *   - failed-job spikes per queue  -> `queue_failed_spike` alert, once per spike
 *   - parked outbox events         -> `outbox_parked` alert, once per event (outbox-relay.ts)
 *   - `jobs` rows left queued/running with no live BullMQ job -> failed + `job.progress`
 *   - `ai_jobs` rows left running by a process that died -> failed
 *   - daily: purge dispatched outbox rows older than 7 days
 * Alerts are in-app `alerts` rows only; paging (CloudWatch/PagerDuty) is deferred to waves 10/11.
 */

const log = logger("worker.sweeps");

export const SWEEP_EVERY_MS = 5 * 60_000;
/** Failed-count growth window and threshold for `queue_failed_spike`. */
export const FAILED_SPIKE_WINDOW_MS = 15 * 60_000;
export const FAILED_SPIKE_THRESHOLD = 25;
/** A `jobs` row untouched this long, with no live BullMQ job, is abandoned. */
export const STUCK_JOB_MS = 30 * 60_000;
/** An `ai_jobs` row still running after this long lost its process (calls time out far sooner). */
export const STUCK_AI_JOB_MS = 30 * 60_000;
/** Above this many live jobs in one queue the stuck-row sweep can't prove a row is orphaned. */
const LIVE_SCAN_CAP = 10_000;
const STUCK_BATCH = 200;

const spikeKey = (queue: QueueName) => `dlq:spike:${queue}`;

/**
 * Raises `queue_failed_spike` when a queue's failed set gained FAILED_SPIKE_THRESHOLD or more jobs
 * in the last FAILED_SPIKE_WINDOW_MS. A Valkey flag marks the spike as open while the growth stays
 * above the threshold (refreshed each tick), so one spike alerts once, not once per failed job or
 * per tick; the next spike after it closes alerts again. Failed jobs carry their company in
 * `data.companyId`, and each affected company gets the alert (alerts are tenant rows).
 */
export async function checkFailedSpikes(
  opts: { now?: number; threshold?: number; queueNames?: readonly QueueName[] } = {},
) {
  const now = opts.now ?? Date.now();
  const threshold = opts.threshold ?? FAILED_SPIKE_THRESHOLD;
  const since = now - FAILED_SPIKE_WINDOW_MS;
  const ttl = Math.ceil(FAILED_SPIKE_WINDOW_MS / 1000);
  const spikes: { queue: QueueName; failed: number; alerted: number }[] = [];
  for (const name of opts.queueNames ?? QUEUE_NAMES) {
    const queue = queues[name];
    // The failed set is a sorted set scored by the time each job failed for good.
    const failed = await redis.zcount(queue.toKey("failed"), since, "+inf");
    if (failed < threshold) continue;
    const opened = await redis.set(spikeKey(name), String(now), "EX", ttl, "NX");
    if (opened !== "OK") {
      await redis.expire(spikeKey(name), ttl);
      continue;
    }
    const recent = (await queue.getFailed(0, 499)).filter((j) => (j.finishedOn ?? 0) >= since);
    const perCompany = new Map<string, number>();
    for (const j of recent) {
      const c = z.object({ companyId: z.uuid() }).safeParse(j.data);
      if (c.success) perCompany.set(c.data.companyId, (perCompany.get(c.data.companyId) ?? 0) + 1);
    }
    log.error("failed-job spike", { queue: name, failed, companies: perCompany.size });
    let alerted = 0;
    for (const [companyId, count] of perCompany) {
      try {
        await withTenant(companyId, (tx) =>
          raiseAlert(tx, companyId, {
            kind: "queue_failed_spike",
            severity: "critical",
            title: "Background work is failing more than usual",
            message: `${count} background ${name} jobs for this workspace failed in the last 15 minutes. We're looking into it; nothing is lost and failed jobs can be re-run.`,
            dedupeKey: `queue_failed_spike:${name}:${now}`,
            data: {
              queue: name,
              failed,
              companyFailed: count,
              since: new Date(since).toISOString(),
            },
          }),
        );
        alerted++;
      } catch (err) {
        log.error("could not raise queue_failed_spike", {
          companyId,
          queue: name,
          ...errorData(err),
        });
      }
    }
    spikes.push({ queue: name, failed, alerted });
  }
  return { spikes };
}

/** `jobs` row ids a live (not yet finished) BullMQ job points at, or null if too many to scan. */
async function liveJobRowIds(): Promise<Set<string> | null> {
  const ids = new Set<string>();
  const Ref = z.object({
    jobId: z.string().nullish(),
    importRunId: z.string().nullish(),
    jobRowId: z.string().nullish(),
  });
  for (const name of QUEUE_NAMES) {
    const queue = queues[name];
    const counts = await queue.getJobCounts(...LIVE_JOB_STATES);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    if (total > LIVE_SCAN_CAP) {
      log.warn("stuck-job sweep skipped: too many live jobs to scan", { queue: name, total });
      return null;
    }
    if (!total) continue;
    for (const j of await queue.getJobs([...LIVE_JOB_STATES], 0, -1)) {
      const ref = Ref.safeParse(j?.data);
      if (!ref.success) continue;
      for (const id of [ref.data.jobId, ref.data.importRunId, ref.data.jobRowId])
        if (id) ids.add(id);
    }
  }
  return ids;
}

/**
 * Marks `jobs` rows (every JOB_KINDS) failed when they sat queued/running for STUCK_JOB_MS with no
 * live BullMQ job behind them: the enqueue was lost or the job was removed. Sends the same
 * `job.progress` event the worker sends on a final failure (worker/job-failures.ts), so an open
 * screen stops spinning.
 */
export async function sweepStuckJobRows(now = new Date()) {
  const cutoff = new Date(now.getTime() - STUCK_JOB_MS);
  const candidates = await withSystem((tx) =>
    tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(inArray(jobs.status, ["queued", "running"]), lt(jobs.updatedAt, cutoff)))
      .limit(STUCK_BATCH),
  );
  if (!candidates.length) return { failed: 0 };
  const live = await liveJobRowIds();
  if (!live) return { failed: 0, skipped: true };
  const orphans = candidates.map((c) => c.id).filter((id) => !live.has(id));
  if (!orphans.length) return { failed: 0 };
  const error =
    "This job stopped without finishing (the background worker lost it). Start it again.";
  const rows = await withSystem((tx) =>
    tx
      .update(jobs)
      .set({ status: "failed", progress: 1, error, finishedAt: now })
      .where(
        and(
          inArray(jobs.id, orphans),
          inArray(jobs.status, ["queued", "running"]),
          lt(jobs.updatedAt, cutoff),
        ),
      )
      .returning(),
  );
  for (const row of rows) {
    log.warn("abandoned job row marked failed", {
      companyId: row.companyId,
      jobRowId: row.id,
      kind: row.kind,
    });
    await publish(row.companyId, "job.progress", {
      jobId: row.id,
      kind: row.kind,
      status: row.status,
      progress: row.progress,
      message: row.message,
      resultIds: row.resultIds,
    }).catch((err) => log.warn("could not publish job.progress", errorData(err)));
  }
  return { failed: rows.length };
}

/**
 * `ai_jobs` rows are written around one gateway call inside a request or job; if that process
 * dies the row stays `running`. Past STUCK_AI_JOB_MS it is marked failed. There is no BullMQ job
 * behind an ai_jobs row, and it is not a user-visible `Job`, so no realtime event is sent.
 */
export async function sweepStuckAiJobs(now = new Date()) {
  const cutoff = new Date(now.getTime() - STUCK_AI_JOB_MS);
  const rows = await withSystem((tx) =>
    tx
      .update(aiJobs)
      .set({
        status: "failed",
        error: "abandoned: the process running this AI call stopped",
        finishedAt: now,
      })
      .where(
        and(
          inArray(aiJobs.status, ["queued", "running"]),
          lt(sql`coalesce(${aiJobs.startedAt}, ${aiJobs.createdAt})`, cutoff),
        ),
      )
      .returning({ id: aiJobs.id, companyId: aiJobs.companyId }),
  );
  for (const r of rows)
    log.warn("abandoned ai job marked failed", { companyId: r.companyId, id: r.id });
  return { failed: rows.length };
}

async function step<T>(name: string, fn: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await fn();
  } catch (err) {
    log.error("sweep step failed", { step: name, ...errorData(err) });
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** Every SWEEP_EVERY_MS: one pass of every sweep; one failing step doesn't stop the others. */
export const reliabilitySweepJob = defineJob({
  queue: "reports",
  name: "platform.reliabilitySweep",
  input: z.object({}).passthrough(),
  options: { attempts: 1 },
  handler: async () => ({
    spikes: await step("failedSpikes", () => checkFailedSpikes()),
    parked: await step("outboxParked", () => alertParkedOutbox()),
    jobs: await step("stuckJobs", () => sweepStuckJobRows()),
    aiJobs: await step("stuckAiJobs", () => sweepStuckAiJobs()),
  }),
});

/** Daily: delete dispatched outbox rows past their 7-day retention, in batches. */
export const outboxPurgeJob = defineJob({
  queue: "reports",
  name: "platform.outboxPurge",
  input: z.object({}).passthrough(),
  handler: async () => purgeDispatchedOutbox(),
});

/** Idempotent: registers both sweeps (worker only). */
export async function scheduleSweeps() {
  await queues.reports.upsertJobScheduler(
    "platform-reliability-sweep",
    { every: SWEEP_EVERY_MS },
    { name: reliabilitySweepJob.name, data: {} },
  );
  await queues.reports.upsertJobScheduler(
    "platform-outbox-purge",
    { pattern: "35 4 * * *", tz: "UTC" },
    { name: outboxPurgeJob.name, data: {} },
  );
}

if (!env.isTest) {
  scheduleSweeps().catch((err) =>
    log.warn("could not register the sweep schedulers", errorData(err)),
  );
}
