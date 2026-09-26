import {
  type BackoffOptions,
  type Job,
  type JobsOptions,
  type JobType,
  Queue,
  UnrecoverableError,
} from "bullmq";
import { Redis } from "ioredis";
import { z } from "zod";
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

/**
 * Share of each retry delay that is randomized (BullMQ `jitter`): a delay of D lands anywhere in
 * [D * (1 - JITTER), D], so jobs that failed together (a provider blip) don't retry in lockstep.
 */
export const BACKOFF_JITTER = 0.5;

export const DEFAULT_BACKOFF = {
  type: "exponential",
  delay: 2_000,
  jitter: BACKOFF_JITTER,
} as const satisfies BackoffOptions;

/**
 * Every job type retries with jitter (B-17). A job's own `backoff` (in `defineJob` options or at
 * enqueue) keeps its type and delay but gains the default jitter unless it sets one itself.
 */
export function withJitter(
  backoff: JobsOptions["backoff"] | undefined,
): JobsOptions["backoff"] | undefined {
  if (backoff === undefined) return undefined;
  if (typeof backoff === "number") return { type: "fixed", delay: backoff, jitter: BACKOFF_JITTER };
  return backoff.jitter === undefined ? { ...backoff, jitter: BACKOFF_JITTER } : backoff;
}

export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: DEFAULT_BACKOFF,
  removeOnComplete: { age: 24 * 3600, count: 5_000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

/**
 * The `reports` queue is entirely periodic sweeps and report generation (T-12-3, B-20): nothing
 * on it is a user waiting on a response, so every job there defaults to bulk priority (kept equal
 * to `lib/fairness.ts`'s `BULK_PRIORITY`; duplicated here rather than imported, to avoid a
 * `fairness.ts` <-> `queues.ts` import cycle). A job that sets its own `priority` (`defineJob`'s
 * `options`, or at `enqueue()`) still overrides this default via the per-call options merge below.
 */
const REPORTS_BULK_PRIORITY = 10;

export const queues = Object.fromEntries(
  QUEUE_NAMES.map((name) => [
    name,
    new Queue(name, {
      connection: redis,
      defaultJobOptions:
        name === "reports"
          ? { ...DEFAULT_JOB_OPTIONS, priority: REPORTS_BULK_PRIORITY }
          : DEFAULT_JOB_OPTIONS,
    }),
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
  /**
   * Runs in the worker when BullMQ gives up on the job for good, including failures the handler
   * never saw (stalled too often, bad input). Mark the module's own entity failed here; the
   * worker already marks the user-visible `jobs` row when the input carries `jobId`.
   */
  onFinalFailure?: (input: I, error: string) => Promise<void>;
};

export type DefinedJob<I> = JobDefinition<I> & {
  enqueue: (input: I, options?: JobsOptions) => Promise<Job<I>>;
};

const registry = new Map<string, DefinedJob<unknown>>();

/** BullMQ forbids ":" in custom ids; idempotency keys may still be written naturally. */
export const safeJobId = (id: string) => id.replace(/:/g, "_");

export function defineJob<I>(def: JobDefinition<I>): DefinedJob<I> {
  if (registry.has(def.name)) throw new Error(`job ${def.name} is defined twice`);
  const job: DefinedJob<I> = {
    ...def,
    enqueue: (input, options) => {
      const data = def.input.parse(input);
      const jobId = options?.jobId ?? def.jobId?.(data);
      const backoff = withJitter(options?.backoff ?? def.options?.backoff);
      return queues[def.queue].add(def.name, data, {
        ...def.options,
        ...options,
        ...(backoff ? { backoff } : {}),
        jobId: jobId ? safeJobId(jobId) : undefined,
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

/** Run a job the way the worker would (validates input). Handy in tests. `attempt` (1-based)
 * and `attempts` let a test play a retry: by default the inline run is the job's last attempt. */
export async function runJobInline<I>(
  job: DefinedJob<I>,
  input: I,
  run: { attempt?: number; attempts?: number } = {},
) {
  const data = job.input.parse(input);
  const attempts = run.attempts ?? 1;
  return job.handler(data, {
    id: "inline",
    name: job.name,
    data,
    opts: { attempts },
    attemptsMade: (run.attempt ?? attempts) - 1,
  } as Job<I>);
}

/* ---- Permanent failures ----------------------------------------------------------------- */

/**
 * Stop retrying: BullMQ fails the job at once (one attempt, not five) and it lands in the failed
 * set, where `/internal/dlq` lists and redrives it. Throw it for failures a retry can't fix:
 * Zod-invalid input, a provider's 4xx validation answer, a missing entity, revoked OAuth, a plan
 * limit. Record the reason on the entity first so a person can see it. Transient failures (5xx,
 * timeouts, 429, imaging down) throw a normal Error and retry with backoff.
 *
 *   if (res.status >= 400 && isPermanentHttpStatus(res.status))
 *     permanentFailure(`carrier rejected the address (${res.status})`);
 */
export function permanentFailure(reason: string): never {
  throw new UnrecoverableError(reason);
}

/** A 4xx a retry can't fix. 408 (timeout), 409 (conflict), 425 and 429 (rate limit) are transient. */
export function isPermanentHttpStatus(status: number): boolean {
  return status >= 400 && status < 500 && ![408, 409, 425, 429].includes(status);
}

/**
 * The worker parses job data with this: input that fails the job's schema can never succeed on a
 * retry, so it fails the job permanently instead of burning five attempts.
 */
export function parseJobInput<I>(def: Pick<JobDefinition<I>, "name" | "input">, data: unknown): I {
  const parsed = def.input.safeParse(data);
  if (parsed.success) return parsed.data;
  return permanentFailure(
    `invalid input for ${def.name}: ${z.prettifyError(parsed.error).slice(0, 500)}`,
  );
}

/**
 * The worker's processor: dispatch by job name to its `defineJob` definition, parse the input
 * (invalid input fails for good, see `parseJobInput`) and run the handler. A name with no handler
 * stays a normal (retried) error: during a rolling deploy an older worker may not know it yet.
 */
export async function processJob(job: Job): Promise<unknown> {
  const def = getJob(job.name);
  if (!def) throw new Error(`no handler registered for job ${job.name} on queue ${job.queueName}`);
  return def.handler(parseJobInput(def, job.data), job);
}

/** BullMQ states in which a job may still run (used to tell a live job from an abandoned row). */
export const LIVE_JOB_STATES = [
  "active",
  "waiting",
  "waiting-children",
  "delayed",
  "prioritized",
] as const satisfies readonly JobType[];

/** Backoff for jobs a person may be waiting on: exponential with jitter (research 11 G9). */
export const RETRY_BACKOFF = { type: "exponential", delay: 5_000, jitter: 0.5 } as const;

/**
 * True when this run is the job's last try: a handler records a permanent failure on its entity
 * (job row, item flag) only then, and otherwise throws so BullMQ retries with backoff.
 * `attemptsMade` counts finished failed attempts; a stalled (killed) run doesn't count.
 */
export function isFinalAttempt(job: Pick<Job, "attemptsMade" | "opts">): boolean {
  return (job.attemptsMade ?? 0) + 1 >= (job.opts?.attempts ?? 1);
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
 * Subscribe a job to an outbox event. The relay enqueues one job per subscription. A job with its
 * own `jobId` keeps it, so two events that map to the same input collapse into one pending job;
 * otherwise (or once that id's job has finished) the id is `${eventId}:${jobName}`, so a
 * re-relayed event does not enqueue the handler twice. See `worker/outbox-relay.ts`.
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
