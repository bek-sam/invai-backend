import { createHash, timingSafeEqual } from "node:crypto";
import { type Context, Hono, type Next } from "hono";
import { z } from "zod";
import { env } from "../env";
import { errorData, logger } from "../lib/log";
import { QUEUE_NAMES, queues } from "../lib/queues";
import { parkedOutbox, redriveParkedOutbox } from "../worker/outbox-relay";

/*
 * Internal-only operations routes (T-12-1, wave 12 stub A): the dead-letter view and redrive.
 * Not oRPC tenant procedures: BullMQ's failed sets and parked outbox rows span every company, and
 * there is no platform-admin session. Every route needs `X-Internal-Token` equal to
 * env.INTERNAL_ADMIN_TOKEN (never shipped to a browser); anything else, including an unset token,
 * gets the same 404 as an unknown path, so the routes can't be discovered.
 *
 *   curl -H "X-Internal-Token: $INTERNAL_ADMIN_TOKEN" localhost:3000/internal/dlq/failed?queue=sync
 */

const log = logger("api.internal");

const digest = (s: string) => createHash("sha256").update(s).digest();

function tokenMatches(given: string | undefined): boolean {
  const expected = env.INTERNAL_ADMIN_TOKEN;
  if (!expected || !given) return false;
  return timingSafeEqual(digest(given), digest(expected));
}

const notFound = (c: Context) => c.json({ error: "not found" }, 404);

async function requireToken(c: Context, next: Next) {
  if (!tokenMatches(c.req.header("X-Internal-Token"))) return notFound(c);
  await next();
}

const QueueParam = z.enum(QUEUE_NAMES);
const Redrive = z.object({ queue: QueueParam, jobIds: z.array(z.string().min(1)).min(1).max(500) });
const RedriveOutbox = z.object({ olderThanMinutes: z.number().int().min(0).optional() });

async function body<T>(c: Context, schema: z.ZodType<T>): Promise<T | null> {
  const raw = await c.req.json().catch(() => null);
  const parsed = schema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : null;
}

export const internal = new Hono();
internal.use("*", requireToken);

/** Failed (dead-lettered) jobs of one queue, newest first, plus parked outbox rows. */
internal.get("/dlq/failed", async (c) => {
  const queue = QueueParam.safeParse(c.req.query("queue"));
  if (!queue.success)
    return c.json({ error: `queue must be one of ${QUEUE_NAMES.join(", ")}` }, 400);
  const failed = await queues[queue.data].getFailed(0, 199);
  const jobs = failed.map((j) => {
    const data = (j.data ?? {}) as { companyId?: unknown };
    return {
      id: j.id ?? null,
      name: j.name,
      companyId: typeof data.companyId === "string" ? data.companyId : null,
      attemptsMade: j.attemptsMade,
      failedReason: j.failedReason ?? null,
      timestamp: j.finishedOn ?? j.timestamp,
    };
  });
  const outbox = await parkedOutbox();
  return c.json({ queue: queue.data, jobs, parkedOutbox: outbox });
});

/** Re-runs failed jobs by id (`job.retry()`): ids not in the failed set come back in `notFound`. */
internal.post("/dlq/redrive", async (c) => {
  const input = await body(c, Redrive);
  if (!input) return c.json({ error: "expected { queue, jobIds: string[] }" }, 400);
  const retried: string[] = [];
  const notFound: string[] = [];
  for (const id of input.jobIds) {
    const job = await queues[input.queue].getJob(id);
    if (!job || (await job.getState()) !== "failed") {
      notFound.push(id);
      continue;
    }
    try {
      await job.retry("failed", { resetAttemptsMade: true });
      retried.push(id);
    } catch (err) {
      log.warn("redrive failed", { queue: input.queue, id, ...errorData(err) });
      notFound.push(id);
    }
  }
  log.warn("dlq redrive", {
    queue: input.queue,
    retried: retried.length,
    notFound: notFound.length,
  });
  return c.json({ retried, notFound });
});

/**
 * Puts parked outbox rows back in the relay (dispatched_at null). Safe only because every outbox
 * subscriber is idempotent (research 11 §3.1): a handler that already ran sees its own effect and
 * does nothing, so re-relaying an event can't double-charge, double-ship or double-count.
 */
internal.post("/dlq/redrive-outbox", async (c) => {
  const input = await body(c, RedriveOutbox);
  if (!input) return c.json({ error: "expected { olderThanMinutes?: number }" }, 400);
  return c.json(await redriveParkedOutbox(input));
});

internal.all("*", notFound);
