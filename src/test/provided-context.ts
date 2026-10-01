/**
 * Typed channel from `global-setup.ts` (runs once, in Vitest's orchestrator context) to every
 * test file's worker (thread or fork — T-P1-1, B-228). `TestProject.provide()` and `inject()`
 * are the documented, pool-agnostic way to do this (confirmed by reading the installed Vitest 5
 * types: `globalSetupFile.setup?.(this)` passes the `TestProject` itself as the sole argument,
 * and its `provide<K>(key, value)` / the standalone `inject<K>(key)` share this augmentable
 * `ProvidedContext` interface — `node_modules/vitest/dist/chunks/plugin.d.*.d.ts`). Mutating
 * `process.env` directly in `global-setup.ts` is not relied on for cross-worker propagation: the
 * error Vitest throws for importing `vitest` itself inside `globalSetup` ("globalSetup runs in a
 * different context") is the documented signal that globalSetup and worker code don't share
 * state for free.
 */
declare module "vitest" {
  interface ProvidedContext {
    /** `DATABASE_URL` to use in every worker, or undefined when the caller pinned their own. */
    testDatabaseUrl?: string;
    /** `MIGRATION_DATABASE_URL` to use in every worker, or undefined when pinned. */
    testMigrationDatabaseUrl?: string;
    /** `REDIS_URL` to use in every worker, or undefined when pinned. */
    testRedisUrl?: string;
  }
}

export {};
