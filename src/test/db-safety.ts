/**
 * Refuses to run destructive test setup (recreating or truncating every table) against anything
 * that doesn't clearly look like a test database. `src/env.ts` already redirects both
 * `DATABASE_URL` and `MIGRATION_DATABASE_URL` under `NODE_ENV=test` (to `invai_test`, or to
 * `TEST_DATABASE_URL` / `TEST_MIGRATION_DATABASE_URL` when an agent pins its own scratch DB per
 * `team/agent-brief.md`), so this is defense in depth against a future change to that redirect or
 * a misconfigured `.env` — never the only guard.
 *
 * The dev database is refused unconditionally, before anything else is checked:
 *  - a database literally named "invai" (the dev DB name in `local/init.sql` and `.env`), and
 *  - whatever database name the *raw, un-redirected* `DATABASE_URL` / `MIGRATION_DATABASE_URL`
 *    process env vars point at right now — the dev URLs `env.ts` redirects away from under
 *    `NODE_ENV=test`.
 *  Both checks apply even when the URL was explicitly pinned via `TEST_DATABASE_URL` /
 *  `TEST_MIGRATION_DATABASE_URL` (review round 3): pinning the dev URL by mistake — leaving `<db>`
 *  as `invai`, e.g. `TEST_MIGRATION_DATABASE_URL=postgres://invai:invai@localhost:5432/invai` —
 *  must never be trusted just because it was pinned. That was exactly the gap this guard existed
 *  to close, and an unconditional pin bypassed it.
 *
 * Once the dev database is ruled out, a URL counts as a test database when either:
 *  - its database name contains "test" as a whole underscore-delimited segment
 *    (case-insensitive) — `invai_test`, `invai_test_t23_0`, `INVAI_TEST_T23_0` — but not a name
 *    that merely contains the letters, like `invai_latest`; or
 *  - it is exactly the URL the caller explicitly pinned via `TEST_DATABASE_URL` or
 *    `TEST_MIGRATION_DATABASE_URL` — an explicit opt-in is trusted even when the name doesn't say
 *    "test" (B-205 round 2 used a scratch DB named `invai_t23_0_r2`, which doesn't).
 */
export function assertTestDatabase(url: string, label = "database"): void {
  const name = databaseName(url);
  const devNames = [
    databaseName(process.env.DATABASE_URL),
    databaseName(process.env.MIGRATION_DATABASE_URL),
  ];
  if (name === "invai" || devNames.includes(name)) {
    refuse(label, name);
  }

  const pinnedByCaller =
    url === process.env.TEST_DATABASE_URL || url === process.env.TEST_MIGRATION_DATABASE_URL;
  if (!/(^|_)test(_|$)/i.test(name) && !pinnedByCaller) {
    refuse(label, name);
  }
}

function databaseName(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).pathname.slice(1);
  } catch {
    return "";
  }
}

function refuse(label: string, name: string): never {
  throw new Error(
    `refusing to reset ${label} "${name}": it doesn't look like a test database (this includes ` +
      'the dev database, which is always refused, pinned or not). The name must contain "test" ' +
      "as a whole underscore-delimited segment, or the URL must be set explicitly via " +
      "TEST_DATABASE_URL or TEST_MIGRATION_DATABASE_URL — except the dev database itself, which " +
      "no pin can allow.",
  );
}
