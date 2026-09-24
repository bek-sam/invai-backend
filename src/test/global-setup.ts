/**
 * Vitest global setup: make sure the test database exists and is migrated. Runs once per
 * `vitest` invocation, before any test file. Also creates the S3 bucket, so storage tests run on
 * a fresh MinIO (CI). NODE_ENV=test makes src/env.ts point every
 * database URL at `invai_test`, so tests can never touch development data.
 */
process.env.NODE_ENV = "test";

export default async function setup() {
  const { env } = await import("../env");
  const { ensureDatabase } = await import("../db/reset");
  const { runMigrations } = await import("../db/migrate");
  await ensureDatabase(
    env.MIGRATION_DATABASE_URL,
    new URL(env.MIGRATION_DATABASE_URL).pathname.slice(1),
  );
  await runMigrations(env.MIGRATION_DATABASE_URL, { quiet: true });
  const { ensureBucket } = await import("../lib/s3");
  await ensureBucket();
}
