import { type Job, type JobsOptions, Queue } from "bullmq";
import { Redis } from "ioredis";
import type { z } from "zod";
import { env } from "../env";
import { logger } from "./log";

const log = logger("queues");

/** BullMQ needs maxRetriesPerRequest: null. Redis must run with maxmemory-policy noeviction. */
export const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: false });
redis.on("error", (err) => log.error("redis error", { error: err.message }));

export const QUEUE_NAMES = ["sync", "render", "ship", "ai", "reports"] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

export const QUEUE_CONCURRENCY: Record<QueueName, number> = {
  sync: 10,
  render: 2,
  ship: 5,
  ai: 4,
  reports: 1,
};

const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 2_000 },
  removeOnComplete: { age: 24 * 3600, count: 5_000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

export const queues = Object.fromEntries(
  QUEUE_NAMES.map((name) => [
    name,
    new Queue(name, { connection: redis, defaultJobOptions: DEFAULT_JOB_OPTIONS }),
  ]),
) as Record<QueueName, Queue>;

/* ------------------------------------------------------------------------------------------
 * Job definitions. A module declares its jobs in `modules/<name>/jobs.ts`:
 *
 *   export const recomputeProfit = defineJob({
 *     queue: "reports",
 *     name: "finance.recomputeProfit",
 *     input: z.object({ companyId: Id, orderId: Id }),
 *     jobId: (i) => `recompute-profit:${i.orderId}`,     // idempotency key (optional)
 *     handler: async (input, job) => { ... },
 *   });
 *   onEvent("shipment.labeled", recomputeProfit, (e) => ({ companyId: e.companyId, orderId: e.payload.orderId }));
 *
 * `worker/index.ts` imports every module's jobs.ts so the registry is complete, then starts one
 * BullMQ Worker per queue that dispatches by job name. `recomputeProfit.enqueue(input)` adds a
 * job from anywhere; prefer emitting an outbox event from inside the transaction instead.
 * ---------------------------------------------------------------------------------------- */

export type JobHandler<I> = (input: I, job: Job<I>) => Promise<unknown>;

export type JobDefinition<I> = {
  queue: QueueName;
  name: string;
  input: z.ZodType<I>;
  handler: JobHandler<I>;
  jobId?: (input: I) => string;
  options?: JobsOptions;
};

export type DefinedJob<I> = JobDefinition<I> & {
  enqueue: (input: I, options?: JobsOptions) => Promise<Job<I>>;
};

const registry = new Map<string, DefinedJob<unknown>>();

export function defineJob<I>(def: JobDefinition<I>): DefinedJob<I> {
  if (registry.has(def.name)) throw new Error(`job ${def.name} is defined twice`);
  const job: DefinedJob<I> = {
    ...def,
    enqueue: (input, options) => {
      const data = def.input.parse(input);
      return queues[def.queue].add(def.name, data, {
        ...def.options,
        ...options,
        jobId: options?.jobId ?? def.jobId?.(data),
      }) as Promise<Job<I>>;
    },
  };
  registry.set(def.name, job as DefinedJob<unknown>);
  return job;
}

export function getJob(name: string): DefinedJob<unknown> | undefined {
  return registry.get(name);
}

export function listJobs(): DefinedJob<unknown>[] {
  return [...registry.values()];
}

/** Run a job the way the worker would (validates input). Handy in tests. */
export async function runJobInline<I>(job: DefinedJob<I>, input: I) {
  const data = job.input.parse(input);
  return job.handler(data, { id: "inline", name: job.name, data } as Job<I>);
}

/* ---- Outbox event subscriptions ------------------------------------------------------- */

export type OutboxEventRecord = {
  id: string;
  companyId: string;
  name: string;
  payload: Record<string, unknown>;
};

type Subscription = {
  job: DefinedJob<unknown>;
  /** Returns the job input, or null to skip this event. */
  map: (event: OutboxEventRecord) => unknown | null;
};

const subscriptions = new Map<string, Subscription[]>();

/**
 * Subscribe a job to an outbox event. The relay enqueues one job per subscription with
 * jobId `${eventId}:${jobName}`, so a re-relayed event cannot run a handler twice.
 * `map` turns the event into job input; return null to ignore the event.
 */
export function onEvent<I>(
  eventName: string,
  job: DefinedJob<I>,
  map: (event: OutboxEventRecord) => I | null = (e) => e.payload as I,
) {
  const list = subscriptions.get(eventName) ?? [];
  list.push({ job: job as DefinedJob<unknown>, map: map as Subscription["map"] });
  subscriptions.set(eventName, list);
}

export function subscribersOf(eventName: string): Subscription[] {
  return subscriptions.get(eventName) ?? [];
}

export async function closeQueues() {
  await Promise.all(Object.values(queues).map((q) => q.close()));
  redis.disconnect();
}
