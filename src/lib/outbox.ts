import type { EventName, EventPayload } from "@invai/contracts";
import { Events } from "@invai/contracts";
import type { Tx } from "../db/client";
import { outboxEvents } from "../db/schema";
import { currentTraceparent } from "./tracing";

/**
 * Transactional outbox. `emit()` inserts the event in the same transaction as the state
 * change; the relay (src/worker/outbox-relay.ts) moves committed rows into BullMQ jobs.
 * An event is never lost on a crash and never fires for a rolled-back change.
 *
 * Event names and payload schemas come from `@invai/contracts` (`Events`). Unknown names are
 * allowed (typed as `string`) but known names are validated against their schema.
 *
 * With tracing on, the active span's `traceparent` goes on the row (`trace_parent`, T-32-5) so the
 * relay can enqueue the event's jobs inside the same trace. It is never part of `payload`.
 */
export function emit<E extends EventName>(
  tx: Tx,
  companyId: string,
  name: E,
  payload: EventPayload<E>,
): Promise<{ id: string }>;
export function emit(
  tx: Tx,
  companyId: string,
  name: string,
  payload: Record<string, unknown>,
): Promise<{ id: string }>;
export async function emit(
  tx: Tx,
  companyId: string,
  name: string,
  payload: Record<string, unknown>,
): Promise<{ id: string }> {
  const schema = (Events as Record<string, { parse: (v: unknown) => unknown }>)[name];
  const data = (schema ? schema.parse(payload) : payload) as Record<string, unknown>;
  const [row] = await tx
    .insert(outboxEvents)
    .values({ companyId, name, payload: data, traceParent: currentTraceparent() })
    .returning({ id: outboxEvents.id });
  if (!row) throw new Error("outbox insert returned no row");
  return row;
}

export type OutboxEvent = {
  id: string;
  companyId: string;
  name: string;
  payload: Record<string, unknown>;
  createdAt: Date;
};
