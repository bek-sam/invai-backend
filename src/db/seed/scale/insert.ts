import type { PgTable } from "drizzle-orm/pg-core";
import type { Tx } from "../../client";

/*
 * Chunked multi-row inserts (spec rule: at most 5,000 rows per statement; Postgres allows
 * 65,535 bind parameters per statement, so wide tables get fewer rows per statement).
 */
export const MAX_ROWS_PER_STATEMENT = 5000;
export const MAX_PARAMS_PER_STATEMENT = 60_000;

export function rowsPerStatement(columns: number): number {
  return Math.max(
    1,
    Math.min(MAX_ROWS_PER_STATEMENT, Math.floor(MAX_PARAMS_PER_STATEMENT / columns)),
  );
}

export function chunkRows<T extends object>(rows: readonly T[]): T[][] {
  if (!rows.length) return [];
  let columns = 1;
  for (const r of rows) columns = Math.max(columns, Object.keys(r).length);
  const size = rowsPerStatement(columns);
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/** The slice of `Tx` the seed uses, so a test can pass a recording double. */
export type InsertTx = {
  insert: (table: PgTable) => { values: (rows: never) => PromiseLike<unknown> };
};

export async function insertChunked<T extends PgTable>(
  tx: Tx | InsertTx,
  table: T,
  rows: readonly T["$inferInsert"][],
): Promise<number> {
  for (const chunk of chunkRows(rows)) {
    await (tx as InsertTx).insert(table).values(chunk as never);
  }
  return rows.length;
}
