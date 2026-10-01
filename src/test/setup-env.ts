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

if (testDatabaseUrl) process.env.TEST_DATABASE_URL = testDatabaseUrl;
if (testMigrationDatabaseUrl) process.env.TEST_MIGRATION_DATABASE_URL = testMigrationDatabaseUrl;
if (testRedisUrl) process.env.TEST_REDIS_URL = testRedisUrl;
