import type { Tx } from "../db/client";
import type { ActorKind } from "../db/schema";
import { auditLog } from "../db/schema";

/** Who did it. Built from the request context or from a job (`systemActor`). */
export type Actor = {
  kind: ActorKind;
  userId?: string | null;
  stationId?: string | null;
  ip?: string | null;
};

export const systemActor: Actor = { kind: "system" };

export type AuditInput = {
  companyId: string;
  actor: Actor;
  /** Dotted verb, e.g. `order_item.transition`, `station.create`, `pii.export`. */
  action: string;
  entityType?: string;
  entityId?: string | null;
  /** One line for the audit screen, e.g. "ready -> on_sheet". */
  summary?: string;
  data?: Record<string, unknown>;
};

/** Write one audit row inside the caller's transaction. */
export async function audit(tx: Tx, input: AuditInput) {
  await tx.insert(auditLog).values({
    companyId: input.companyId,
    actorKind: input.actor.kind,
    actorUserId: input.actor.userId ?? null,
    stationId: input.actor.stationId ?? null,
    action: input.action,
    entityType: input.entityType ?? null,
    entityId: input.entityId ?? null,
    summary: input.summary ?? input.action,
    data: input.data ?? {},
    ip: input.actor.ip ?? null,
  });
}
