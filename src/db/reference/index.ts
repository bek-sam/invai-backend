import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { plans, trademarkMarks } from "../schema";
import { normalizeMark, TRADEMARK_MARKS } from "./trademarks";

/*
 * Global reference data: rows every tenant relies on but no tenant owns, and that a fresh
 * production database needs before its first sign-up (the trademark check, the plan catalog).
 * `ensureReferenceData` runs at the end of `runMigrations` (src/db/migrate.ts), so `pnpm
 * db:migrate` alone leaves it working - no seed step required. It creates no companies, no
 * users, no tenant rows of any kind, and is safe to run on every deploy: every row is an
 * upsert keyed on a natural key (`plans.key`, `(trademark_marks.normalized, kind)`), so running
 * it twice changes nothing the second time.
 *
 * Bump this when the shipped dataset changes materially (a new brand list, a schema-visible
 * change to how marks are scored). It has no schema column of its own; it is recorded here and
 * in the `source` written to `trademark_marks` for anyone reading the table.
 */
export const REFERENCE_DATA_VERSION = "2026-09-24.1";

const excluded = (column: string) => sql.raw(`excluded.${column}`);

async function ensurePlanCatalog(db: NodePgDatabase): Promise<void> {
  // Deferred: keeps this module (and `runMigrations`, which calls `ensureReferenceData`)
  // importable without pulling in the full env schema until the function actually runs, the
  // same reason src/db/migrate.ts imports `env` dynamically instead of at the top of the file.
  const { PLAN_CATALOG } = await import("../../modules/billing/service");
  await db
    .insert(plans)
    .values(PLAN_CATALOG)
    .onConflictDoUpdate({
      target: plans.key,
      set: {
        name: excluded("name"),
        priceMonthlyCents: excluded("price_monthly_cents"),
        ordersPerMonth: excluded("orders_per_month"),
        aiCreditsPerMonth: excluded("ai_credits_per_month"),
        labelFeeCents: excluded("label_fee_cents"),
        maxUsers: excluded("max_users"),
        maxConnections: excluded("max_connections"),
        updatedAt: new Date(),
      },
    });
}

async function ensureTrademarkMarks(db: NodePgDatabase): Promise<void> {
  const rows = TRADEMARK_MARKS.map((m) => ({
    mark: m.mark,
    normalized: normalizeMark(m.mark),
    owner: m.owner,
    kind: m.kind,
    status: "live" as const,
    classes: [25],
    serialNo: null,
    source: `reference:${REFERENCE_DATA_VERSION}`,
  }));
  await db
    .insert(trademarkMarks)
    .values(rows)
    .onConflictDoUpdate({
      target: [trademarkMarks.normalized, trademarkMarks.kind],
      set: {
        mark: excluded("mark"),
        owner: excluded("owner"),
        status: excluded("status"),
        classes: excluded("classes"),
        serialNo: excluded("serial_no"),
        source: excluded("source"),
      },
    });
}

/**
 * Upsert every global reference table. Idempotent and side-effect-free beyond those tables:
 * creates no tenants. Call with the owner-role `db` handle used for migrations.
 */
export async function ensureReferenceData(db: NodePgDatabase): Promise<void> {
  await ensurePlanCatalog(db);
  await ensureTrademarkMarks(db);
}
