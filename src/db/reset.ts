import { fileURLToPath } from "node:url";
import { Pool } from "pg";

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
 */
export async function obliterateQueues(): Promise<Record<string, number>> {
  if (process.env.NODE_ENV === "production") throw new Error("db:reset is not for production");
  const { QUEUE_NAMES, queues } = await import("../lib/queues");
  const removed: Record<string, number> = {};
  for (const name of QUEUE_NAMES) {
    const queue = queues[name];
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
  return removed;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { env } = await import("../env");
  await resetDatabase(env.MIGRATION_DATABASE_URL);
  const removed = await obliterateQueues();
  console.log(
    `[reset] queues obliterated in ${new URL(env.REDIS_URL).pathname || "/0"}: ${JSON.stringify(removed)} (restart the worker so its sweeps re-register)`,
  );
  const { closeQueues } = await import("../lib/queues");
  await closeQueues();
}
