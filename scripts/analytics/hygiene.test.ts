import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { FIRST_NAMES } from "../../src/db/seed/data";
import { seedValueHits } from "./pii-scan";
import {
  bindQuery,
  COLUMNS,
  DEFINITIONS,
  QUERY_FILES,
  QUERY_NAMES,
  readQuerySql,
  stripComments,
} from "./queries";
import { makeShop } from "./testkit";

/*
 * File-level checks on the four SQL files and the runner (spec analytics-first-queries.md AC1,
 * AC8, AC10, AC11, AC12 and architect A2.3-A2.6): no database needed except the CLI cases.
 */

const here = dirname(fileURLToPath(import.meta.url));
const backend = join(here, "..", "..");
const docs = join(backend, "..", "invai-docs");
const read = (p: string) => readFileSync(p, "utf8");
const sqlFiles = readdirSync(here).filter((f) => f.endsWith(".sql"));

describe("folder and pointers (AC1)", () => {
  it("holds exactly the four single-company SQL files", () => {
    expect(sqlFiles.sort()).toEqual(Object.values(QUERY_FILES).sort());
  });

  it("is pointed to by the definitions README and by each old draft", () => {
    expect(read(join(docs, "metrics", "definitions", "README.md"))).toContain(
      "invai-backend/scripts/analytics/",
    );
    for (const f of sqlFiles) {
      const old = read(join(docs, "metrics", "sql", f));
      expect(old.split("\n")[0]).toBe(`-- moved to invai-backend/scripts/analytics/${f} (wave 54)`);
    }
  });

  it("is not bundled into the API image (AC11)", () => {
    const docker = read(join(backend, "Dockerfile"));
    expect(docker).not.toMatch(/scripts/);
    expect(read(join(backend, "tsup.config.ts"))).not.toMatch(/scripts/);
  });
});

describe("SQL hygiene (A2.3)", () => {
  const forbidden = [
    /set_config/i,
    /\bset\b/i,
    /\breset\b/i,
    /current_setting/i,
    /\bcopy\b/i,
    /dblink/i,
    /pg_read/i,
    /\b(insert|update|delete|drop|alter|create|grant|truncate)\b/i,
  ];

  for (const name of QUERY_NAMES) {
    const file = QUERY_FILES[name];
    const body = stripComments(readQuerySql(name));

    it(`${file}: one statement, three bound placeholders, nothing that writes or switches tenant`, () => {
      expect(body).not.toContain(";");
      const used = new Set([...body.matchAll(/(?<!:):(\w+)\b/g)].map((m) => m[1]));
      expect([...used].sort()).toEqual(["company_id", "from", "to"]);
      for (const re of forbidden) expect(body, String(re)).not.toMatch(re);
    });

    it(`${file}: placeholders become bound parameters, never text`, () => {
      const companyId = "11111111-2222-4333-8444-555555555555";
      const q = new PgDialect().sqlToQuery(
        bindQuery(readQuerySql(name), { companyId, from: "2026-05-04", to: "2026-06-04" }),
      );
      expect(q.sql).not.toContain(companyId);
      expect(q.sql).not.toContain("2026-05-04");
      expect(q.sql).toMatch(/\$1/);
      expect(new Set(q.params)).toEqual(new Set([companyId, "2026-05-04", "2026-06-04"]));
    });
  }
});

