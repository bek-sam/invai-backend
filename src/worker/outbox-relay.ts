import { asc, eq, isNull, lt, sql } from "drizzle-orm";
import { withSystem } from "../db/client";
import { outboxEvents } from "../db/schema";
import { errorData, logger } from "../lib/log";
import { type OutboxEventRecord, subscribersOf } from "../lib/queues";

const log = logger("outbox");

const POLL_MS = 500;
const BATCH = 100;
const MAX_ATTEMPTS = 10;

/**
 * Moves committed outbox rows into BullMQ. Runs as the owner (no RLS) because events span
 * every company. `FOR UPDATE SKIP LOCKED` lets several relays run side by side. Each event
 * fans out to its subscribers (lib/queues.ts `onEvent`) with jobId `${eventId}:${jobName}`,
 * so a re-relayed event cannot enqueue the same job twice. Events with no subscriber are
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
          await sub.job.enqueue(input, { jobId: `${row.id}:${sub.job.name}` });
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
