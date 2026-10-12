import { and, eq, gte, sql } from "drizzle-orm";
import { IMAGE_JOB_KIND } from "../../src/ai/images";
import { withSystem } from "../../src/db/client";
import { aiJobs } from "../../src/db/schema";

/*
 * The spend guard of the scene trial runner (T-37-2 AC4, T-38-2), kept apart from run.ts so a
 * test in src/ can pin it without starting the runner.
 */

/** Cents spent on image_scene calls since `since`, all tenants (the dev DB is one workspace). */
export async function ledgerCents(since: Date): Promise<number> {
  const [row] = await withSystem((tx) =>
    tx
      .select({ cents: sql<number>`coalesce(sum(${aiJobs.costCents}), 0)::int` })
      .from(aiJobs)
      .where(and(eq(aiJobs.kind, IMAGE_JOB_KIND), gte(aiJobs.createdAt, since))),
  );
  return row?.cents ?? 0;
}

/** Refuses when the ledger plus the worst case of the coming run would pass the budget. */
export function budgetVerdict(opts: {
  ledger: number;
  worstCase: number;
  budget: number;
}): { ok: boolean; reason: string } {
  const total = opts.ledger + opts.worstCase;
  return total > opts.budget
    ? {
        ok: false,
        reason: `ledger ${opts.ledger}c + worst case ${opts.worstCase}c = ${total}c exceeds the budget ${opts.budget}c`,
      }
    : {
        ok: true,
        reason: `ledger ${opts.ledger}c + worst case ${opts.worstCase}c <= ${opts.budget}c`,
      };
}
