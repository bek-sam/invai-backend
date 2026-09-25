import { ORPCError } from "@orpc/server";
import { and, eq, isNull, type SQL, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { type CompanySettings, companies } from "../../db/schema";

/**
 * A sample workspace is a user's own demo company from tenancy.demo: `demoOwnerUserId IS NOT
 * NULL`, or one that was retired (reset / failed fill), which drops the owner link but keeps a
 * `settings.demoRetiredAt` marker. It never spends real money: every adapter factory (carrier,
 * marketplace, billing, supplier, mail) asks this and hands it the mock.
 *
 * `companies.demo` is NOT the test: the seeded Desert Bloom shop has `demo = true` and gets the
 * real behavior (plan limits, invite email, live adapters when keys are set).
 */
export type CompanyScope = { companyId: string };

/** The rule on a row already in hand (for a query that selected these two columns). */
export function isSampleRow(row: {
  demoOwnerUserId: string | null;
  settings: CompanySettings | null;
}): boolean {
  return row.demoOwnerUserId !== null || !!row.settings?.demoRetiredAt;
}

/** SQL filter on `companies` for real (not sample) companies, for cross-tenant sweeps. */
export function realCompanySql(): SQL {
  return and(
    isNull(companies.demoOwnerUserId),
    sql`(${companies.settings}->>'demoRetiredAt') is null`,
  ) as SQL;
}

/** Contracts `DEMO_MODE` (403): a real-money action refused in a sample workspace. */
export function demoMode(message = "This is a sample shop: nothing here can be paid for") {
  return new ORPCError("DEMO_MODE", { status: 403, message });
}

/** Throws DEMO_MODE when the company is a sample workspace. */
export async function assertNotSampleWorkspace(companyId: string, message?: string) {
  if (await isSampleWorkspace(companyId)) throw demoMode(message);
}

/**
 * A company's sample status never flips: a real company is never linked to a demo owner, and a
 * retired demo keeps its marker. So a result is cached (bounded) and the guard costs one PK read
 * per company per process.
 */
const cache = new Map<string, boolean>();
const CACHE_MAX = 10_000;

export async function isSampleWorkspace(companyId: string): Promise<boolean> {
  const hit = cache.get(companyId);
  if (hit !== undefined) return hit;
  const [row] = await db
    .select({ demoOwnerUserId: companies.demoOwnerUserId, settings: companies.settings })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  const sample = !!row && isSampleRow(row);
  // An unknown id is not cached (it may be inserted in a moment).
  if (row) {
    if (cache.size >= CACHE_MAX) cache.clear();
    cache.set(companyId, sample);
  }
  return sample;
}

/** Tests only: forget cached answers. */
export function clearSampleWorkspaceCache() {
  cache.clear();
}
