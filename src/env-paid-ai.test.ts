import { execFile } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PRODUCTION_KEYS } from "./env";

/*
 * Paid AI is opt-in outside production (T-40-1, decision 0038). Each case boots src/env.ts in a
 * fresh process whose cwd is a temp dir holding a FAKE .env, so the owner's real .env is never
 * read. No provider is ever called: the keys below are fake strings.
 */

const run = promisify(execFile);
const ROOT = resolve(__dirname, "..");
const FAKE_KEY = "sk-fake-paid-ai-test-key-0000";
const TSX = join(ROOT, "node_modules/tsx/dist/esm/index.mjs");

const BASE = {
  PATH: process.env.PATH ?? "",
  DATABASE_URL: "postgres://invai_app:invai@localhost:5432/invai",
  MIGRATION_DATABASE_URL: "postgres://invai:invai@localhost:5432/invai",
  REDIS_URL: "redis://localhost:6379",
  S3_BUCKET: "invai-local",
  IMAGING_URL: "http://localhost:8000",
  BETTER_AUTH_SECRET: "x".repeat(32),
  BETTER_AUTH_URL: "http://localhost:3000",
  WEB_ORIGIN: "http://localhost:5173",
  FIELD_ENCRYPTION_KEY: "k1:KzQaGJQ4pwuYge713w7utD2NrzYH21qNtk//UkCed+E=",
};

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "invai-paid-ai-"));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const PROBE = `
const { env } = await import(${JSON.stringify(join(ROOT, "src/env.ts"))});
const { evalMode, describeMode } = await import(${JSON.stringify(join(ROOT, "evals/lib/mode.ts"))});
const { getImageProvider } = await import(${JSON.stringify(join(ROOT, "src/ai/images/index.ts"))});
const { aiProvider } = await import(${JSON.stringify(join(ROOT, "src/ai/gateway.ts"))});
const img = await getImageProvider("00000000-0000-0000-0000-000000000000");
const gw = await aiProvider("00000000-0000-0000-0000-000000000000");
console.log("RESULT " + JSON.stringify({
  anthropic: env.ANTHROPIC_API_KEY ?? null, openai: env.OPENAI_API_KEY ?? null,
  mockAi: env.mocks.ai, paidAi: env.paidAi, evalMode: evalMode(), describe: describeMode(),
  image: img.name, gateway: gw.name,
}));
process.exit(0);
`;

type Result = {
  anthropic: string | null;
  openai: string | null;
  mockAi: boolean;
  paidAi: boolean;
  evalMode: string;
  describe: string;
  image: string;
  gateway: string;
};

/** Boots env.ts with `dotenv` as the content of a fake .env in a fresh cwd. */
async function boot(opts: { dotenv?: string; env?: Record<string, string> }) {
  const cwd = mkdtempSync(join(tmp, "case-"));
  mkdirSync(cwd, { recursive: true });
  if (opts.dotenv !== undefined) writeFileSync(join(cwd, ".env"), opts.dotenv);
  try {
    const { stdout, stderr } = await run(
      process.execPath,
      ["--import", TSX, "--input-type=module", "-e", PROBE],
      { env: { ...BASE, ...opts.env }, cwd },
    );
    const line = stdout.split("\n").find((l) => l.startsWith("RESULT "));
    return {
      ok: true,
      stderr,
      out: stdout,
      result: line ? (JSON.parse(line.slice(7)) as Result) : null,
    };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { ok: false, stderr: e.stderr ?? "", out: e.stdout ?? "", result: null };
  }
}

const KEYS_IN_FILE = `OPENAI_API_KEY=${FAKE_KEY}\nIMAGE_GEN_PROVIDER=openai\n`;
const NOTICE =
  "AI: mock (paid AI is off; set INVAI_PAID_AI=1 in the shell to use the keys in .env)";

