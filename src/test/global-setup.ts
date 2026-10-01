import { existsSync } from "node:fs";
import type { TestProject } from "vitest/node";
import "./provided-context";

/**
 * Vitest global setup: make sure the test database exists, is migrated, and is empty of tenant
 * data before any test file runs. Runs once per `vitest` invocation, in Vitest's orchestrator
 * context (not a worker — importing the `vitest` runtime package itself here is unsupported;
 * `TestProject` is a type-only import and `provide()` is the method Vitest hands us on `project`
 * below). NODE_ENV=test makes src/env.ts point every database URL at the test database, so tests
 * can never touch development data.
 *
 * T-P1-1 (B-228): unless the caller already pinned `TEST_DATABASE_URL` /
 * `TEST_MIGRATION_DATABASE_URL` / `REDIS_URL` (unchanged — the gate and CI rely on this), this
 * claims a fresh per-run Postgres database (`test-db.ts`) and a free Redis DB (`test-redis.ts`),
 * so two `vitest` runs starting at the same moment never share or truncate each other's rows or
 * job queues. The claimed URLs are handed to every worker via `provide()`/`inject()`
 * (`setup-env.ts`, the first `setupFiles` entry) — see `provided-context.ts` for why that channel
 * is used instead of relying on `process.env` propagating into worker threads or forks for free.
 *
 * B-205 AC6 (kept): a shared `invai_test` used to accumulate rows across every run and every
 * agent (it reached 9,006 companies / 1.24M rows before that fix). Truncating at the start of
 * every run means every run starts from the same clean slate the day-one seed-less test DB had.
 * With a per-run database this is now usually a no-op (a freshly cloned template starts empty),
 * but it stays as defense in depth for the pinned-URL path, where a caller's own scratch database
 * may carry rows from an earlier run.
 */
process.env.NODE_ENV = "test";
// Mirrors env.ts's own dotenv loading (duplicated, not imported — see the note on `env` below):
// we need the raw DATABASE_URL/MIGRATION_DATABASE_URL/REDIS_URL from `.env` *before* claiming a
// per-run database and Redis DB, and before setting TEST_DATABASE_URL etc., which env.ts must
// see on its first and only import in this file.
if (!process.env.INVAI_SKIP_DOTENV) {
  for (const file of [".env", ".env.local"]) {
    if (existsSync(file)) process.loadEnvFile(file);
  }
}

export default async function setup(project: TestProject) {
  const { assertTestDatabase } = await import("./db-safety");
  const { claimTestDatabase } = await import("./test-db");
  const { claimTestRedisDb } = await import("./test-redis");

  const rawDatabaseUrl = requireEnv("DATABASE_URL");
  const rawMigrationUrl = requireEnv("MIGRATION_DATABASE_URL");
  const rawRedisUrl = requireEnv("REDIS_URL");

  const dbClaim = await claimTestDatabase({
    appUrl: rawDatabaseUrl,
    migrationUrl: rawMigrationUrl,
    pinnedAppUrl: process.env.TEST_DATABASE_URL,
    pinnedMigrationUrl: process.env.TEST_MIGRATION_DATABASE_URL,
  });
  const redisClaim = await claimTestRedisDb({
    baseUrl: rawRedisUrl,
    pinnedUrl: process.env.TEST_REDIS_URL ?? pinnedNonZeroRedisUrl(rawRedisUrl),
  });

  process.env.TEST_DATABASE_URL = dbClaim.databaseUrl;
  process.env.TEST_MIGRATION_DATABASE_URL = dbClaim.migrationDatabaseUrl;
  process.env.TEST_REDIS_URL = redisClaim.redisUrl;
  // Same-process consumers (this file, below) already see the env vars just set. Every worker
  // gets them through this instead — see provided-context.ts.
  project.provide("testDatabaseUrl", dbClaim.databaseUrl);
  project.provide("testMigrationDatabaseUrl", dbClaim.migrationDatabaseUrl);
  project.provide("testRedisUrl", redisClaim.redisUrl);

  const { env } = await import("../env");
  // Defense in depth: truncateAll() below is destructive, so refuse before touching anything if
  // either URL doesn't look like a test database (see db-safety.ts for what counts).
  assertTestDatabase(env.DATABASE_URL, "DATABASE_URL");
  assertTestDatabase(env.MIGRATION_DATABASE_URL, "MIGRATION_DATABASE_URL");
  const { ensureDatabase } = await import("../db/reset");
  const { runMigrations } = await import("../db/migrate");
  await ensureDatabase(
    env.MIGRATION_DATABASE_URL,
    new URL(env.MIGRATION_DATABASE_URL).pathname.slice(1),
  );
  await runMigrations(env.MIGRATION_DATABASE_URL, { quiet: true });
  const { truncateAll } = await import("./fixtures");
  await truncateAll();
  const { ensureBucket } = await import("../lib/s3");
  await ensureBucket();

  return async () => {
    await dbClaim.cleanup();
    await redisClaim.cleanup();
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set (see .env.example)`);
  return value;
}

/** Mirrors env.ts's `isPinnedNonZeroDb`: a caller-chosen non-zero `REDIS_URL` DB wins unchanged
 *  (the `team/agent-brief.md` pattern), same as an explicit `TEST_REDIS_URL`. */
function pinnedNonZeroRedisUrl(url: string): string | undefined {
  const path = new URL(url).pathname.replace(/^\//, "");
  return /^[1-9]\d*$/.test(path) ? url : undefined;
}
