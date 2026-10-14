import { readFileSync } from "node:fs";
import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type { Tx } from "../../src/db/client";
import { assertAllowedSql } from "./sql-guard";

/*
 * The four first pilot queries (spec analytics-first-queries.md; wave 54 T-54-2). Each is one
 * SQL file next to this one. Output columns are pinned here so a test can compare them with the
 * definition file; a rename needs the data-analyst's OK.
 */

export type QueryName = "late_rate" | "overdue_open" | "film_use" | "reprint" | "profit";

export const QUERY_NAMES: readonly QueryName[] = [
  "late_rate",
  "overdue_open",
  "film_use",
  "reprint",
  "profit",
];

export const QUERY_FILES: Record<QueryName, string> = {
  late_rate: "late_rate_drivers.sql",
  overdue_open: "overdue_open.sql",
  film_use: "film_waste_cost.sql",
  reprint: "reprint_cost.sql",
  profit: "contribution_margin.sql",
};

/** Definition file per query, under invai-docs/metrics/definitions/. */
export const DEFINITIONS: Record<QueryName, string> = {
  late_rate: "late_rate.md",
  overdue_open: "overdue_open.md",
  film_use: "film_waste_cost.md",
  reprint: "reprint_cost.md",
  profit: "contribution_margin.md",
};

export const COLUMNS: Record<QueryName, readonly string[]> = {
  // late_rate.md "## Formula" lines 11-16 (numerator, denominator, cuts) + spec AC3 (late_rate_pct)
  late_rate: ["driver", "value", "shipped", "late", "late_rate_pct"],
  // overdue_open.md "## Formula" (columns, architect A2.3)
  overdue_open: [
    "channel",
    "overdue_orders",
    "on_hold_orders",
    "partly_shipped_orders",
    "open_units",
  ],
  // film_waste_cost.md "## Formula" lines 11-15
  film_use: [
    "sheets",
    "film_cost_cents",
    "film_waste_cents",
    "film_use_pct",
    "sheets_without_cost",
  ],
  // reprint_cost.md "## Formula" lines 11-16 + spec AC6 (rate_pct)
  reprint: ["reason", "reprints", "items_pressed", "rate_pct", "cost_cents"],
  // contribution_margin.md "## Formula" lines 11-18 + spec AC7 (cm3_pct, profit per order)
  profit: [
    "channel",
    "orders",
    "units",
    "estimated_units",
    "orders_without_profit_line",
    "revenue_cents",
    "cm1_cents",
    "cm2_cents",
    "cm3_cents",
    "cm3_pct",
    "profit_per_order_cents",
  ],
};

/** `now`: ISO instant that stands in for the database clock (overdue_open only); null or absent = now(). */
export type QueryParams = { companyId: string; from: string; to: string; now?: string | null };
export type Row = Record<string, string | number | null>;

const PLACEHOLDER = /(?<!:):(company_id|from|to|now)\b/g;

/** Comments out of the way: they hold words and placeholders the statement must not see. */
export function stripComments(text: string): string {
  return text.replace(/--[^\n]*/g, "");
}

export function readQuerySql(name: QueryName): string {
  return readFileSync(new URL(QUERY_FILES[name], import.meta.url), "utf8");
}

/** Placeholders become bound parameters (drizzle chunks); the file text is never string-built. */
export function bindQuery(text: string, p: QueryParams): SQL {
  const body = stripComments(text);
  assertAllowedSql(body); // first: nothing builds an analytics SQL object without the allow-list (S-97)
  const values = {
    company_id: p.companyId,
    from: p.from,
    to: p.to,
    now: p.now ?? null,
  } as const;
  const chunks: SQL[] = [];
  let last = 0;
  for (const m of body.matchAll(PLACEHOLDER)) {
    chunks.push(sql.raw(body.slice(last, m.index)));
    chunks.push(sql`${values[m[1] as keyof typeof values]}`);
    last = m.index + m[0].length;
  }
  chunks.push(sql.raw(body.slice(last)));
  return sql.join(chunks, sql.raw(""));
}

/**
 * `*_cents` columns are bigint (node-postgres returns int8 as a string): turn them into numbers
 * only when the value is an exact safe integer, else refuse (architect A2.5).
 */
export function normalizeRow(row: Row): Row {
  const out: Row = { ...row };
  for (const [key, value] of Object.entries(out)) {
    if (!key.endsWith("_cents") || typeof value !== "string") continue;
    const n = Number(value);
    if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(n))
      throw new Error(`${key} is not a safe integer`);
    out[key] = n;
  }
  return out;
}

/** Build the statement for one named query; the guard runs here, before any transaction exists. */
export function prepareQuery(name: QueryName, p: QueryParams): SQL {
  return bindQuery(readQuerySql(name), p);
}

export async function runPrepared(tx: Tx, statement: SQL): Promise<Row[]> {
  const result = await tx.execute<Row>(statement);
  return result.rows.map(normalizeRow);
}

export async function runQuery(tx: Tx, name: QueryName, p: QueryParams): Promise<Row[]> {
  return runPrepared(tx, prepareQuery(name, p));
}
