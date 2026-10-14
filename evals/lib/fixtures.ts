import { eq } from "drizzle-orm";
import { withSystem } from "../../src/db/client";
import { aiCreditLedger, companies } from "../../src/db/schema";
import { periodOf } from "../../src/modules/billing/service";
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

/**
 * T-53-2 (A15): the `src/test` fixtures take no transaction, so a failure after `createCompany`
 * would orphan the company. Run the rest of the setup through this: on any throw it deletes the
 * company (everything cascades) and rethrows the original error.
 */
export async function withCompanyCleanup<T>(companyId: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    await deleteEvalTenant({ companyId, userId: "" }).catch((e) =>
      console.error(`Could not delete half-built eval tenant ${companyId}:`, e),
    );
    throw err;
  }
}

export async function createEvalTenant(
  opts: { failForTest?: boolean; name?: string } = {},
): Promise<EvalTenant> {
  const company = await createCompany({
    name: opts.name ?? `Eval harness ${new Date().toISOString()}`,
  });
  return withCompanyCleanup(company.id, () => seedEvalTenant(company.id, opts));
}

async function seedEvalTenant(
  companyId: string,
  opts: { failForTest?: boolean },
): Promise<EvalTenant> {
  const company = { id: companyId };
  const user = await createUser(company.id, "owner");
  if (opts.failForTest) throw new Error("failForTest: eval tenant setup failed");
  await createLocation(company.id);
  // A new company is on the trial plan (100 credits a month), fewer than one full run uses, so
  // the later routes failed with CREDITS_EXHAUSTED. A pack keeps every case about the route.
  await withSystem((tx) =>
    tx.insert(aiCreditLedger).values({
      companyId: company.id,
      kind: "pack",
      credits: 100_000,
      period: periodOf().key,
    }),
  );
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
