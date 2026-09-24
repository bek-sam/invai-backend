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

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { env } = await import("../env");
  await resetDatabase(env.MIGRATION_DATABASE_URL);
}