describe("paid AI opt-in (decision 0038)", () => {
  it("AC1: keys from .env are ignored in development without the shell flag", async () => {
    const r = await boot({ dotenv: KEYS_IN_FILE, env: { NODE_ENV: "development" } });
    expect(r.ok).toBe(true);
    expect(r.result).toMatchObject({
      anthropic: null,
      openai: null,
      mockAi: true,
      paidAi: false,
      evalMode: "mock",
      image: "mock",
      gateway: "mock",
    });
    expect(r.result?.describe).toContain("INVAI_PAID_AI=1");
  });

  it("AC1: also locked when NODE_ENV is unset, and for a key that comes from the shell", async () => {
    const unset = await boot({ dotenv: KEYS_IN_FILE });
    expect(unset.result).toMatchObject({ openai: null, mockAi: true, image: "mock" });
    const shellKey = await boot({
      env: { NODE_ENV: "development", ANTHROPIC_API_KEY: FAKE_KEY, INVAI_SKIP_DOTENV: "1" },
    });
    expect(shellKey.result).toMatchObject({ anthropic: null, mockAi: true, gateway: "mock" });
  });

  it("AC2: INVAI_PAID_AI=1 written in .env or .env.local does not opt in", async () => {
    const r = await boot({
      dotenv: `INVAI_PAID_AI=1\n${KEYS_IN_FILE}`,
      env: { NODE_ENV: "development" },
    });
    expect(r.result).toMatchObject({ openai: null, mockAi: true, paidAi: false, evalMode: "mock" });
    expect(r.stderr).toContain(NOTICE);
  });

  it("AC3: with INVAI_PAID_AI=1 in the shell and a key, development uses the real provider", async () => {
    const r = await boot({
      dotenv: KEYS_IN_FILE,
      env: { NODE_ENV: "development", INVAI_PAID_AI: "1" },
    });
    expect(r.result).toMatchObject({
      openai: FAKE_KEY,
      mockAi: false,
      paidAi: true,
      evalMode: "openai",
      image: "openai",
      gateway: "openai",
    });
    expect(r.stderr).not.toContain("paid AI is off");
  });

  it("AC3: only the exact value 1 opts in", async () => {
    for (const v of ["true", "0", "yes", " 1", ""]) {
      const r = await boot({
        dotenv: KEYS_IN_FILE,
        env: { NODE_ENV: "development", INVAI_PAID_AI: v },
      });
      expect(r.result, `value ${JSON.stringify(v)}`).toMatchObject({
        openai: null,
        mockAi: true,
        paidAi: false,
      });
    }
  });

  it("AC4: production uses the keys without the flag and prints no lock line", async () => {
    const keys = Object.fromEntries(PRODUCTION_KEYS.map((k) => [k, `real-${k.toLowerCase()}`]));
    const r = await boot({
      env: { NODE_ENV: "production", ...keys, SMTP_URL: "smtp://mail:25", INVAI_SKIP_DOTENV: "1" },
    });
    expect(r.ok).toBe(true);
    expect(r.result?.mockAi).toBe(false);
    expect(r.result?.anthropic).toBe("real-anthropic_api_key");
    expect(r.stderr).not.toContain("paid AI is off");
  });

  it("AC4: NODE_ENV=test still drops the keys even with the opt-in", async () => {
    const r = await boot({ dotenv: KEYS_IN_FILE, env: { NODE_ENV: "test", INVAI_PAID_AI: "1" } });
    expect(r.result).toMatchObject({ openai: null, mockAi: true });
  });

  it("AC5: the lock prints one line, without any key text, only when a key exists", async () => {
    const locked = await boot({ dotenv: KEYS_IN_FILE, env: { NODE_ENV: "development" } });
    expect(locked.stderr.split("\n").filter((l) => l.includes("paid AI is off"))).toEqual([NOTICE]);
    expect(locked.stderr + locked.out).not.toContain(FAKE_KEY);
    const noKey = await boot({
      dotenv: "IMAGE_GEN_PROVIDER=openai\n",
      env: { NODE_ENV: "development" },
    });
    expect(noKey.stderr).not.toContain("paid AI is off");
    expect(noKey.result?.describe).toContain("no ANTHROPIC_API_KEY or OPENAI_API_KEY");
  });

  it("A1: the flag is read once, in env.ts, never from a later process.env read", () => {
    const needle = ["process", "env", "INVAI_PAID_AI"].join(".");
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === "dist") continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|mjs|js|sh)$/.test(name) && readFileSync(p, "utf8").includes(needle))
          hits.push(p);
      }
    };
    for (const d of ["src", "evals", "scripts"]) walk(join(ROOT, d));
    expect(hits.map((h) => h.slice(ROOT.length + 1))).toEqual(["src/env.ts"]);
    expect(readFileSync(join(ROOT, "src/env.ts"), "utf8").split(needle).length - 1).toBe(1);
  });
});
