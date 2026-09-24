import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { env } from "../../env";
import { checkTrademarks } from "../../modules/ai/trademark";
import { runMigrations } from "../migrate";
import { ensureDatabase } from "../reset";
import * as schema from "../schema";

/*
 * T-1-5 acceptance criteria: proves `ensureReferenceData` runs from a completely empty
 * database (no `pnpm db:seed` step), by migrating a throwaway database of its own - never the
 * shared dev DB or the `invai_test*` database other test files in this run use - and dropping it
 * afterwards.
 *
 * The scratch DB name is derived from this run's own test database (env.MIGRATION_DATABASE_URL,
 * which is `TEST_MIGRATION_DATABASE_URL` under NODE_ENV=test - one per card/agent, per
 * `invai-docs/waves/1/wave.md`), not hard-coded: two agents running `pnpm test` at the same time
 * each get their own scratch DB, so one run's `afterAll` (`DROP DATABASE ... WITH (FORCE)`) can
 * never drop the other's database out from under it.
 */

function withDatabaseName(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

const SCRATCH_DB = `${new URL(env.MIGRATION_DATABASE_URL).pathname.slice(1)}_ref`;
const scratchUrl = withDatabaseName(env.MIGRATION_DATABASE_URL, SCRATCH_DB);

describe("ensureReferenceData, via runMigrations on an empty database", () => {
  let pool: Pool;

  beforeAll(async () => {
    await ensureDatabase(env.MIGRATION_DATABASE_URL, SCRATCH_DB);
    await runMigrations(scratchUrl, { quiet: true });
    pool = new Pool({ connectionString: scratchUrl, max: 1 });
  });

  afterAll(async () => {
    await pool?.end();
    const admin = new Pool({
      connectionString: withDatabaseName(env.MIGRATION_DATABASE_URL, "postgres"),
      max: 1,
    });
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB}" WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  });

  it("creates the plan catalog and the trademark index, and no tenants", async () => {
    const { rows: companyRows } = await pool.query("select count(*)::int as n from companies");
    expect(companyRows[0].n).toBe(0);
    const { rows: userRows } = await pool.query("select count(*)::int as n from users");
    expect(userRows[0].n).toBe(0);

    const { rows: planRows } = await pool.query("select count(*)::int as n from plans");
    expect(planRows[0].n).toBe(5);

    const { rows: markRows } = await pool.query("select count(*)::int as n from trademark_marks");
    expect(markRows[0].n).toBeGreaterThan(200);
  });

  it("is idempotent: migrating the same database again changes nothing", async () => {
    await runMigrations(scratchUrl, { quiet: true });
    const { rows } = await pool.query("select count(*)::int as n from trademark_marks");
    expect(rows[0].n).toBeGreaterThan(200);
  });

  it("leaves the trademark check working: a known mark comes back high risk", async () => {
    const scratchDb = drizzle(pool, { schema, casing: "snake_case" });
    const result = await scratchDb.transaction((tx) =>
      checkTrademarks(tx, { companyId: randomUUID(), userId: null }, [
        { source: "title", text: "Disney shirt" },
      ]),
    );
    expect(result.riskLevel).toBe("high");
    expect(result.matches.map((m) => m.mark)).toContain("DISNEY");
  });
});
