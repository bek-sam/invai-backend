import { inject } from "vitest";
import "./provided-context";

/**
 * Must be the *first* entry in `vitest.config.ts`'s `setupFiles`, and must import nothing of
 * ours besides the ambient `ProvidedContext` types above. `global-setup.ts` computes the per-run
 * `DATABASE_URL`/`MIGRATION_DATABASE_URL`/`REDIS_URL` once (claiming a fresh per-run database and
 * a free Redis DB, or honoring a pin unchanged — T-P1-1, B-228) and hands them to every worker
 * through `provide()`/`inject()`, Vitest's documented, pool-agnostic channel for exactly this
 * (confirmed in `provided-context.ts`'s comment). That only helps if this file sets
 * `process.env` from the injected values *before* anything else in this worker — including the
 * next `setupFiles` entry (`setup.ts`) or the test file itself — imports `../env` and freezes its
 * own snapshot of `process.env`. A later import can't retroactively see an env var set after the
 * fact, so order here is load-bearing, not cosmetic.
 */
const testDatabaseUrl = inject("testDatabaseUrl");
const testMigrationDatabaseUrl = inject("testMigrationDatabaseUrl");
const testRedisUrl = inject("testRedisUrl");
const testRedisClaimedDb = inject("testRedisClaimedDb");
const testS3Bucket = inject("testS3Bucket");
const testImagingUrl = inject("testImagingUrl");

if (testDatabaseUrl) process.env.TEST_DATABASE_URL = testDatabaseUrl;
if (testMigrationDatabaseUrl) process.env.TEST_MIGRATION_DATABASE_URL = testMigrationDatabaseUrl;
if (testRedisUrl) process.env.TEST_REDIS_URL = testRedisUrl;
// T-49-3: env.ts accepts a DB in 1-8 only when the harness claimed exactly that one.
if (testRedisClaimedDb !== undefined)
  process.env.INVAI_TEST_REDIS_CLAIMED = String(testRedisClaimedDb);
// T-43-6: the dev bucket from `.env` is never used by tests; the bucket global-setup chose wins.
if (testS3Bucket) process.env.S3_BUCKET = testS3Bucket;
// T-44-5: tests never reach a live imaging service; the shell/.env IMAGING_URL is overridden.
if (testImagingUrl) process.env.IMAGING_URL = testImagingUrl;
