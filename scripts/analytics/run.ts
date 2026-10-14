import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { eq } from "drizzle-orm";
import { closeDb, db, systemPool, withTenantReadOnly } from "../../src/db/client";
import { companies } from "../../src/db/schema";
import { QUERY_NAMES, type QueryName, type Row, runQuery } from "./queries";

/*
 * pnpm analytics --company <slug> --from <YYYY-MM-DD> --to <YYYY-MM-DD> [--query late_rate|overdue_open|film_use|reprint|profit] [--now <ISO instant, overdue_open only>]
 *
 * One shop per run, window [from, to) in the shop's time zone. Prints one JSON document with
 * aggregates only (counts, cents, percents) and the shop's own id on every row. It reads through
 * withTenantReadOnly (app role, read-only transaction); it never uses the owner role and never
 * touches a buyer table. --now affects only overdue_open: it replaces the database clock with an ISO instant, so
 * a test or a past-day report can pin "now"; every other query ignores it. Exit 0 ok, 1 database or lookup failure, 2 bad arguments.
 */

export type Report = {
  header: {
    company_slug: string;
    company_id: string;
    timezone: string;
    from: string;
    to: string;
    data_label: "SEED" | "NOT_SEED";
    queries: QueryName[];
    /** The instant overdue_open used as now: the --now value, or null for the database clock. */
    now: string | null;
    note: string;
  };
  queries: Partial<Record<QueryName, Array<Row & { company_id: string }>>>;
};

export class UsageError extends Error {}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function realDate(value: string, label: string): number {
  const ms = Date.parse(`${value}T00:00:00Z`);
  const ok = DATE.test(value) && !Number.isNaN(ms) && new Date(ms).toISOString().startsWith(value);
  if (!ok) throw new UsageError(`${label} must be a real date as YYYY-MM-DD`);
  return ms;
}

/** Both dates real, and from strictly before to. */
export function parseWindow(from: string, to: string) {
  if (realDate(from, "--from") >= realDate(to, "--to"))
    throw new UsageError("--from must be before --to");
  return { from, to };
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

/** An ISO 8601 instant with a zone, as typed on the command line. */
export function parseNow(value: string): string {
  if (!ISO_INSTANT.test(value) || Number.isNaN(Date.parse(value)))
    throw new UsageError("--now must be an ISO instant such as 2026-10-14T12:00:00Z");
  return value;
}

/** The demo shop and the scale-profile shops hold generated data, never a business result. */
export function isSeedSlug(slug: string): boolean {
  return slug === "desert-bloom-tees" || slug.startsWith("seed-scale-");
}

export async function runReport(input: {
  slug: string;
  from: string;
  to: string;
  queries?: readonly QueryName[];
  now?: string;
}): Promise<Report> {
  const { from, to } = parseWindow(input.from, input.to);
  const now = input.now === undefined ? null : parseNow(input.now);
  const queries = [...(input.queries ?? QUERY_NAMES)];
  // The one lookup outside a tenant scope: `companies` has no RLS, so it is read by slug here and
  // only by the bound id inside the queries.
  const [company] = await db
    .select({ id: companies.id, slug: companies.slug, timezone: companies.timezone })
    .from(companies)
    .where(eq(companies.slug, input.slug));
  if (!company) throw new UsageError("company not found");

  const out: Report["queries"] = {};
  await withTenantReadOnly(company.id, async (tx) => {
    for (const name of queries) {
      const rows = await runQuery(tx, name, { companyId: company.id, from, to, now });
      out[name] = rows.map((r) => ({ company_id: company.id, ...r }));
    }
  });
  return {
    header: {
      company_slug: company.slug,
      company_id: company.id,
      timezone: company.timezone,
      from,
      to,
      data_label: isSeedSlug(company.slug) ? "SEED" : "NOT_SEED",
      queries,
      now,
      note: "Aggregates only. Window [from, to) in the shop time zone. Percents are null below each metric's minimum sample.",
    },
    queries: out,
  };
}

/** Postgres or socket error code only: the message can carry the connection string. */
function errorCode(err: unknown): string {
  const e = err as { code?: unknown; cause?: { code?: unknown } };
  const code = e?.cause?.code ?? e?.code;
  return typeof code === "string" && /^[A-Za-z0-9_]{1,16}$/.test(code) ? code : "unknown";
}

export async function main(argv: string[]): Promise<number> {
  let report: Report;
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        company: { type: "string" },
        from: { type: "string" },
        to: { type: "string" },
        query: { type: "string" },
        now: { type: "string" },
      },
      strict: true,
    });
    if (!values.company || !values.from || !values.to)
      throw new UsageError(
        "usage: --company <slug> --from <YYYY-MM-DD> --to <YYYY-MM-DD> [--query <name>] [--now <ISO instant, overdue_open only>]",
      );
    const query = values.query as QueryName | undefined;
    if (query && !QUERY_NAMES.includes(query))
      throw new UsageError(`--query must be one of ${QUERY_NAMES.join(", ")}`);
    parseWindow(values.from, values.to);
    report = await runReport({
      slug: values.company,
      from: values.from,
      to: values.to,
      queries: query ? [query] : undefined,
      now: values.now,
    });
    if (systemPool.totalCount !== 0) throw new Error("owner pool was used");
  } catch (err) {
    await closeDb().catch(() => undefined);
    if (
      err instanceof UsageError ||
      (err as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")
    ) {
      console.error(`analytics: ${(err as Error).message}`);
      return err instanceof UsageError && err.message === "company not found" ? 1 : 2;
    }
    console.error(`analytics: database error (code ${errorCode(err)})`);
    return 1;
  }
  console.log(JSON.stringify(report, null, 2));
  await closeDb();
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
