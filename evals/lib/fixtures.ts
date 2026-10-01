import { eq } from "drizzle-orm";
import { withSystem } from "../../src/db/client";
import { companies } from "../../src/db/schema";
import { createCompany, createLocation, createUser } from "../../src/test/fixtures";

/*
 * The eval run needs one real, RLS-scoped tenant to call the gateway against (ai_jobs, the
 * credit ledger and — for the assistant tools — real withTenant queries all need a companyId).
 * It reuses the same fixtures the unit tests use rather than inventing a second way to make a
 * company. The company starts empty (no orders, no stock beyond the one default location the
 * assistant's `get_stock` tool requires — inventory/service.ts's `defaultLocationId` throws
 * "Create a location first" without one): the assistant cases below are written against that
 * known, deterministic zero-state, not against seeded demo numbers.
 */

export type EvalTenant = { companyId: string; userId: string };

export async function createEvalTenant(): Promise<EvalTenant> {
  const company = await createCompany({ name: `Eval harness ${new Date().toISOString()}` });
  const user = await createUser(company.id, "owner");
  await createLocation(company.id);
  return { companyId: company.id, userId: user.id };
}

/**
 * B-165: every company table's `companyId` cascades on delete (`db/schema/tenancy.ts`
 * `companyId()`), so one delete of the `companies` row removes everything the run created (users,
 * locations, ai_jobs, assistant conversations, …). `withSystem` because this is cross-tenant
 * cleanup, like the seed, not a request path. The caller runs this in a `finally`, so a throwaway
 * tenant isn't left behind on a failed or partial run (`evals/run.ts`).
 */
export async function deleteEvalTenant(tenant: EvalTenant): Promise<void> {
  await withSystem((tx) => tx.delete(companies).where(eq(companies.id, tenant.companyId)));
}
