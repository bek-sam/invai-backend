/*
 * Release step 3 of 3 (`node dist/db/reference-seed-cli.js`, T-30-2): upsert the global
 * reference data (plan catalog, trademark marks) as the owner role. No tenant rows. Safe to run
 * on every release; `migrate-cli` already does the same, this keeps the step explicit.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { runReleaseStep } from "./bootstrap";
import { ensureReferenceData } from "./reference";

await runReleaseStep("reference-seed", async () => {
  const { env } = await import("../env");
  const pool = new Pool({ connectionString: env.MIGRATION_DATABASE_URL, max: 1 });
  try {
    await ensureReferenceData(drizzle(pool, { casing: "snake_case" }));
    const counts = await pool.query<{ plans: number; marks: number }>(
      "select (select count(*)::int from plans) as plans, (select count(*)::int from trademark_marks) as marks",
    );
    const c = counts.rows[0];
    return `plans=${c?.plans} trademark_marks=${c?.marks}`;
  } finally {
    await pool.end();
  }
});
