import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { env, missingProductionKeys, PRODUCTION_KEYS } from "./env";

const run = promisify(execFile);

// The minimum a process needs to load src/env.ts; no provider keys.
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
  INVAI_SKIP_DOTENV: "1",
};

const ALL_KEYS = Object.fromEntries(PRODUCTION_KEYS.map((k) => [k, `real-${k.toLowerCase()}`]));

/** Loads src/env.ts in a fresh process, as the api and worker do at boot. */
async function boot(extra: Record<string, string>) {
  try {
    const { stdout, stderr } = await run(
      process.execPath,
      [
        "--import",
        "tsx",
        "-e",
        "import('./src/env.ts').then(({ env }) => console.log('BOOTED', JSON.stringify({ smtp: env.SMTP_URL ?? null, from: env.MAIL_FROM ?? null })))",
      ],
      { env: { ...BASE, ...extra }, cwd: process.cwd() },
    );
    return { ok: true, out: stdout + stderr };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

describe("production key guard", () => {
  it("lists every missing provider key", () => {
    expect(missingProductionKeys({})).toEqual([...PRODUCTION_KEYS]);
    expect(missingProductionKeys({ ...ALL_KEYS, STRIPE_WEBHOOK_SECRET: "" })).toEqual([
      "STRIPE_WEBHOOK_SECRET",
    ]);
    expect(missingProductionKeys(ALL_KEYS)).toEqual([]);
  });

  it("refuses to boot in production without keys, naming all of them in one message", async () => {
    const res = await boot({ NODE_ENV: "production" });
    expect(res.ok).toBe(false);
    expect(res.out).not.toContain("BOOTED");
    expect(res.out).toContain(
      `Refusing to start in production: missing ${PRODUCTION_KEYS.join(", ")}.`,
    );
  });

  it("refuses when only one key is missing", async () => {
    const { SMTP_URL: _omit, ...rest } = ALL_KEYS;
    const res = await boot({ NODE_ENV: "production", ...rest });
    expect(res.ok).toBe(false);
    expect(res.out).toContain("missing SMTP_URL.");
  });

  it("boots in production with ALLOW_MOCKS=true and warns loudly", async () => {
    const res = await boot({ NODE_ENV: "production", ALLOW_MOCKS: "true" });
    expect(res.ok).toBe(true);
    expect(res.out).toContain("BOOTED");
    expect(res.out).toContain("running production on MOCK providers");
    // No Mailpit default in production: the mailer logs instead of sending.
    expect(res.out).toContain('{"smtp":null,"from":null}');
  });

  it("boots in production with every key set, and without a warning", async () => {
    const res = await boot({ NODE_ENV: "production", ...ALL_KEYS, SMTP_URL: "smtp://mail:25" });
    expect(res.ok).toBe(true);
    expect(res.out).not.toContain("MOCK providers");
  });

  it("development needs no provider keys and defaults mail to Mailpit", async () => {
    const res = await boot({ NODE_ENV: "development" });
    expect(res.ok).toBe(true);
    expect(res.out).toContain('"smtp":"smtp://localhost:1025"');
    expect(res.out).not.toContain("MOCK providers");
  });

  it("tests run without provider keys, with the Mailpit default", () => {
    expect(env.isTest).toBe(true);
    expect(env.SMTP_URL).toBeTruthy();
    expect(env.MAIL_FROM).toBeTruthy();
  });
});
