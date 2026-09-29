import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { env } from "../env";
import {
  acquireMigrationLock,
  MIGRATION_LOCK_KEY,
  MIGRATION_SESSION,
  releaseMigrationLock,
  runMigrations,
} from "./migrate";
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

/*
 * T-22-2 (B-163): the migration session never inherits the owner role's 5-minute
 * statement_timeout (0025). The advisory-lock wait runs under `statement_timeout = 0` with its
 * own lock_timeout, and the statements after it run with no statement timeout and the 5 s DDL
 * lock guard. Runs against the migrated test database as the owner role.
 */
describe("migration lock and timeouts (B-163)", () => {
  let holder: Client;

  beforeAll(async () => {
    holder = new Client({ connectionString: env.MIGRATION_DATABASE_URL });
    await holder.connect();
  });

  afterAll(async () => {
    await holder.end();
  });

  async function tryLock(client: Client): Promise<boolean> {
    const res = await client.query<{ ok: boolean }>("select pg_try_advisory_lock($1) as ok", [
      MIGRATION_LOCK_KEY,
    ]);
    return res.rows[0]?.ok === true;
  }

  it("holds the session lock and sets the migration timeouts on that session", async () => {
    const pool = new Pool({ connectionString: env.MIGRATION_DATABASE_URL, max: 1 });
    try {
      await acquireMigrationLock(pool);
      const st = await pool.query<{ statement_timeout: string }>("show statement_timeout");
      const lt = await pool.query<{ lock_timeout: string }>("show lock_timeout");
      expect(st.rows[0]?.statement_timeout).toBe("0");
      expect(lt.rows[0]?.lock_timeout).toBe(MIGRATION_SESSION.lockTimeout);
      // Not in a transaction any more (the lock is session-level), and still held.
      expect(await tryLock(holder)).toBe(false);
      await releaseMigrationLock(pool);
      expect(await tryLock(holder)).toBe(true);
      await holder.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
    } finally {
      await pool.end();
    }
  });

  it("waits for a concurrent migrate instead of failing, under its own lock wait", async () => {
    expect(await tryLock(holder)).toBe(true);
    // The waiter's role default (statement_timeout 5min via ALTER ROLE) is irrelevant: make it
    // aggressive on this pool to prove the SET LOCAL 0 inside the lock transaction wins.
    const pool = new Pool({
      connectionString: env.MIGRATION_DATABASE_URL,
      max: 1,
      options: "-c statement_timeout=200",
    });
    try {
      let acquired = false;
      const waiting = acquireMigrationLock(pool).then(() => {
        acquired = true;
      });
      await new Promise((r) => setTimeout(r, 600));
      expect(acquired).toBe(false);
      await holder.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
      await waiting;
      expect(acquired).toBe(true);
      await releaseMigrationLock(pool);
    } finally {
      await pool.end();
    }
  });
});
