import { Worker } from "bullmq";
import "../modules/jobs";
import { closeDb } from "../db/client";
import { errorData, logger } from "../lib/log";
import {
  closeQueues,
  getJob,
  listJobs,
  QUEUE_CONCURRENCY,
  QUEUE_NAMES,
  redis,
} from "../lib/queues";
import { startOutboxRelay } from "./outbox-relay";

const log = logger("worker");

/*
 * One BullMQ Worker per queue. Jobs are dispatched by name to the definition registered with
 * `defineJob()` (src/lib/queues.ts). `src/modules/jobs.ts` imports every module's jobs.ts so the
 * registry is complete before the workers start. The outbox relay runs in this process too.
 */

const workers = QUEUE_NAMES.map((queue) => {
  const worker = new Worker(
    queue,
    async (job) => {
      const def = getJob(job.name);
      if (!def) throw new Error(`no handler registered for job ${job.name} on queue ${queue}`);
      const input = def.input.parse(job.data);
      return def.handler(input, job);
    },
    { connection: redis, concurrency: QUEUE_CONCURRENCY[queue] },
  );
  worker.on("failed", (job, err) =>
    log.error("job failed", {
      queue,
      job: job?.name,
      id: job?.id,
      attempts: job?.attemptsMade,
      ...errorData(err),
    }),
  );
  worker.on("completed", (job) => log.debug("job done", { queue, job: job.name, id: job.id }));
  return worker;
});

const stopRelay = startOutboxRelay();

log.info("worker started", {
  queues: QUEUE_NAMES.length,
  jobs: listJobs().map((j) => j.name),
});

async function shutdown(signal: string) {
  log.info("shutting down", { signal });
  stopRelay();
  await Promise.all(workers.map((w) => w.close()));
  await closeQueues();
  await closeDb();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
