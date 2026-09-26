import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { ensureReferenceData } from "./reference";

const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

/**
 * Fixed, known `pg_advisory_lock` key for `runMigrations` (T-12-2, B-16 follow-up; T-1-5 review:
 * concurrent migrates on a fresh DB race on `CREATE EXTENSION`). The value is arbitrary but must
 * stay stable: any two `runMigrations` calls against the same database, ever, need to contend on
 * this same key to serialize.
 */
const MIGRATION_LOCK_KEY = 468_241;

/** Required extensions; `vector` is optional until the pgvector image is in place. */
const EXTENSIONS: { name: string; required: boolean }[] = [
  { name: "pg_trgm", required: true },
  { name: "pgcrypto", required: true },
  { name: "citext", required: false },
  { name: "vector", required: false },
];

/**
 * Apply every migration in ./drizzle as the owner role, then upsert the global reference data
 * (plan catalog, trademark index — see `./reference`). Safe to run repeatedly. Used by `pnpm
 * db:migrate` and by the test global setup (against the test database). A fresh, empty database
 * has a working trademark check the moment this returns; no seed step is needed.
 */
export async function runMigrations(migrationDatabaseUrl: string, opts: { quiet?: boolean } = {}) {
  const log = opts.quiet ? () => {} : (msg: string) => console.log(`[migrate] ${msg}`);
  // max: 1 so every query below -- the lock, the extensions, the migration and the reference
  // data -- runs on the one physical connection that holds the session-level advisory lock.
  const pool = new Pool({ connectionString: migrationDatabaseUrl, max: 1 });
  try {
    // Serializes concurrent `runMigrations` calls against the same database (a second `pnpm
    // db:migrate`, or two app instances booting at once). Waits, rather than erroring, and is
    // released below even on failure so a crashed migration doesn't wedge the database.
    await pool.query("select pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    try {
      for (const ext of EXTENSIONS) {
        try {
          await pool.query(`CREATE EXTENSION IF NOT EXISTS "${ext.name}"`);
        } catch (err) {
          if (ext.required) throw err;
          log(`optional extension ${ext.name} unavailable: ${(err as Error).message}`);
        }
      }
      const db = drizzle(pool, { casing: "snake_case" });
      await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
      await ensureReferenceData(db);
      log(`up to date (${new URL(migrationDatabaseUrl).pathname.slice(1)})`);
    } finally {
      await pool.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
    }
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { env } = await import("../env");
  await runMigrations(env.MIGRATION_DATABASE_URL);
}
