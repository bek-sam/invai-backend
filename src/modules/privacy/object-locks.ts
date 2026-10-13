import { sql } from "drizzle-orm";
import type { Tx } from "../../db/client";

/** First key of the two-int advisory lock that guards one storage object (T-48-2). */
export const OBJECT_LOCK_CLASS = 48302;

/**
 * Take a transaction-scoped lock per storage key, in sorted order so two callers can't deadlock.
 * The buyer-data purge holds it from its reference check to its commit; `setItemArtwork` takes the
 * same lock before it points a unit at a file, so a file is either still referenced when the purge
 * looks, or already gone when the upload checks. Lock-only on purpose: no imports from other
 * modules, so orders and privacy can both use it without a cycle.
 */
export async function lockObjects(tx: Tx, keys: Iterable<string>): Promise<void> {
  for (const key of [...new Set(keys)].sort())
    await tx.execute(sql`select pg_advisory_xact_lock(${OBJECT_LOCK_CLASS}, hashtext(${key}))`);
}