describe("no buyer data in any query (AC10, A2.4)", () => {
  const denyTables = [
    "buyer_pii",
    "order_notes",
    "item_artwork",
    "privacy_requests",
    "address_verifications",
  ];
  const denyColumns = [/\bbuyer_note\b/i, /\bpersonalization\b/i, /\braw\b/i, /\bbuyer_ref\b/i];
  const allowedTables = new Set([
    "orders",
    "order_items",
    "order_item_transitions",
    "gang_sheets",
    "reprints",
    "profit_lines",
    "refund_events",
    "companies",
  ]);

  it("the deny list still names real tables (a rename must not empty it)", () => {
    const schema = readdirSync(join(backend, "src", "db", "schema"))
      .map((f) => read(join(backend, "src", "db", "schema", f)))
      .join("\n");
    for (const t of denyTables) expect(schema, t).toContain(`"${t}"`);
  });

  for (const name of QUERY_NAMES) {
    const body = stripComments(readQuerySql(name));
    it(`${QUERY_FILES[name]}: names no buyer table or column and only allowed tables`, () => {
      for (const t of denyTables) expect(body).not.toContain(t);
      for (const re of denyColumns) expect(body).not.toMatch(re);
      const ctes = new Set([...body.matchAll(/(?:WITH|,)\s*(\w+) AS \(/g)].map((m) => m[1]));
      const tables = [...body.matchAll(/\b(?:FROM|JOIN)\s+(\w+)/gi)].map((m) => m[1] as string);
      for (const t of tables) expect(allowedTables.has(t) || ctes.has(t), t).toBe(true);
    });

    it(`${QUERY_FILES[name]}: reads companies only by the bound id (A2.2)`, () => {
      expect(body.match(/\bcompanies\b/g)).toHaveLength(1);
      expect(body).toMatch(/FROM companies WHERE id = :company_id/);
    });
  }

  it("the seed-value scan finds a planted name, a street and a seed e-mail, and nothing in clean text", () => {
    expect(seedValueHits('{"driver":"all","shipped":12}')).toBe(0);
    expect(seedValueHits(`ship to ${FIRST_NAMES[0]} at 1 Main St`)).toBeGreaterThanOrEqual(2);
    expect(seedValueHits("a.b1@example.com")).toBe(1);
  });
});

describe("runner source (AC8, A2.6)", () => {
  const run = read(join(here, "run.ts"));
  const importsOf = (src: string) => [...src.matchAll(/from "([^"]+)"/g)].map((m) => m[1]).sort();

  it("calls the read-only helper and never the owner role or the plain tenant helper", () => {
    expect(run).toContain("withTenantReadOnly(");
    expect(run).not.toMatch(/withSystem|systemDb|withTenant\(|MIGRATION_DATABASE_URL/);
    expect(run).not.toMatch(/\.transaction\(|set transaction/i);
  });

  it("imports only db/client, db/schema and its own SQL runner", () => {
    expect(importsOf(run)).toEqual(
      [
        "./queries",
        "../../src/db/client",
        "../../src/db/schema",
        "drizzle-orm",
        "node:url",
        "node:util",
      ].sort(),
    );
    const queries = read(join(here, "queries.ts"));
    expect(importsOf(queries)).toEqual(
      ["../../src/db/client", "drizzle-orm", "drizzle-orm", "node:fs"].sort(),
    );
  });
});

describe("columns follow the definitions (AC2, A2.5)", () => {
  const spec = read(join(docs, "specs", "analytics-first-queries.md"));
  const named: Record<(typeof QUERY_NAMES)[number], string[]> = {
    late_rate: ["late_rate_pct"],
    film_use: ["film_use_pct", "film_waste_cents"],
    reprint: ["rate_pct"],
    profit: ["cm1_cents", "cm2_cents", "cm3_cents", "cm3_pct"],
  };
  for (const name of QUERY_NAMES) {
    it(`${name}: names in the definition formula or the spec are output columns`, () => {
      const def = read(join(docs, "metrics", "definitions", DEFINITIONS[name])).toLowerCase();
      for (const id of named[name]) {
        expect(COLUMNS[name], id).toContain(id);
        const stem = id.replace(/_cents$/, "").replace(/_pct$/, "");
        expect(def.includes(id) || def.includes(stem) || spec.includes(id), id).toBe(true);
      }
    });
  }
});

describe("command line (AC12, A2.7)", () => {
  const tsx = join(backend, "node_modules", ".bin", "tsx");
  const script = join(here, "run.ts");
  const run = (env: Record<string, string>, args: string[]) =>
    spawnSync(tsx, [script, ...args], {
      cwd: backend,
      env: { ...process.env, INVAI_SKIP_DOTENV: "1", ...env },
      encoding: "utf8",
      timeout: 90_000,
      input: "",
    });

  it("exits 1 with a fixed database message and no connection details when the database is down", () => {
    const url = new URL(process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? "");
    const password = decodeURIComponent(url.password);
    const dead = new URL(url);
    dead.port = "1";
    const res = run({ TEST_DATABASE_URL: dead.toString(), DATABASE_URL: dead.toString() }, [
      "--company",
      "some-shop",
      "--from",
      "2026-05-04",
      "--to",
      "2026-06-04",
    ]);
    const out = `${res.stdout}${res.stderr}`;
    expect(res.status).toBe(1);
    expect(out).toContain("database");
    expect(out).not.toContain(dead.toString());
    expect(out).not.toContain(url.host);
    expect(out).not.toContain("postgres://");
    if (password.length >= 4) expect(out).not.toContain(password);
  });

  it("prints one JSON report for a shop with no data and exits 0 without touching the owner pool", async () => {
    const shop = await makeShop("Europe/Madrid");
    const res = run({}, ["--company", shop.slug, "--from", "2026-05-04", "--to", "2026-06-04"]);
    expect(res.status, res.stderr).toBe(0);
    const json = JSON.parse(res.stdout.slice(res.stdout.indexOf("{")));
    expect(json.header).toMatchObject({ company_slug: shop.slug, data_label: "NOT_SEED" });
    expect(Object.keys(json.queries)).toEqual(["late_rate", "film_use", "reprint", "profit"]);
  });

  it("exits 2 on a bad date and 1 for an unknown shop", () => {
    expect(run({}, ["--company", "x", "--from", "2026-13-01", "--to", "2026-06-04"]).status).toBe(
      2,
    );
    expect(
      run({}, ["--company", "no-such-shop-xyz", "--from", "2026-05-04", "--to", "2026-06-04"])
        .status,
    ).toBe(1);
  });
});
