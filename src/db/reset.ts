import { fileURLToPath } from "node:url";
import { Pool } from "pg";

/**
 * True only when the URL's path is written exactly as a positive integer with no leading zero
 * (`/1`, `/14`, ...). Mirrors `isPinnedNonZeroDb` in `../env.ts`, duplicated here (not imported)
 * because `src/env.ts` is outside this card's owned paths and this check must stay a pure,
 * dependency-free function the test can exercise directly. No path, `/0`, a trailing slash
 * (`/0/`), a decimal, hex, blank or non-numeric text all count as "unset" (DB 0).
 */
function isPinnedNonZeroRedisDb(url: string): boolean {
  const path = new URL(url).pathname.replace(/^\//, "");
  return /^[1-9]\d*$/.test(path);
}

/**
 * B-219: resetting any database other than the shared dev/CI database `invai` must never
 * obliterate the queues living in Redis DB 0 (two incidents: 2026-09-29 T-23-9, 2026-10-01 T-P5-1).
 * `invai` always resets exactly as before, whatever `REDIS_URL` is -- the gate
 * (`invai-infra/scripts/gate.sh:108`) and CI (`.github/workflows/ci.yml`, `e2e.yml`) run it with
 * the default `REDIS_URL` (no path, DB 0) and must keep working unchanged. Every other database
 * needs an explicit non-zero Redis DB index, or this throws before any Postgres or Redis command
 * runs (it does no I/O itself).
 */
export function assertSafeToReset(migrationDatabaseUrl: string, redisUrl: string): void {
  const database = new URL(migrationDatabaseUrl).pathname.slice(1);
  if (database === "invai") return;
  if (!isPinnedNonZeroRedisDb(redisUrl)) {
    throw new Error(
      `[reset] refusing: resetting ${database} would wipe the queues in the shared Redis DB 0. ` +
        "Set REDIS_URL=redis://localhost:6379/<n> (n = 1-15) for this database.",
    );
  }
}

/**
 * Development only: drop and recreate the public schema (and drizzle's migration schema) of the
 * database named in the URL, then make sure the test database exists. Run `db:migrate` next.
 */
export async function resetDatabase(migrationDatabaseUrl: string) {
  if (process.env.NODE_ENV === "production") throw new Error("db:reset is not for production");
  const url = new URL(migrationDatabaseUrl);
  const database = url.pathname.slice(1);

  const pool = new Pool({ connectionString: migrationDatabaseUrl, max: 1 });
  try {
    await pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await pool.query("GRANT ALL ON SCHEMA public TO public");
    await pool.query("GRANT USAGE ON SCHEMA public TO invai_app");
    console.log(`[reset] schema public recreated in ${database}`);
  } finally {
    await pool.end();
  }

  await ensureDatabase(migrationDatabaseUrl, "invai_test");
}

/** Create `name` on the same server when missing (the owner role must be allowed to). */
export async function ensureDatabase(migrationDatabaseUrl: string, name: string) {
  const url = new URL(migrationDatabaseUrl);
  url.pathname = "/postgres";
  const pool = new Pool({ connectionString: url.toString(), max: 1 });
  try {
    const { rowCount } = await pool.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    if (rowCount === 0) {
      await pool.query(`CREATE DATABASE "${name}" OWNER ${url.username}`);
      console.log(`[reset] created database ${name}`);
    }
    await pool.query(`GRANT ALL ON DATABASE "${name}" TO invai_app`).catch(() => {});
  } catch (err) {
    console.warn(`[reset] could not ensure database ${name}: ${(err as Error).message}`);
  } finally {
    await pool.end();
  }
}

/**
 * Remove every job the app's queues hold in the configured Redis DB (wave 19 gate issue 6: a
 * worker started after a reset replayed jobs for rows that no longer existed). One
 * `Queue.obliterate()` per name in QUEUE_NAMES, so only the `bull:<queue>:*` keys of our own
 * queues go; rate-limit counters (`rl:*`), realtime streams (`rt:*`) and every other Redis DB are
 * untouched. Never FLUSHDB or KEYS. `force` also drops a job a running worker is on: after a reset
 * that row is gone anyway. Repeatable sweeps are re-registered when the worker restarts.
 * Returns the number of jobs removed per queue.
 *
 * `prefix` targets the same five queue names under another BullMQ key prefix (the default is
 * BullMQ's `bull`): its test uses one of its own, so it never empties the queues a dev worker is
 * working on in the same Redis DB.
 */
export async function obliterateQueues(opts: { prefix?: string } = {}) {
  if (process.env.NODE_ENV === "production") throw new Error("db:reset is not for production");
  const { QUEUE_NAMES, queues, redis } = await import("../lib/queues");
  const { Queue } = await import("bullmq");
  const own = opts.prefix
    ? QUEUE_NAMES.map((name) => new Queue(name, { connection: redis, prefix: opts.prefix }))
    : null;
  const removed: Record<string, number> = {};
  try {
    for (const [i, name] of QUEUE_NAMES.entries()) {
      const queue = own?.[i] ?? queues[name];
      removed[name] = await queue.getJobCountByTypes(
        "waiting",
        "active",
        "delayed",
        "prioritized",
        "waiting-children",
        "completed",
        "failed",
      );
      await queue.obliterate({ force: true });
    }
  } finally {
    for (const q of own ?? []) await q.close();
  }
  return removed;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { env } = await import("../env");
  assertSafeToReset(env.MIGRATION_DATABASE_URL, env.REDIS_URL);
  await resetDatabase(env.MIGRATION_DATABASE_URL);
  const removed = await obliterateQueues();
  console.log(
    `[reset] queues obliterated in ${new URL(env.REDIS_URL).pathname || "/0"}: ${JSON.stringify(removed)} (restart the worker so its sweeps re-register)`,
  );
  const { closeQueues } = await import("../lib/queues");
  await closeQueues();
}
