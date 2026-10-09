/*
 * Release step 2 of 3 (`node dist/db/migrate-cli.js`) and `pnpm db:migrate` (T-30-2): apply every
 * pending migration from the `drizzle/` folder next to `dist/` (or the repo root from source),
 * then the reference data. The folder is resolved from this entry file on purpose; see
 * `migrationsFolderFrom`.
 */
import { runReleaseStep } from "./bootstrap";
import { migrationsFolderFrom, runMigrations } from "./migrate";

await runReleaseStep("migrate", async () => {
  const migrationsFolder = migrationsFolderFrom(import.meta.url);
  const { env } = await import("../env");
  await runMigrations(env.MIGRATION_DATABASE_URL, { migrationsFolder, quiet: true });
  return `up to date (${new URL(env.MIGRATION_DATABASE_URL).pathname.slice(1)})`;
});
