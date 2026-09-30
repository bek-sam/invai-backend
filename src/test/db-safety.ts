/**
 * Refuses to run destructive test setup (recreating or truncating every table) against anything
 * that doesn't clearly look like a test database. `src/env.ts` already redirects both
 * `DATABASE_URL` and `MIGRATION_DATABASE_URL` under `NODE_ENV=test` (to `invai_test`, or to
 * `TEST_DATABASE_URL` / `TEST_MIGRATION_DATABASE_URL` when an agent pins its own scratch DB per
 * `team/agent-brief.md`), so this is defense in depth against a future change to that redirect or
 * a misconfigured `.env` — never the only guard.
 *
 * A URL counts as a test database when either:
 *  - its database name contains "test" (case-insensitive) — the default `invai_test`, or a
 *    scratch DB an agent names like `invai_test_t23_0`; or
 *  - it is exactly the URL the caller explicitly pinned via `TEST_DATABASE_URL` or
 *    `TEST_MIGRATION_DATABASE_URL` — an explicit opt-in is trusted even when the name doesn't say
 *    "test" (B-205 round 2 used a scratch DB named `invai_t23_0_r2`, which doesn't).
 */
export function assertTestDatabase(url: string, label = "database"): void {
  const name = new URL(url).pathname.slice(1);
  const pinnedByCaller =
    url === process.env.TEST_DATABASE_URL || url === process.env.TEST_MIGRATION_DATABASE_URL;
  if (!/test/i.test(name) && !pinnedByCaller) {
    throw new Error(
      `refusing to reset ${label} "${name}": it doesn't look like a test database. The name ` +
        'must contain "test", or the URL must be set explicitly via TEST_DATABASE_URL or ' +
        "TEST_MIGRATION_DATABASE_URL.",
    );
  }
}
