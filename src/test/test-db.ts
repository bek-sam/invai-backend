import { Pool } from "pg";

/**
 * Per-run Postgres test database (T-P1-1, B-228). Unless the caller pins `TEST_DATABASE_URL` /
 * `TEST_MIGRATION_DATABASE_URL`, every `vitest` invocation gets its own `invai_test_<pid>`,
 * cloned from a migrated template `invai_test_tpl`, so two runs starting at once never truncate
 * or race on each other's rows (the bug this replaces: a shared `invai_test` that every plain
 * run truncated at the start of `global-setup.ts`).
 *
 * Everything that can race — ensuring and migrating the template, sweeping stale per-run
 * databases, cloning the new one — runs under one Postgres advisory lock held on a `/postgres`
 * connection. That matters for a reason beyond tidiness: `CREATE DATABASE ... TEMPLATE` fails
 * outright if any other session is connected to the template while it runs (a hard Postgres
 * rule, not a race we could just retry past), so "migrate, then immediately clone" must be one
 * atomic section as far as every concurrent `vitest` process is concerned. Advisory locks are
 * scoped per database the locking session is connected to (verified against the local Postgres:
 * the same key blocks a second session on the same database but not one connected to another
 * database), so every participant takes this lock on the *same* database ("/postgres") for it to
 * mean anything.
 */

const TEMPLATE_DB = "invai_test_tpl";
/** Distinct from `db/migrate.ts`'s `MIGRATION_LOCK_KEY` (468_241); arbitrary but must stay stable. */
const TEMPLATE_LOCK_KEY = 468_242;
/** AC4: a crashed run's per-run database is only ever swept once it's this old. */
const STALE_AGE_MS = 60 * 60 * 1000;
const PER_RUN_PREFIX = "invai_test_";
const PER_RUN_NAME_RE = /^invai_test_(\d+)$/;

function postgresMaintenanceUrl(url: string): URL {
  const u = new URL(url);
  u.pathname = "/postgres";
  return u;
}

