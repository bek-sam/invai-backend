import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { env } from "../env";
import { runMigrations } from "./migrate";
import { ensureDatabase } from "./reset";

/*
 * T-12-2 (B-16 follow-up; T-1-5 review): `runMigrations` takes a Postgres advisory lock before
 * running migrations + ensureReferenceData, so two concurrent migrates against a fresh database
 * don't race on `CREATE EXTENSION`. Exercised against a scratch database (not the shared test
 * database, which is already migrated and wouldn't hit the "fresh DB" extension-creation path).
 */
describe("runMigrations advisory lock", () => {
  it("lets two concurrent calls against the same fresh database both succeed, no race", async () => {
    const name = `invai_test_migrate_lock_${Date.now().toString(36)}`;
    await ensureDatabase(env.MIGRATION_DATABASE_URL, name);
    const url = new URL(env.MIGRATION_DATABASE_URL);
    url.pathname = `/${name}`;
    const scratchUrl = url.toString();

    try {
      // Both start at once; without the lock this is exactly the T-1-5 "CREATE EXTENSION" race.
      const results = await Promise.allSettled([
        runMigrations(scratchUrl, { quiet: true }),
        runMigrations(scratchUrl, { quiet: true }),
      ]);
      for (const r of results) {
        if (r.status === "rejected") throw r.reason;
      }

      // Confirms migration actually ran (not two silent no-ops) and left a normal, once-created
      // extension behind -- not a duplicate/partial one.
      const check = new Pool({ connectionString: scratchUrl, max: 1 });
      try {
        const ext = await check.query(
          "select count(*)::int as n from pg_extension where extname = 'pg_trgm'",
        );
        expect(ext.rows[0].n).toBe(1);
        const tables = await check.query(
          "select count(*)::int as n from pg_tables where schemaname = 'public' and tablename = 'companies'",
        );
        expect(tables.rows[0].n).toBe(1);
      } finally {
        await check.end();
      }
    } finally {
      const owner = new Pool({
        connectionString: `${url.protocol}//${url.username}:${url.password}@${url.host}/postgres`,
        max: 1,
      });
      try {
        await owner.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await owner.end();
      }
    }
  }, 60_000);
});
