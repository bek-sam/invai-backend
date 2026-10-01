import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { claimTestDatabase, parseCreatedAt, pidIsDead } from "./test-db";

// Raw, un-redirected dev URLs (env.ts never mutates process.env itself, only its own exported
// `env` object), exactly what global-setup.ts passes as appUrl/migrationUrl.
const APP_URL = process.env.DATABASE_URL as string;
const MIGRATION_URL = process.env.MIGRATION_DATABASE_URL as string;

function maintenancePool() {
  const u = new URL(MIGRATION_URL);
  u.pathname = "/postgres";
  return new Pool({ connectionString: u.toString(), max: 1 });
}

async function databaseExists(pool: Pool, name: string): Promise<boolean> {
  const { rowCount } = await pool.query("select 1 from pg_database where datname = $1", [name]);
  return (rowCount ?? 0) > 0;
}

describe("pidIsDead", () => {
  it("is false for this very process", () => {
    expect(pidIsDead(process.pid)).toBe(false);
  });

  it("is true for a pid nothing uses (well above any real pid here)", () => {
    expect(pidIsDead(999_999_999)).toBe(true);
  });

  it("is true for an invalid pid", () => {
    expect(pidIsDead(0)).toBe(true);
    expect(pidIsDead(-1)).toBe(true);
    expect(pidIsDead(Number.NaN)).toBe(true);
  });
});

describe("parseCreatedAt", () => {
  it("reads the marker claimTestDatabase leaves via COMMENT ON DATABASE", () => {
    expect(parseCreatedAt("created_at:1700000000000")).toBe(1_700_000_000_000);
  });

  it("is null for no comment or an unrelated one", () => {
    expect(parseCreatedAt(null)).toBeNull();
    expect(parseCreatedAt("some other comment")).toBeNull();
  });
});

describe("claimTestDatabase", () => {
  it("an explicit pin wins unchanged, with a no-op cleanup", async () => {
    const pinnedApp = "postgres://invai_app:invai@localhost:5432/invai_pin_test";
    const pinnedMigration = "postgres://invai:invai@localhost:5432/invai_pin_test";
    const claim = await claimTestDatabase({
      appUrl: APP_URL,
      migrationUrl: MIGRATION_URL,
      pinnedAppUrl: pinnedApp,
      pinnedMigrationUrl: pinnedMigration,
    });
    expect(claim.databaseUrl).toBe(pinnedApp);
    expect(claim.migrationDatabaseUrl).toBe(pinnedMigration);
    await expect(claim.cleanup()).resolves.toBeUndefined();
  });

  it("when only one of the pair is pinned, the other falls back to the shared invai_test name", async () => {
    const pinnedMigration = "postgres://invai:invai@localhost:5432/invai_pin_test";
    const claim = await claimTestDatabase({
      appUrl: APP_URL,
      migrationUrl: MIGRATION_URL,
      pinnedMigrationUrl: pinnedMigration,
    });
    expect(claim.migrationDatabaseUrl).toBe(pinnedMigration);
    expect(new URL(claim.databaseUrl).pathname).toBe("/invai_test");
    await expect(claim.cleanup()).resolves.toBeUndefined();
  });

  it("unpinned: creates invai_test_<pid> from the template, then drops it on cleanup (AC1)", async () => {
    const claim = await claimTestDatabase({ appUrl: APP_URL, migrationUrl: MIGRATION_URL });
    const name = `invai_test_${process.pid}`;
    expect(new URL(claim.databaseUrl).pathname).toBe(`/${name}`);
    expect(new URL(claim.migrationDatabaseUrl).pathname).toBe(`/${name}`);

    const pool = maintenancePool();
    try {
      expect(await databaseExists(pool, name)).toBe(true);
      expect(await databaseExists(pool, "invai_test_tpl")).toBe(true);
      await claim.cleanup();
      expect(await databaseExists(pool, name)).toBe(false);
    } finally {
      await pool.end();
    }
  }, 30_000);

  it("unpinned: sweeps a stale invai_test_<deadpid> database from a crashed run (AC4)", async () => {
    // Make sure the template exists first (reuses the normal claim path, then drops its own
    // per-run database so it doesn't get swept away as "the other" claim below).
    const seed = await claimTestDatabase({ appUrl: APP_URL, migrationUrl: MIGRATION_URL });
    await seed.cleanup();

    const pool = maintenancePool();
    const deadPid = 999_999_998; // pidIsDead() above confirms pids this high are never alive
    const staleName = `invai_test_${deadPid}`;
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    try {
      await pool.query(`DROP DATABASE IF EXISTS "${staleName}"`);
      await pool.query(`CREATE DATABASE "${staleName}" TEMPLATE invai_test_tpl OWNER invai`);
      await pool.query(`COMMENT ON DATABASE "${staleName}" IS 'created_at:${twoHoursAgo}'`);
      expect(await databaseExists(pool, staleName)).toBe(true);

      const claim = await claimTestDatabase({ appUrl: APP_URL, migrationUrl: MIGRATION_URL });
      try {
        expect(await databaseExists(pool, staleName)).toBe(false);
      } finally {
        await claim.cleanup();
      }
    } finally {
      await pool.query(`DROP DATABASE IF EXISTS "${staleName}"`).catch(() => {});
      await pool.end();
    }
  }, 30_000);

  it("unpinned: never sweeps a database that merely looks similar (no created_at marker)", async () => {
    const pool = maintenancePool();
    // Not matching the strict invai_test_<digits> pattern: a human-pinned scratch DB per
    // team/agent-brief.md's convention ("its name must contain _test").
    const lookalike = "invai_p99_test";
    try {
      await pool.query(`DROP DATABASE IF EXISTS "${lookalike}"`);
      await pool.query(`CREATE DATABASE "${lookalike}" OWNER invai`);

      const claim = await claimTestDatabase({ appUrl: APP_URL, migrationUrl: MIGRATION_URL });
      try {
        expect(await databaseExists(pool, lookalike)).toBe(true);
      } finally {
        await claim.cleanup();
      }
    } finally {
      await pool.query(`DROP DATABASE IF EXISTS "${lookalike}"`).catch(() => {});
      await pool.end();
    }
  }, 30_000);
});
