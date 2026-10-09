import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { env } from "../env";
import { migrationsFolderFrom } from "./migrate";

/*
 * T-30-2: the release CLIs (`bootstrap-cli`, `migrate-cli`, `reference-seed-cli`) as processes.
 * Run from source through tsx, from a directory outside the repo, each bounded to 60 s: a step
 * that finishes but leaves a pg or Redis handle open would hit the bound (or print the
 * open-handles warning). Bootstrap only runs here in ways that refuse before connecting; roles
 * are cluster-wide (see bootstrap.test.ts).
 */
const run = promisify(execFile);
const TSX = import.meta.resolve("tsx");
const SECRET = "Sup3rSecretPw-t30";

const cli = (file: string) => fileURLToPath(new URL(`./${file}.ts`, import.meta.url));

/** The minimum src/env.ts needs outside NODE_ENV=test (whose URLs redirect to invai_test). */
function baseEnv(extra: Record<string, string>) {
  return {
    PATH: process.env.PATH ?? "",
    NODE_ENV: "development",
    INVAI_SKIP_DOTENV: "1",
    DATABASE_URL: env.DATABASE_URL,
    MIGRATION_DATABASE_URL: env.MIGRATION_DATABASE_URL,
    REDIS_URL: env.REDIS_URL,
    S3_BUCKET: "invai-local",
    IMAGING_URL: "http://localhost:8000",
    BETTER_AUTH_SECRET: "x".repeat(32),
    BETTER_AUTH_URL: "http://localhost:3000",
    WEB_ORIGIN: "http://localhost:5173",
    FIELD_ENCRYPTION_KEY: "k1:KzQaGJQ4pwuYge713w7utD2NrzYH21qNtk//UkCed+E=",
    ...extra,
  };
}

async function runCli(file: string, extra: Record<string, string>) {
  const started = Date.now();
  try {
    const { stdout, stderr } = await run(process.execPath, ["--import", TSX, cli(file)], {
      env: baseEnv(extra),
      cwd: tmpdir(),
      timeout: 60_000,
    });
    return { code: 0, out: stdout + stderr, ms: Date.now() - started };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return {
      code: e.code ?? -1,
      out: `${e.stdout ?? ""}${e.stderr ?? ""}`,
      ms: Date.now() - started,
    };
  }
}

/** The CLI's own lines (tsx and the mock-provider warning may add others). */
const lines = (out: string, name: string) =>
  out.split("\n").filter((l) => l.startsWith(`[${name}]`));

describe("migrations folder", () => {
  it("resolves from the CLI entry to the drizzle folder with its journal", () => {
    const folder = migrationsFolderFrom(new URL("./migrate-cli.ts", import.meta.url).href);
    expect(existsSync(join(folder, "meta", "_journal.json"))).toBe(true);
    expect(folder.endsWith("/drizzle")).toBe(true);
  });

  it("throws on a location with no journal (a shared chunk one level too high)", () => {
    expect(() => migrationsFolderFrom(new URL("../chunk-x.js", import.meta.url).href)).toThrow(
      "has no meta/_journal.json",
    );
  });
});

describe("release CLIs as processes", () => {
  const name = `invai_test_release_${Date.now().toString(36)}`;
  const at = (url: string, db: string) => {
    const u = new URL(url);
    u.pathname = `/${db}`;
    return u.toString();
  };
  const scratch = at(env.MIGRATION_DATABASE_URL, name);

  beforeAll(async () => {
    const server = new Client({ connectionString: at(env.MIGRATION_DATABASE_URL, "postgres") });
    await server.connect();
    await server.query(`CREATE DATABASE "${name}"`);
    await server.end();
  });

  afterAll(async () => {
    const server = new Client({ connectionString: at(env.MIGRATION_DATABASE_URL, "postgres") });
    await server.connect();
    await server.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await server.end();
  });

  it("migrate-cli then reference-seed-cli twice: exit 0 on their own, same counts", async () => {
    const migrate = await runCli("migrate-cli", { MIGRATION_DATABASE_URL: scratch });
    expect(migrate.code, migrate.out).toBe(0);
    expect(lines(migrate.out, "migrate")).toEqual([`[migrate] up to date (${name})`]);
    expect(migrate.out).not.toContain("open handles");

    const first = await runCli("reference-seed-cli", { MIGRATION_DATABASE_URL: scratch });
    const second = await runCli("reference-seed-cli", { MIGRATION_DATABASE_URL: scratch });
    expect(first.code, first.out).toBe(0);
    expect(second.code, second.out).toBe(0);
    expect(lines(first.out, "reference-seed")).toEqual(lines(second.out, "reference-seed"));
    expect(lines(first.out, "reference-seed")[0]).toMatch(
      /^\[reference-seed\] plans=\d+ trademark_marks=\d+$/,
    );
    expect(first.out + second.out).not.toContain("open handles");

    const owner = new Client({ connectionString: scratch });
    await owner.connect();
    const tenants = await owner.query("select count(*)::int as n from companies");
    await owner.end();
    expect(tenants.rows[0].n).toBe(0);
  }, 120_000);

  it("fails with one secret-free line, no stack, on a bad or unreachable URL", async () => {
    const cases = [
      [
        "bootstrap-cli",
        "bootstrap",
        { DATABASE_URL: `postgres://invai_app:${SECRET}@bad host/invai` },
      ],
      ["bootstrap-cli", "bootstrap", { MIGRATION_DATABASE_URL: "" }],
      [
        "migrate-cli",
        "migrate",
        { MIGRATION_DATABASE_URL: `postgres://invai:${SECRET}@bad host/invai` },
      ],
      [
        "migrate-cli",
        "migrate",
        { MIGRATION_DATABASE_URL: `postgres://invai:${SECRET}@localhost:1/invai` },
      ],
      [
        "reference-seed-cli",
        "reference-seed",
        { MIGRATION_DATABASE_URL: `postgres://invai:${SECRET}@localhost:1/x` },
      ],
    ] as const;
    for (const [file, label, extra] of cases) {
      const res = await runCli(file, extra);
      expect(res.code, res.out).toBe(1);
      expect(res.out).not.toContain(SECRET);
      expect(res.out).not.toMatch(/\n\s+at /);
      expect(lines(res.out, label)).toHaveLength(1);
      expect(lines(res.out, label)[0]).toMatch(new RegExp(`^\\[${label}\\] failed`));
    }
  }, 120_000);
});
