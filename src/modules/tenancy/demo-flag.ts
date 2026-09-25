import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import { companies } from "../../db/schema";

/**
 * True for a sample-data company (`companies.demo`): the per-user demo workspace from
 * tenancy.demo and the seeded demo shop. Such a company is left out of billing, never sends
 * email and only ever uses mock marketplace providers. `companies` has no RLS (Better Auth
 * table), so this reads it by id with the app role.
 */
export async function isDemoCompany(companyId: string): Promise<boolean> {
  const [row] = await db
    .select({ demo: companies.demo })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  return row?.demo ?? false;
}
