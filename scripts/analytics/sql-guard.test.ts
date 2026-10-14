import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { bindQuery, QUERY_FILES, readQuerySql, stripComments } from "./queries";
import { ALLOWED_CALLS, assertAllowedSql, NON_CALL_KEYWORDS, SqlGuardError } from "./sql-guard";

/*
 * The function allow-list (wave 57 T-57-1, S-97, architect A1.0-A1.8). Everything here goes
 * through bindQuery, the one place the runner builds an analytics statement, so a refusal is the
 * production refusal. Strings with backslashes use String.raw and were checked with od -c.
 */

const here = dirname(fileURLToPath(import.meta.url));
const P = {
  companyId: "00000000-0000-4000-8000-000000000001",
  from: "2026-01-01",
  to: "2026-02-01",
};
const bind = (text: string) => bindQuery(text, P);
const refuses = (text: string, re: RegExp) => {
  const run = () => bind(text);
  expect(run).toThrow(SqlGuardError);
  expect(run).toThrow(re);
};
const B = "11111111-1111-4111-8111-111111111111";

describe("the committed files (AC1)", () => {
  const files = readdirSync(here).filter((f) => f.endsWith(".sql"));
  it("are the five query files, each passes the guard on the comment-stripped text", () => {
    expect(files.sort()).toEqual(Object.values(QUERY_FILES).sort());
    for (const f of files) {
      const text = stripComments(readFileSync(join(here, f), "utf8"));
      expect(() => assertAllowedSql(text), f).not.toThrow();
    }
  });

  it("build through bindQuery, the production path", () => {
    for (const name of Object.keys(QUERY_FILES) as Array<keyof typeof QUERY_FILES>)
      expect(() => bind(readQuerySql(name))).not.toThrow();
  });

  it("make exactly the calls A1.3 names, and use exactly the 10 keywords A1.4 lists", () => {
    const calls = new Set<string>();
    const words = new Set<string>();
    for (const f of files) {
      const text = stripComments(readFileSync(join(here, f), "utf8"));
      for (const m of text.matchAll(/([a-z_][a-z0-9_]*)\s*\(/gi)) {
        const w = (m[1] as string).toLowerCase();
        (ALLOWED_CALLS.has(w) ? calls : words).add(w);
      }
    }
    expect([...calls].sort()).toEqual(
      "bool_or coalesce count floor lead least now nullif round sum".split(" "),
    );
    expect([...words].sort()).toEqual(
      "as by exists filter from in over select sets when".split(" "),
    );
    expect(words.size).toBe(10);
  });
});

describe("what passes", () => {
  it.each([
    ["an allowed call", "select count(*), coalesce(sum(x), 0) from t"],
    ["a quoted allowed name, exact case", 'select "count"(*) from t'],
    ["keywords before a paren", "select 1 where x in (1,2) and (a or b) and not (c)"],
    ["a cast without a modifier", "select x::numeric, y::timestamptz from t"],
    ["a comment holding a denied name (stripped first)", "select 1 -- ts_stat('x')\n"],
    ["a string holding a call-looking word", "select 'ts_stat(1)' as note"],
    ["a doubled quote inside a string", "select 'it''s' as s"],
    ["a decimal number and a column path", "select o.total * 1.5 from orders o"],
    ["a dot after a name, not after a paren", "select a.b.c from a"],
  ])("%s", (_n, text) => {
    expect(() => bind(text)).not.toThrow();
  });
});

describe("planted refusals through bindQuery (AC3, A1.6)", () => {
  const innerBuilders: Array<[string, string]> = [
    [
      "concatenation",
      `select * from ts_stat('select to_tsvector(se'||'t_config(''app.company_id'',''${B}'',true))')`,
    ],
    [
      "E'' hex escape",
      String.raw`select * from ts_stat(E'select to_tsvector(\x73et_config(''app.company_id'',''${B}'',true))')`,
    ],
    [
      "dollar quotes",
      `select * from ts_stat($q$select to_tsvector(set_config('app.company_id','${B}',true))$q$)`,
    ],
    [
      "chr(115)",
      `select * from ts_stat(chr(115)||'elect to_tsvector(set_config(''app.company_id'',''${B}'',true))')`,
    ],
  ];

  it.each([
    ["ts_stat", "select * from ts_stat('select 1')", /ts_stat/],
    ["ts_stat upper case", "select * from TS_STAT('select 1')", /ts_stat/],
    [
      "schema-qualified",
      "select * from pg_catalog.ts_stat('select 1')",
      /qualified call ts_stat\(/,
    ],
    [
      "qualified with spaces",
      "select * from pg_catalog . ts_stat ('select 1')",
      /qualified call ts_stat\(/,
    ],
    ["qualified, any last part", "select pg_catalog.count(*) from t", /qualified call count\(/],
    ["quoted name", "select * from \"ts_stat\"('select 1')", /function ts_stat is not/],
    ["quoted, other case", "select * from \"TS_STAT\"('select 1')", /function TS_STAT is not/],
    ["quoted allowed name in the wrong case", 'select "COUNT"(*) from t', /function COUNT is not/],
    ["ts_rewrite", "select ts_rewrite('a'::tsquery, 'select 1')", /ts_rewrite/],
    ["query_to_xml", "select query_to_xml('select 1', true, true, '')", /query_to_xml/],
    ["set_config", "select set_config('app.company_id', 'x', true)", /set_config/],
    ["newline before the paren", "select * from ts_stat\n('select 1')", /ts_stat/],
    ["tab and spaces before the paren", "select ts_stat \t ('x')", /ts_stat/],
    ["a type with a modifier", "select x::numeric(10,2) from t", /function numeric is not/],
    ["a keyword quoted is a name", 'select "from"(1)', /function from is not/],
  ])("%s", (_n, text, re) => refuses(text, re));

  it.each(innerBuilders)("the S-97 inner-query builder, %s, wrapped in ts_stat", (_n, text) => {
    const run = () => bind(text);
    expect(run).toThrow(SqlGuardError);
    // either the call is named, or a fail-closed form is (the dollar and E'' builders)
    expect(run).toThrow(/ts_stat|\$ outside|escape string/);
  });

  it("a call after a block comment: the comment itself is refused", () => {
    refuses("select 1 /* x */ ts_stat('select 1')", /block comment \/\*/);
    refuses("select 1 /* never closed", /block comment \/\*/);
    refuses("select 1 */ x", /block comment \*\//);
    refuses("select 1 /*/ ts_stat('x') /* */", /block comment/);
  });

  it("attribute notation, with no paren after the name (A1.0)", () => {
    refuses("select ('select to_tsvector(''hello'')'::text).ts_stat", /attribute notation/);
    refuses("select (s.q).ts_stat from s", /attribute notation/);
    refuses("select x.arr[1].ts_stat from x", /attribute notation/);
    refuses("select x . arr [1] . ts_stat from x", /attribute notation/);
    refuses("select (x\n)\n.\nts_stat from x", /attribute notation/);
    refuses("select (((x))).y from t", /attribute notation/);
  });

  it("fail-closed forms (A1.5)", () => {
    refuses("select $1", /\$ outside quotes/);
    refuses("select a$b from t", /\$ outside quotes/);
    refuses("select $q$x$q$", /\$ outside quotes/);
    refuses("select E'x'", /escape string/);
    refuses("select e'x'", /escape string/);
    refuses("select 1 ; select 2", /; outside quotes/);
    refuses("select 'a;b' ; ", /; outside quotes/);
    refuses(String.raw`select 'a\x73b'`, /backslash/);
    refuses(String.raw`select "a\b"`, /backslash/);
    refuses(String.raw`select a \ b`, /backslash/);
    refuses("select U&'x'", /U& string/);
    refuses('select u&"x"', /U& string/);
    refuses("select 'x' uescape '!'", /UESCAPE/);
    refuses("select 'abc", /unterminated quote/);
    refuses('select "abc', /unterminated quote/);
    refuses("select 'a''", /unterminated quote/);
    refuses("select 1a from t", /number glued/);
    refuses("select 1_000 from t", /number glued/);
    refuses("select 10e from t", /number glued/);
    refuses("select é from t", /outside printable ASCII/);
    refuses("select 1\u000b from t", /outside printable ASCII/);
    refuses("select \u0000 from t", /outside printable ASCII/);
  });

  it("a line comment that hides an unterminated quote is still refused after stripping", () => {
    refuses("select 'a--b' from t", /unterminated quote/);
  });

  it("an error names the function and the offset, never the whole query", () => {
    const text = `select 1 from t where note = '${"x".repeat(300)}' and ts_stat('select 1')`;
    try {
      bind(text);
      expect.unreachable();
    } catch (e) {
      const m = (e as SqlGuardError).message;
      expect(m).toMatch(/ts_stat is not on the allow-list \(offset \d+\)/);
      expect(m.length).toBeLessThan(100);
      expect((e as SqlGuardError).offset).toBe(text.indexOf("ts_stat"));
    }
  });
});

describe("the keyword set cannot hide a call (A1.4)", () => {
  it("a keyword name is never an allowed call, and no allowed call is a keyword", () => {
    for (const k of NON_CALL_KEYWORDS) expect(ALLOWED_CALLS.has(k), k).toBe(false);
    for (const bad of [
      "ts_stat",
      "ts_rewrite",
      "set_config",
      "query_to_xml",
      "like",
      "left",
      "right",
      "extract",
    ])
      expect(NON_CALL_KEYWORDS.has(bad), bad).toBe(false);
  });
  it("the allow-list holds no name that executes its argument", () => {
    for (const bad of [
      "ts_stat",
      "ts_rewrite",
      "set_config",
      "current_setting",
      "query_to_xml",
      "cursor_to_xml",
      "dblink",
    ])
      expect(ALLOWED_CALLS.has(bad), bad).toBe(false);
  });
});

describe("linear time on 200 KB (AC6, A1.8)", () => {
  const KB = 200 * 1024;
  const rep = (unit: string) => unit.repeat(Math.ceil(KB / unit.length)).slice(0, KB);
  const shapes: Array<[string, string]> = [
    ["ident( repeats, allowed", rep("count(")],
    ["ident( repeats, refused at the first", rep("a(")],
    ["quote runs", rep('"')],
    ["single-quote runs", rep("'")],
    ["doubled-quote string", `'${rep("''")}'`],
    ["comment-open runs", rep("/*")],
    ["dollar runs", rep("$")],
    ["glued tokens", rep("1a")],
    ["glued names", rep("a.b")],
    ["paren-dot runs", rep(").x")],
    ["bracket-dot runs", rep("].x")],
    ["name-then-space-then-paren", rep("count (")],
    ["whitespace runs", `select${rep(" ")}1`],
    ["one long identifier", `select ${rep("a")}`],
    ["one long quoted identifier", `select "${rep("a")}"`],
    ["long string", `select '${rep("a")}'`],
  ];
  it.each(shapes)("%s", (_n, text) => {
    expect(text.length).toBeGreaterThanOrEqual(KB - 1);
    // best of three: a loaded machine slows one run, not all three
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      try {
        assertAllowedSql(text);
      } catch (e) {
        expect(e).toBeInstanceOf(SqlGuardError);
      }
      best = Math.min(best, performance.now() - t0);
    }
    expect(best).toBeLessThan(50);
  });
});
