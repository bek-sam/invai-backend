import type { EventName, EventPayload } from "@invai/contracts";
import type { Tx } from "../db/client";

/**
 * Write an event in the same transaction as the state change.
 * The relay (src/worker/outbox-relay.ts) moves committed rows into BullMQ.
 */
export async function emit<E extends EventName>(_tx: Tx, _name: E, _payload: EventPayload<E>) {
  // TODO: insert into outbox_events (id, company_id, name, payload, created_at)
}
