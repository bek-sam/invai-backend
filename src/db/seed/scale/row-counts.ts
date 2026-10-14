import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

/*
 * Per-table row counts of a database (T-54-3, AC1). `--write <file>` records the counts,
 * `--check <file>` compares them and exits 1 on any difference. The database comes from
 * MIGRATION_DATABASE_URL (owner role, sees every row). Only `pg` is imported on purpose, so the
 * tool opens no queue, no env parser and nothing that could write.
 */
export type RowCounts = Record<string, number>;

export async function countAllTables(connectionString: string): Promise<RowCounts> {
  const pool = new Pool({ connectionString, max: 1 });
  try {
    const { rows } = await pool.query<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`,
    );
    const out: RowCounts = {};
    for (const { table_name } of rows) {
      const res = await pool.query<{ n: string }>(`select count(*) as n from "${table_name}"`);
      out[table_name] = Number(res.rows[0]?.n ?? 0);
    }
    return out;
  } finally {
    await pool.end();
  }
}

export function diffCounts(expected: RowCounts, actual: RowCounts): string[] {
  const diffs: string[] = [];
  for (const t of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
    if (expected[t] !== actual[t]) diffs.push(`${t}: snapshot ${expected[t]} vs now ${actual[t]}`);
  }
  return diffs;
}

async function main() {
  const [mode, file] = process.argv.slice(2);
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url || !file || (mode !== "--write" && mode !== "--check")) {
    console.error("usage: MIGRATION_DATABASE_URL=... tsx row-counts.ts --write|--check <file>");
    process.exit(2);
  }
  const counts = await countAllTables(url);
  if (mode === "--write") {
    writeFileSync(file, `${JSON.stringify(counts, null, 2)}\n`);
    console.log(`wrote ${Object.keys(counts).length} tables to ${file}`);
    return;
  }
  const diffs = diffCounts(JSON.parse(readFileSync(file, "utf8")) as RowCounts, counts);
  if (diffs.length) {
    console.error(`row counts differ in ${diffs.length} table(s):\n${diffs.join("\n")}`);
    process.exit(1);
  }
  console.log(`row counts match the snapshot (${Object.keys(counts).length} tables)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
