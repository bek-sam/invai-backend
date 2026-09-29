import { and, eq, isNull } from "drizzle-orm";
import type { Tx } from "../client";
import { outboxEvents } from "../schema";

/*
 * The seed builder commits phase by phase (blanks, orders in batches of 20, sheets, shipments,
 * inventory, usage...) and every phase emits real outbox events through the services it calls.
 * A running worker's relay fans those events out at once, so its jobs (billing.recordSheetBuilt,
 * finance.recompute, market.computeSignals...) write derived rows for the half-built company while
 * later phases still insert the same rows plainly: that was B-106 (`stock_levels`, then `usage`).
 *
 * Holding parks a company's undispatched events (`dispatched_at` set, `last_error` = HELD marker)
 * at the end of each phase transaction, so the relay never sees them mid-build. Releasing puts
 * them back in the relay's queue in `created_at` order, which is exactly what a worker started
 * after the seed has always seen. Only rows carrying the marker are released.
 */
export const HELD_MARKER = "held: seeding in progress";

/** Park this company's pending events. Call inside the same transaction that emitted them. */
export async function holdOutbox(tx: Tx, companyId: string): Promise<number> {
  const rows = await tx
    .update(outboxEvents)
    .set({ dispatchedAt: new Date(), lastError: HELD_MARKER })
    .where(and(eq(outboxEvents.companyId, companyId), isNull(outboxEvents.dispatchedAt)))
    .returning({ id: outboxEvents.id });
  return rows.length;
}

/** Hand every held event back to the relay. */
export async function releaseOutbox(tx: Tx, companyId: string): Promise<number> {
  const rows = await tx
    .update(outboxEvents)
    .set({ dispatchedAt: null, lastError: null })
    .where(and(eq(outboxEvents.companyId, companyId), eq(outboxEvents.lastError, HELD_MARKER)))
    .returning({ id: outboxEvents.id });
  return rows.length;
}
