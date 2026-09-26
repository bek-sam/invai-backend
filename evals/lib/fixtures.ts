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
