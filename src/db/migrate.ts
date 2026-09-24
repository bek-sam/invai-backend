import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

/** Required extensions; `vector` is optional until the pgvector image is in place. */
const EXTENSIONS: { name: string; required: boolean }[] = [
  { name: "pg_trgm", required: true },
  { name: "pgcrypto", required: true },
  { name: "citext", required: false },
  { name: "vector", required: false },
];

/**
 * Apply every migration in ./drizzle as the owner role. Safe to run repeatedly.
 * Used by `pnpm db:migrate` and by the test global setup (against the test database).
 */
export async function runMigrations(migrationDatabaseUrl: string, opts: { quiet?: boolean } = {}) {
  const log = opts.quiet ? () => {} : (msg: string) => console.log(`[migrate] ${msg}`);
  const pool = new Pool({ connectionString: migrationDatabaseUrl, max: 1 });
  try {
    for (const ext of EXTENSIONS) {
      try {
        await pool.query(`CREATE EXTENSION IF NOT EXISTS "${ext.name}"`);
      } catch (err) {
        if (ext.required) throw err;
        log(`optional extension ${ext.name} unavailable: ${(err as Error).message}`);
      }
    }
    const db = drizzle(pool);
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    log(`up to date (${new URL(migrationDatabaseUrl).pathname.slice(1)})`);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { env } = await import("../env");
  await runMigrations(env.MIGRATION_DATABASE_URL);
}
