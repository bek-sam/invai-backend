import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { env } from "../env";
import * as schema from "./schema";

export const db = drizzle(env.DATABASE_URL, { schema });

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Run `fn` inside a transaction scoped to one company. Row-level security policies
 * read `app.company_id`, so queries inside can only see that company's rows.
 * `set_config(..., true)` is transaction-local, which is safe with connection pooling.
 */
export function withTenant<T>(companyId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.company_id', ${companyId}, true)`);
    return fn(tx);
  });
}
