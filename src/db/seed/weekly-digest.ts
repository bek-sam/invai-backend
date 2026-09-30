import { type BuildResult, buildDigest } from "../../modules/digest/build";
import { lastCompleteWeek, localNow } from "../../modules/digest/week";
import { recomputeProfit } from "../../modules/finance/service";
import { withSystem, withTenant } from "../client";

/*
 * T-23-8 (B-207): a fresh seed had no weekly digest until the hourly `digest.sweep` job ran, so
 * `/digests` and the Today "week in review" card were empty right after `pnpm db:seed` and the
 * gate's digest specs failed. The seed now builds the demo shop's digest itself, the same way
 * `digest.sweep` would once the shop's local clock reached its send slot: work out the shop's
 * local "now" in Postgres (`src/modules/digest/week.ts`'s `localNow`, same as `dueShops` in
 * `src/modules/digest/jobs.ts`), take the last complete ISO week from it, then call the real
 * `buildDigest` for that week -- no rows are inserted by hand.
 *
 * `profit_lines` is normally filled by the async `finance.recompute` job, fired from the outbox
 * events the seed's own order-state transitions emit (`src/modules/finance/jobs.ts`). Those
 * events only flow once a worker is running to drain the (seed-held, then released) outbox --
 * which, in the normal `pnpm db:seed` order, is *after* the seed script has already exited. Built
 * here, before any worker exists, the digest's margin and on-time deltas would read every
 * order's profit as unmapped: `getProfit` (`src/modules/finance/service.ts`) reads straight from
 * `profit_lines`, and an empty table makes both weeks' margin `null`, so the change is `null`, so
 * the web app's Margin/On-time StatCard renders no delta at all -- not a rebuild-later problem,
 * since `buildDigest` never rebuilds a `ready` week (found the hard way in this card's own E2E
 * run, `digest-dates.spec.ts` AC2). So this recomputes profit synchronously first, the same
 * function the nightly `finance.recompute` job calls, scoped to every order the seed just made.
 *
 * Idempotent: `buildDigest` is idempotent on (company, week key) -- a `ready` or `skipped_quiet`
 * row is never rebuilt (`src/modules/digest/build.ts` `buildLocked`) -- so calling this twice for
 * the same shop and week returns the existing digest instead of creating a second one (AC2).
 * `recomputeProfit` is a plain upsert keyed on `(company_id, order_item_id)`, so re-running it is
 * also a no-op past the first call.
 */
export async function buildWeeklyDigest(
  companyId: string,
  timezone: string,
  at: Date = new Date(),
): Promise<BuildResult & { weekKey: string }> {
  await withTenant(companyId, (tx) => recomputeProfit(tx, { companyId }, {}));
  const local = await withSystem((tx) => localNow(tx, timezone, at));
  const { weekKey } = lastCompleteWeek(local.ymd);
  const result = await buildDigest(companyId, weekKey, at);
  return { weekKey, ...result };
}
