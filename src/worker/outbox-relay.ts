import { and, asc, eq, gte, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { withSystem, withTenant } from "../db/client";
import { alerts, outboxEvents } from "../db/schema";
import { errorData, logger } from "../lib/log";
import {
  type DefinedJob,
  type OutboxEventRecord,
  queues,
  safeJobId,
  subscribersOf,
} from "../lib/queues";
import { raiseAlert } from "../modules/today/service";

const log = logger("outbox");

const POLL_MS = 500;
const BATCH = 100;
/** After this many failed dispatches an event is parked (see `relayOnce`). */
export const MAX_ATTEMPTS = 10;
/** Dispatched rows are kept this long, then `purgeDispatchedOutbox` deletes them. */
export const OUTBOX_RETENTION_DAYS = 7;

/** A parked row: gave up after MAX_ATTEMPTS, still holds its error, waits for a redrive. */
const parked = () =>
  and(
    gte(outboxEvents.attempts, MAX_ATTEMPTS),
    isNotNull(outboxEvents.lastError),
    isNotNull(outboxEvents.dispatchedAt),
  );

/**
 * The BullMQ id for one subscriber of one event (T-3-4 review fix). A job that defines its own
 * `jobId` keeps it, so two events mapping to the same input (the scrap-hash id, one design's QA)
 * collapse into one pending job instead of one per event. Once a job under that id has finished
 * it stays in Redis for a while (removeOnComplete/removeOnFail), and re-adding the id would be
 * silently dropped; a later event must still run, so it falls back to `${eventId}:${jobName}`,
 * which also keeps a re-relayed event from enqueueing twice. Jobs without their own id always use
 * the event-scoped id. Handlers stay idempotent in the database either way (idempotent-job).
 */
export async function relayJobId(
  job: DefinedJob<unknown>,
  input: unknown,
  eventId: string,
): Promise<string> {
  const eventScoped = `${eventId}:${job.name}`;
  if (!job.jobId) return eventScoped;
  const own = job.jobId(job.input.parse(input));
  const existing = await queues[job.queue].getJob(safeJobId(own));
  if (!existing) return own;
  const state = await existing.getState();
  return state === "completed" || state === "failed" ? eventScoped : own;
}

/**
 * Moves committed outbox rows into BullMQ. Runs as the owner (no RLS) because events span
 * every company. `FOR UPDATE SKIP LOCKED` lets several relays run side by side. Each event
 * fans out to its subscribers (lib/queues.ts `onEvent`) with the id from `relayJobId`, so a
 * re-relayed event cannot enqueue the same job twice. Events with no subscriber are
 * marked dispatched (nothing to do); after MAX_ATTEMPTS failures an event is parked with
 * `last_error` set and `dispatched_at` filled so it stops blocking the queue.
 */
export async function relayOnce(): Promise<number> {
  return withSystem(async (tx) => {
    const rows = await tx
      .select()
      .from(outboxEvents)
      .where(isNull(outboxEvents.dispatchedAt))
      .orderBy(asc(outboxEvents.createdAt))
      .limit(BATCH)
      .for("update", { skipLocked: true });

    let dispatched = 0;
    for (const row of rows) {
      const event: OutboxEventRecord = {
        id: row.id,
        companyId: row.companyId,
        name: row.name,
        payload: row.payload,
      };
      try {
        for (const sub of subscribersOf(row.name)) {
          const input = sub.map(event);
          if (input === null) continue;
          await sub.job.enqueue(input, { jobId: await relayJobId(sub.job, input, row.id) });
        }
        await tx
          .update(outboxEvents)
          .set({ dispatchedAt: new Date(), attempts: row.attempts + 1, lastError: null })
          .where(eq(outboxEvents.id, row.id));
        dispatched++;
      } catch (err) {
        const attempts = row.attempts + 1;
        log.error("dispatch failed", { id: row.id, name: row.name, attempts, ...errorData(err) });
        await tx
          .update(outboxEvents)
          .set({
            attempts,
            lastError: String(err),
            dispatchedAt: attempts >= MAX_ATTEMPTS ? new Date() : null,
          })
          .where(eq(outboxEvents.id, row.id));
      }
    }
    return dispatched;
  });
}

export function startOutboxRelay(): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const tick = async () => {
    if (stopped) return;
    try {
      const n = await relayOnce();
      if (n > 0) log.debug("relayed", { count: n });
      // Drain quickly while there is work, otherwise poll.
      timer = setTimeout(tick, n === BATCH ? 0 : POLL_MS);
    } catch (err) {
      log.error("relay tick failed", errorData(err));
      timer = setTimeout(tick, POLL_MS * 4);
    }
  };
  void tick();
  log.info("outbox relay started");
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

/**
 * Deletes dispatched rows older than OUTBOX_RETENTION_DAYS, BATCH_DELETE rows per statement so no
 * single delete holds locks for long. Parked rows are kept until they are redriven.
 */
export async function purgeDispatchedOutbox(
  opts: { now?: Date; batch?: number; maxBatches?: number } = {},
) {
  const now = opts.now ?? new Date();
  const batch = opts.batch ?? 5_000;
  const maxBatches = opts.maxBatches ?? 200;
  const cutoff = new Date(now.getTime() - OUTBOX_RETENTION_DAYS * 86_400_000);
  let deleted = 0;
  for (let i = 0; i < maxBatches; i++) {
    const n = await withSystem(async (tx) => {
      const res = await tx.execute(sql`
        delete from outbox_events where id in (
          select id from outbox_events
          where dispatched_at is not null and dispatched_at < ${cutoff}
            and attempts < ${MAX_ATTEMPTS}
          limit ${batch}
        )`);
      return res.rowCount ?? 0;
    });
    deleted += n;
    if (n < batch) break;
  }
  if (deleted) log.info("purged dispatched outbox rows", { deleted });
  return { deleted };
}

/** Parked rows for the DLQ view (ids, names and errors only; payloads may carry PII). */
export async function parkedOutbox(limit = 100) {
  return withSystem(async (tx) => {
    const rows = await tx
      .select({
        id: outboxEvents.id,
        companyId: outboxEvents.companyId,
        name: outboxEvents.name,
        attempts: outboxEvents.attempts,
        lastError: outboxEvents.lastError,
        createdAt: outboxEvents.createdAt,
        parkedAt: outboxEvents.dispatchedAt,
      })
      .from(outboxEvents)
      .where(parked())
      .orderBy(asc(outboxEvents.createdAt))
      .limit(limit);
    const [count] = await tx
      .select({ n: sql<number>`count(*)`.mapWith(Number) })
      .from(outboxEvents)
      .where(parked());
    return { count: count?.n ?? 0, rows };
  });
}

/**
 * Raises one `outbox_parked` alert per parked event, on the event's company (dedupe key = event
 * id). A row that already has its alert is skipped, even if someone resolved it, so the sweep
 * doesn't re-fire it every tick.
 */
export async function alertParkedOutbox(limit = 100) {
  const rows = await withSystem((tx) =>
    tx
      .select({
        id: outboxEvents.id,
        companyId: outboxEvents.companyId,
        name: outboxEvents.name,
        attempts: outboxEvents.attempts,
      })
      .from(outboxEvents)
      .leftJoin(
        alerts,
        and(
          eq(alerts.companyId, outboxEvents.companyId),
          eq(alerts.dedupeKey, sql`'outbox_parked:' || ${outboxEvents.id}::text`),
        ),
      )
      .where(and(parked(), isNull(alerts.id)))
      .limit(limit),
  );
  let raised = 0;
  for (const r of rows) {
    try {
      const res = await withTenant(r.companyId, (tx) =>
        raiseAlert(tx, r.companyId, {
          kind: "outbox_parked",
          severity: "critical",
          title: "A background step stopped after repeated failures",
          message: `The "${r.name}" step failed ${r.attempts} times and was set aside. Our team can re-run it once the cause is fixed.`,
          dedupeKey: `outbox_parked:${r.id}`,
          data: { eventId: r.id, event: r.name, attempts: r.attempts },
        }),
      );
      if (res.created) raised++;
      log.error("outbox event parked", { companyId: r.companyId, id: r.id, name: r.name });
    } catch (err) {
      log.error("could not raise outbox_parked alert", { id: r.id, ...errorData(err) });
    }
  }
  return { parked: rows.length, raised };
}

/**
 * Puts parked rows back in the relay's queue (`dispatched_at` null, attempts reset). Only safe
 * because every subscriber is idempotent (research 11 §3.1): a handler that already ran for the
 * event sees its own effect and does nothing. `olderThanMinutes` limits it to rows created at
 * least that long ago.
 */
export async function redriveParkedOutbox(opts: { olderThanMinutes?: number } = {}) {
  const where =
    opts.olderThanMinutes !== undefined
      ? and(
          parked(),
          lt(outboxEvents.createdAt, new Date(Date.now() - opts.olderThanMinutes * 60_000)),
        )
      : parked();
  const rows = await withSystem((tx) =>
    tx
      .update(outboxEvents)
      .set({ dispatchedAt: null, attempts: 0 })
      .where(where)
      .returning({ id: outboxEvents.id }),
  );
  log.warn("parked outbox rows redriven", { reset: rows.length });
  return { reset: rows.length };
}

/** Backlog metrics for /health and the admin view. */
export async function outboxBacklog() {
  return withSystem(async (tx) => {
    const [row] = await tx
      .select({
        pending: sql<number>`count(*) filter (where dispatched_at is null)`.mapWith(Number),
        stale:
          sql<number>`count(*) filter (where dispatched_at is null and created_at < now() - interval '1 minute')`.mapWith(
            Number,
          ),
      })
      .from(outboxEvents)
      .where(lt(outboxEvents.attempts, MAX_ATTEMPTS));
    return row ?? { pending: 0, stale: 0 };
  });
}