function withDatabaseName(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

/**
 * True when `pid` is not a live process on *this host* (ESRCH) or isn't a usable pid at all.
 * Exported for its own test; the per-run database name only ever encodes a local pid, so this
 * check is local-host only by design (matches the card's "isn't alive on this host").
 */
export function pidIsDead(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/** Parses the `created_at:<epoch ms>` marker `claimTestDatabase` leaves via `COMMENT ON DATABASE`. */
export function parseCreatedAt(comment: string | null): number | null {
  const match = comment?.match(/created_at:(\d+)/);
  return match ? Number(match[1]) : null;
}

async function ensureTemplate(migrationUrl: string, maintenanceUrl: string) {
  const pool = new Pool({ connectionString: maintenanceUrl, max: 1 });
  try {
    const { rowCount } = await pool.query("select 1 from pg_database where datname = $1", [
      TEMPLATE_DB,
    ]);
    if (rowCount === 0) {
      await pool.query(
        `CREATE DATABASE "${TEMPLATE_DB}" OWNER ${new URL(maintenanceUrl).username}`,
      );
    }
    await pool.query(`GRANT ALL ON DATABASE "${TEMPLATE_DB}" TO invai_app`).catch(() => {});
  } finally {
    await pool.end();
  }
  // Fully migrates and closes its own connection to the template (runMigrations's own `finally`
  // calls `pool.end()`), so by the time this resolves nothing of ours is still connected to it.
  const { runMigrations } = await import("../db/migrate");
  await runMigrations(withDatabaseName(migrationUrl, TEMPLATE_DB), { quiet: true });
}

/** AC4: drops `invai_test_<pid>` databases whose pid is dead and whose marker is over an hour old. */
async function dropStaleDatabases(pool: Pool) {
  const { rows } = await pool.query<{ datname: string; comment: string | null }>(
    `select d.datname, shobj_description(d.oid, 'pg_database') as comment
     from pg_database d where d.datname ~ '^invai_test_[0-9]+$'`,
  );
  const now = Date.now();
  for (const row of rows) {
    const match = row.datname.match(PER_RUN_NAME_RE);
    if (!match) continue; // defensive; the query's regex already filters this
    const pid = Number(match[1]);
    const createdAt = parseCreatedAt(row.comment);
    // No marker: not one of ours (or from before this card) — never guess, never drop it.
    if (createdAt === null) continue;
    if (now - createdAt > STALE_AGE_MS && pidIsDead(pid)) {
      await dropDatabaseOn(pool, row.datname);
    }
  }
}

async function dropDatabaseOn(pool: Pool, name: string) {
  await pool
    .query("select pg_terminate_backend(pid) from pg_stat_activity where datname = $1", [name])
    .catch(() => {});
  await pool.query(`DROP DATABASE IF EXISTS "${name}"`);
}

export type ClaimedTestDatabase = {
  databaseUrl: string;
  migrationDatabaseUrl: string;
  /** Drops the per-run database. No-op when the caller pinned their own (nothing to clean up). */
  cleanup(): Promise<void>;
};

/**
 * AC1/AC3/AC4: claims (or honors a pin for) the Postgres database a run's workers should use.
 * `appUrl`/`migrationUrl` are the raw, un-redirected dev URLs (used only as a template for host,
 * port and credentials); `pinnedAppUrl`/`pinnedMigrationUrl` are `TEST_DATABASE_URL` /
 * `TEST_MIGRATION_DATABASE_URL` when the caller set them.
 */
export async function claimTestDatabase(opts: {
  appUrl: string;
  migrationUrl: string;
  pinnedAppUrl?: string;
  pinnedMigrationUrl?: string;
}): Promise<ClaimedTestDatabase> {
  if (opts.pinnedAppUrl || opts.pinnedMigrationUrl) {
    // At least one of the pair is pinned. Match `env.ts`'s own (unchanged) per-field default for
    // whichever side isn't: the historical shared `invai_test` name, never the raw dev URL.
    return {
      databaseUrl: opts.pinnedAppUrl ?? withDatabaseName(opts.appUrl, "invai_test"),
      migrationDatabaseUrl:
        opts.pinnedMigrationUrl ?? withDatabaseName(opts.migrationUrl, "invai_test"),
      cleanup: async () => {},
    };
  }

  const maintenanceUrl = postgresMaintenanceUrl(opts.migrationUrl).toString();
  const name = `${PER_RUN_PREFIX}${process.pid}`;
  const pool = new Pool({ connectionString: maintenanceUrl, max: 1 });
  try {
    await pool.query("BEGIN");
    await pool.query("SET LOCAL lock_timeout = '30s'");
    await pool.query("select pg_advisory_lock($1)", [TEMPLATE_LOCK_KEY]);
    await pool.query("COMMIT");

    await ensureTemplate(opts.migrationUrl, maintenanceUrl);
    await dropStaleDatabases(pool);
    // Extra insurance beyond the lock: a crashed run's connection to the template itself (not a
    // per-run database) would otherwise make the clone below fail with "source database ... is
    // being accessed by other users". Never terminate our own session.
    await pool
      .query(
        "select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()",
        [TEMPLATE_DB],
      )
      .catch(() => {});
    await pool.query(
      `CREATE DATABASE "${name}" TEMPLATE ${TEMPLATE_DB} OWNER ${new URL(maintenanceUrl).username}`,
    );
    await pool.query(`GRANT ALL ON DATABASE "${name}" TO invai_app`).catch(() => {});
    await pool.query(`COMMENT ON DATABASE "${name}" IS 'created_at:${Date.now()}'`);
  } finally {
    await pool.query("select pg_advisory_unlock($1)", [TEMPLATE_LOCK_KEY]).catch(() => {});
    await pool.end();
  }

  return {
    databaseUrl: withDatabaseName(opts.appUrl, name),
    migrationDatabaseUrl: withDatabaseName(opts.migrationUrl, name),
    cleanup: () => dropOwnDatabase(maintenanceUrl, name),
  };
}

async function dropOwnDatabase(maintenanceUrl: string, name: string) {
  const pool = new Pool({ connectionString: maintenanceUrl, max: 1 });
  try {
    await dropDatabaseOn(pool, name);
  } catch (err) {
    console.warn(`[test-db] could not drop ${name}: ${(err as Error).message}`);
  } finally {
    await pool.end();
  }
}
