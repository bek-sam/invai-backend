import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db, withTenantReadOnly } from "../../src/db/client";
import { bindQuery } from "./queries";
import { ALLOWED_CALLS, NON_CALL_KEYWORDS, SqlGuardError } from "./sql-guard";
import { makeShop } from "./testkit";

/*
 * Checks against the harness Postgres 17 (wave 57 T-57-1; architect A1.4, A1.6, A1.7): the
 * keyword set holds no function name, every catalog function that runs its argument as SQL is
 * refused, and the S-97 cross-tenant read is gone. The harness hands each run its own database.
 */

const P = {
  companyId: "00000000-0000-4000-8000-000000000001",
  from: "2026-01-01",
  to: "2026-02-01",
};
const refused = (text: string) => {
  try {
    bindQuery(text, P);
  } catch (e) {
    return e instanceof SqlGuardError;
  }
  return false;
};

type ProcRow = { proname: string; nargs: number; argkinds: string[] };

async function procs(where: ReturnType<typeof sql>): Promise<ProcRow[]> {
  const r = await db.execute<ProcRow>(sql`
    select p.proname,
           p.pronargs::int as nargs,
           coalesce(
             (select array_agg(case when t.typtype = 'c' then 'composite' else t.typname end order by u.ord)
                from unnest(p.proargtypes::oid[]) with ordinality as u(oid, ord)
                join pg_type t on t.oid = u.oid),
             '{}') as argkinds
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where ${where}`);
  return r.rows;
}

describe("keywords are never functions (A1.4)", () => {
  it("no pg_proc row has the name of a keyword the guard lets stand before a paren", async () => {
    const names = [...NON_CALL_KEYWORDS];
    const r = await db.execute<{ proname: string }>(
      sql`select proname from pg_proc where proname in (${sql.join(
        names.map((n) => sql`${n}`),
        sql`, `,
      )})`,
    );
    expect(r.rows).toEqual([]);
  });

  it("the allowed names are plain internal, C or SQL functions: none is SECURITY DEFINER or procedural", async () => {
    const names = [...ALLOWED_CALLS];
    const r = await db.execute<{ proname: string; lanname: string; prosecdef: boolean }>(sql`
      select p.proname, l.lanname, p.prosecdef
        from pg_proc p join pg_language l on l.oid = p.prolang
       where p.proname in (${sql.join(
         names.map((n) => sql`${n}`),
         sql`, `,
       )})`);
    expect(r.rows.length).toBeGreaterThan(0);
    for (const row of r.rows) {
      expect(["internal", "c", "sql"], row.proname).toContain(row.lanname);
      expect(row.prosecdef, row.proname).toBe(false);
    }
  });
});

