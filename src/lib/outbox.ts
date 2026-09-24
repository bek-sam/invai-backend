import type { EventName, EventPayload } from "@invai/contracts";
import { Events } from "@invai/contracts";
import type { Tx } from "../db/client";
import { outboxEvents } from "../db/schema";

/**
 * Transactional outbox. `emit()` inserts the event in the same transaction as the state
 * change; the relay (src/worker/outbox-relay.ts) moves committed rows into BullMQ jobs.
 * An event is never lost on a crash and never fires for a rolled-back change.
 *
 * Event names and payload schemas come from `@invai/contracts` (`Events`). Unknown names are
 * allowed (typed as `string`) but known names are validated against their schema.
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
    .values({ companyId, name, payload: data })
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
