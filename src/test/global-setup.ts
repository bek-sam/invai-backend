/**
 * Vitest global setup: make sure the test database exists, is migrated, and is empty of tenant
 * data before any test file runs. Runs once per `vitest` invocation. Also creates the S3 bucket,
 * so storage tests run on a fresh MinIO (CI). NODE_ENV=test makes src/env.ts point every
 * database URL at `invai_test`, so tests can never touch development data.
 *
 * B-205 AC6: a shared `invai_test` accumulates rows across every run and every agent (it reached
 * 9,006 companies / 1.24M rows before this fix). Unscoped sweeps that a request would never run
 * this way in production but a test calls directly — `findStuckIntents()` (`LIMIT 200`,
 * cross-tenant by design) is the one that failed — see only the oldest 200 leftover rows and never
 * reach the row the current run just created, and a big-enough table also slows ordinary queries
 * enough to trip a test's timeout. Truncating at the start of every run means every run starts
 * from the same clean slate the day-one seed-less test DB had, regardless of what earlier runs (or
 * other agents sharing this DB) left behind.
 */
process.env.NODE_ENV = "test";

export default async function setup() {
  const { env } = await import("../env");
  const { assertTestDatabase } = await import("./db-safety");
  const { ensureDatabase } = await import("../db/reset");
  const { runMigrations } = await import("../db/migrate");
  // Defense in depth: truncateAll() below is destructive, so refuse before touching anything if
  // either URL doesn't look like a test database (see db-safety.ts for what counts).
  assertTestDatabase(env.DATABASE_URL, "DATABASE_URL");
  assertTestDatabase(env.MIGRATION_DATABASE_URL, "MIGRATION_DATABASE_URL");
  await ensureDatabase(
    env.MIGRATION_DATABASE_URL,
    new URL(env.MIGRATION_DATABASE_URL).pathname.slice(1),
  );
  await runMigrations(env.MIGRATION_DATABASE_URL, { quiet: true });
  const { truncateAll } = await import("./fixtures");
  await truncateAll();
  const { ensureBucket } = await import("../lib/s3");
  await ensureBucket();
}
