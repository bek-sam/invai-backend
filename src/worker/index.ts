import { Worker } from "bullmq";
import "../modules/jobs";
import { closeDb } from "../db/client";
import { errorData, logger } from "../lib/log";
import {
  closeQueues,
  getJob,
  listJobs,
  processJob,
  QUEUE_CONCURRENCY,
  QUEUE_NAMES,
  redis,
} from "../lib/queues";
import { withShutdownCap } from "../lib/shutdown-timeout";
import { onJobFailed } from "./job-failures";
import { startOutboxRelay } from "./outbox-relay";
import "./sweeps";

const log = logger("worker");

/*
 * One BullMQ Worker per queue. Jobs are dispatched by name to the definition registered with
 * `defineJob()` (src/lib/queues.ts). `src/modules/jobs.ts` imports every module's jobs.ts so the
 * registry is complete before the workers start. The outbox relay runs in this process too.
 */

const workers = QUEUE_NAMES.map((queue) => {
  const worker = new Worker(
    queue,
    // Dispatch by name; input that fails the job's schema fails it for good (no retries).
    processJob,
    { connection: redis, concurrency: QUEUE_CONCURRENCY[queue] },
  );
  worker.on("failed", (job, err) => {
    log.error("job failed", {
      queue,
      job: job?.name,
      id: job?.id,
      attempts: job?.attemptsMade,
      final: !!job?.finishedOn,
      ...errorData(err),
    });
    void onJobFailed(job ? getJob(job.name) : undefined, job, err);
  });
  worker.on("stalled", (id) => log.warn("job stalled; it will run again", { queue, id }));
  worker.on("completed", (job) => log.debug("job done", { queue, job: job.name, id: job.id }));
  return worker;
});

const stopRelay = startOutboxRelay();

log.info("worker started", {
  queues: QUEUE_NAMES.length,
  jobs: listJobs().map((j) => j.name),
});

/**
 * Graceful SIGTERM/SIGINT (T-12-2, B-16). `worker.close()` (no `force` arg) waits for each
 * worker's active job to finish before resolving -- it does not cap how long that takes. Race it
 * against SHUTDOWN_CAP_MS so a job stuck past a deploy's real stop-timeout budget can't hang the
 * process forever: below the cap the job keeps running untouched; at the cap this force-exits
 * with jobs still active rather than waiting longer.
 */
const SHUTDOWN_CAP_MS = 20_000;

async function shutdown(signal: string) {
  log.info("shutting down", { signal, capMs: SHUTDOWN_CAP_MS });
  stopRelay();

  const closing = Promise.all(workers.map((w) => w.close())).catch((err) =>
    log.error("worker close failed", errorData(err)),
  );
  const closedInTime = await withShutdownCap(closing, SHUTDOWN_CAP_MS);

  if (!closedInTime) {
    log.warn("shutdown cap elapsed; forcing exit with a job still active", {
      signal,
      capMs: SHUTDOWN_CAP_MS,
    });
    process.exit(1);
  }

  await closeQueues();
  await closeDb();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
