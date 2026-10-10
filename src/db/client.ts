import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { env } from "../env";
import { initFieldEncryption } from "../lib/crypto";
import * as schema from "./schema";

/** App role (invai_app): RLS enforced. Every request-scoped query goes through withTenant(). */
export const appPool = new Pool({ connectionString: env.DATABASE_URL, max: 10 });
export const db = drizzle(appPool, { schema, casing: "snake_case" });

/** Owner role (invai): bypasses RLS. Only for migrations, seed, the outbox relay and cross-tenant jobs. */
export const systemPool = new Pool({ connectionString: env.MIGRATION_DATABASE_URL, max: 4 });
export const systemDb = drizzle(systemPool, { schema, casing: "snake_case" });

export type Db = typeof db;
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const afterCommitHooks = new WeakMap<object, Array<() => void | Promise<void>>>();

/**
 * Register work to run after the enclosing transaction commits (realtime publishes, cache
 * invalidation). If `tx` is not one of ours the hook runs immediately.
 */
export function afterCommit(tx: Tx, fn: () => void | Promise<void>) {
  const hooks = afterCommitHooks.get(tx);
  if (hooks) hooks.push(fn);
  else
    void Promise.resolve()
      .then(fn)
      .catch((err) => console.error("afterCommit hook failed", err));
}

async function runHooks(tx: Tx) {
  const hooks = afterCommitHooks.get(tx) ?? [];
  afterCommitHooks.delete(tx);
  for (const hook of hooks) {
    try {
      await hook();
    } catch (err) {
      console.error("afterCommit hook failed", err);
    }
  }
}

type Runner = (tx: Tx) => Promise<unknown>;

async function scoped<T>(
  database: Db,
  settings: Record<string, string>,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  // Every encrypted column is read or written inside a scoped transaction, so awaiting the
  // memoized key-ring init here covers every entry point (api, worker, seed, evals, scripts).
  await initFieldEncryption();
  let txRef: Tx | null = null;
  const result = await database.transaction(async (tx) => {
    txRef = tx;
    afterCommitHooks.set(tx, []);
    for (const [key, value] of Object.entries(settings)) {
      // set_config(..., true) is transaction-local, so pooled connections never leak a tenant.
      await tx.execute(sql`select set_config(${key}, ${value}, true)`);
    }
    return fn(tx);
  });
  if (txRef) await runHooks(txRef);
  return result;
}

/**
 * Run `fn` in a transaction scoped to one company. RLS policies read `app.company_id`,
 * so queries inside can only see and write that company's rows.
 */
export function withTenant<T>(companyId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return scoped(db, { "app.company_id": companyId }, fn);
}

/**
 * Vendor portal scope: the vendor's own company plus `app.vendor_org_id`, which the
 * `*_vendor_read` policies use to expose the sheets shops shared with this vendor.
 */
export function withVendor<T>(vendorCompanyId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return scoped(
    db,
    { "app.company_id": vendorCompanyId, "app.vendor_org_id": vendorCompanyId },
    fn,
  );
}

/**
 * Owner connection, no RLS. For the outbox relay, seeding and cross-tenant jobs only.
 * Pass `companyId` when the work is for one company so tenant-scoped helpers still work.
 */
export function withSystem<T>(fn: (tx: Tx) => Promise<T>, companyId?: string): Promise<T> {
  return scoped(systemDb, companyId ? { "app.company_id": companyId } : {}, fn);
}

/** Convenience for tests and scripts: the same transaction typing for both roles. */
export type TxRunner = Runner;

export async function closeDb() {
  await Promise.all([appPool.end(), systemPool.end()]);
}