describe("sweep: every function that runs its argument as SQL is refused (AC5, A1.7)", () => {
  const families: Array<[string, ReturnType<typeof sql>]> = [
    ["ts_stat", sql`p.proname = 'ts_stat'`],
    ["ts_rewrite", sql`p.proname = 'ts_rewrite'`],
    ["query_to_xml", sql`p.proname like 'query\_to\_xml%'`],
    ["cursor_to_xml", sql`p.proname like 'cursor\_to\_xml%'`],
    ["table/schema/database_to_xml", sql`p.proname ~ '^(table|schema|database)_to_xml'`],
    ["dblink", sql`p.proname like 'dblink%'`],
  ];

  it.each(families)(
    "family %s: found on this server, each name refused as a call",
    async (family, where) => {
      const rows = await procs(where);
      // ts_stat, ts_rewrite and the xml families ship with Postgres 17; dblink is not installed
      if (family === "dblink") expect(rows).toEqual([]);
      else expect(rows.length).toBeGreaterThan(0);
      for (const name of new Set(rows.map((r) => r.proname))) {
        expect(refused(`select * from ${name}('select 1')`), name).toBe(true);
        expect(refused(`select * from pg_catalog.${name}('select 1')`), name).toBe(true);
        expect(refused(`select * from "${name}"('select 1')`), name).toBe(true);
      }
      // a family is never on either list
      for (const name of new Set(rows.map((r) => r.proname))) {
        expect(ALLOWED_CALLS.has(name), name).toBe(false);
        expect(NON_CALL_KEYWORDS.has(name), name).toBe(false);
      }
    },
  );

  it("ts_stat also in attribute form (no paren after the name)", () => {
    expect(refused("select ('select to_tsvector(''hello'')'::text).ts_stat")).toBe(true);
    expect(refused("select (s.q).ts_stat from s")).toBe(true);
    expect(refused("select x.arr[1].ts_stat from x")).toBe(true);
  });

  it("no SECURITY DEFINER or EXECUTE-using function in schema public; any that appears is refused", async () => {
    const rows = await procs(
      sql`n.nspname = 'public' and (p.prosecdef or p.prosrc ~* '\mexecute\M')`,
    );
    for (const name of new Set(rows.map((r) => r.proname)))
      expect(refused(`select ${name}(1)`), name).toBe(true);
    expect(rows).toEqual([]);
  });

  it("no exec-family function takes one record, anyelement, any or composite argument (the alias.fn form)", async () => {
    const rows = await procs(
      sql`p.proname in ('ts_stat','ts_rewrite') or p.proname ~ '^(query|cursor|table|schema|database)_to_xml' or p.proname like 'dblink%'`,
    );
    const single = rows.filter((r) => r.nargs === 1);
    for (const r of single) {
      const k = r.argkinds[0] as string;
      expect(["record", "anyelement", "any", "composite"], `${r.proname}(${k})`).not.toContain(k);
    }
  });
});

describe("cross-tenant read through a query-running function (AC4, S-97)", () => {
  const seen = "(select max(company_id::text) from channel_connections) as seen";

  // The inner query switches app.company_id; the outer scan then reads the other shop's rows.
  const attack = (inner: string) =>
    `select ${seen} from (select * from ts_stat(${inner}) offset 0) s limit 1`;

  async function attempt(shopId: string, text: string) {
    try {
      const rows = await withTenantReadOnly(shopId, async (tx) => {
        const r = await tx.execute<{ seen: string | null }>(bindQuery(text, P));
        return r.rows;
      });
      return { error: null, seen: rows[0]?.seen ?? null };
    } catch (error) {
      return { error, seen: null };
    }
  }

  it("is refused in all four builder forms, and no row of the other shop comes back", async () => {
    const a = await makeShop("Europe/Madrid");
    const b = await makeShop("Europe/Madrid");
    const set = `select to_tsvector(set_config('app.company_id','${b.id}',true))`;
    const forms: Array<[string, string]> = [
      ["plain string", attack(`'${set.replaceAll("'", "''")}'`)],
      [
        "concatenation",
        attack(`'select to_tsvector(se'||'t_config(''app.company_id'',''${b.id}'',true))'`),
      ],
      ["dollar quotes", attack(`$q$${set}$q$`)],
      [
        "chr(115)",
        attack(`chr(115)||'elect to_tsvector(set_config(''app.company_id'',''${b.id}'',true))'`),
      ],
      [
        "attribute form",
        `select (select max(company_id::text) from channel_connections) as seen from (select ('${set.replaceAll("'", "''")}'::text).ts_stat) s`,
      ],
    ];
    // control: an allowed query sees only the caller's own shop
    const own = await attempt(
      a.id,
      "select max(company_id::text) as seen from channel_connections",
    );
    expect(own.error).toBeNull();
    expect(own.seen).toBe(a.id);
    for (const [name, text] of forms) {
      const r = await attempt(a.id, text);
      expect(r.error, name).toBeInstanceOf(SqlGuardError);
      // refused for the query-running call or a fail-closed form, never for the outer max()
      expect((r.error as Error).message, name).toMatch(
        /function ts_stat is not|\$ outside quotes|attribute notation/,
      );
      expect(r.seen, name).toBeNull();
    }
  });
});
