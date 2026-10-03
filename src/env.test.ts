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
        "import('./src/env.ts').then(({ env }) => console.log('BOOTED', JSON.stringify({ smtp: env.SMTP_URL ?? null, from: env.MAIL_FROM ?? null, mocks: env.mocks, digestEmailEnabled: env.DIGEST_EMAIL_ENABLED })))",
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

  it("counts blank or whitespace-only values as missing", () => {
    expect(
      missingProductionKeys({ ...ALL_KEYS, STRIPE_SECRET_KEY: "  ", MAIL_FROM: "\t\n " }),
    ).toEqual(["STRIPE_SECRET_KEY", "MAIL_FROM"]);
  });

  it("refuses to boot when keys are whitespace-only, and ALLOW_MOCKS then runs them as mocks", async () => {
    const blank = Object.fromEntries(PRODUCTION_KEYS.map((k) => [k, "  "]));
    const refused = await boot({ NODE_ENV: "production", ...blank });
    expect(refused.ok).toBe(false);
    expect(refused.out).toContain(
      `Refusing to start in production: missing ${PRODUCTION_KEYS.join(", ")}.`,
    );

    const allowed = await boot({ NODE_ENV: "production", ALLOW_MOCKS: "true", ...blank });
    expect(allowed.ok).toBe(true);
    expect(allowed.out).toContain("running production on MOCK providers");
    expect(allowed.out).toContain(
      '"mocks":{"ai":true,"carrier":true,"shopify":true,"supplier":true,"billing":true,"mail":true,' +
        '"census":true,"googleTrends":true,"pinterest":true,"jungleScout":true}',
    );
  });

  it("trims real values instead of treating padding as part of the key", async () => {
    const padded = Object.fromEntries(Object.entries(ALL_KEYS).map(([k, v]) => [k, ` ${v} `]));
    const res = await boot({ NODE_ENV: "production", ...padded, SMTP_URL: " smtp://mail:25 " });
    expect(res.ok).toBe(true);
    expect(res.out).toContain('"smtp":"smtp://mail:25"');
    expect(res.out).toContain('"from":"real-mail_from"');
    expect(res.out).toContain('"ai":false');
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
    expect(res.out).toContain('{"smtp":null,"from":null,');
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

describe("DIGEST_EMAIL_ENABLED default (T-19-4 round 2)", () => {
  it("defaults to false in production so no real digest email can go out before OI-12/13/14", async () => {
    const res = await boot({ NODE_ENV: "production", ...ALL_KEYS, SMTP_URL: "smtp://mail:25" });
    expect(res.ok).toBe(true);
    expect(res.out).toContain('"digestEmailEnabled":false');
  });

  it("an explicit true in production still wins (a deliberate pilot switch-on)", async () => {
    const res = await boot({
      NODE_ENV: "production",
      ...ALL_KEYS,
      SMTP_URL: "smtp://mail:25",
      DIGEST_EMAIL_ENABLED: "true",
    });
    expect(res.ok).toBe(true);
    expect(res.out).toContain('"digestEmailEnabled":true');
  });

  it("defaults to true outside production (dev and test)", async () => {
    const dev = await boot({ NODE_ENV: "development" });
    expect(dev.ok).toBe(true);
    expect(dev.out).toContain('"digestEmailEnabled":true');
    expect(env.isProd).toBe(false);
    expect(env.DIGEST_EMAIL_ENABLED).toBe(true);
  });

  it("an explicit false outside production is still honored", async () => {
    const res = await boot({ NODE_ENV: "development", DIGEST_EMAIL_ENABLED: "false" });
    expect(res.ok).toBe(true);
    expect(res.out).toContain('"digestEmailEnabled":false');
  });
});

describe("AI provider keys (decision 0021)", () => {
  const { ANTHROPIC_API_KEY: _a, ...noAnthropic } = ALL_KEYS;

  it("OPENAI_API_KEY satisfies the production AI key; with neither key the AI key is missing", () => {
    expect(missingProductionKeys({ ...noAnthropic, OPENAI_API_KEY: "sk-real" })).toEqual([]);
    expect(missingProductionKeys(noAnthropic)).toEqual(["ANTHROPIC_API_KEY"]);
    expect(missingProductionKeys({ ...noAnthropic, OPENAI_API_KEY: "  " })).toEqual([
      "ANTHROPIC_API_KEY",
    ]);
  });

  it("production boots on an OpenAI key alone, with the AI mock off", async () => {
    const res = await boot({
      NODE_ENV: "production",
      ...noAnthropic,
      SMTP_URL: "smtp://mail:25",
      OPENAI_API_KEY: "sk-real",
    });
    expect(res.ok).toBe(true);
    expect(res.out).toContain('"ai":false');
  });

  it("the AI mock is on only when neither key is set (development)", async () => {
    expect((await boot({ NODE_ENV: "development" })).out).toContain('"ai":true');
    expect((await boot({ NODE_ENV: "development", OPENAI_API_KEY: "sk-real" })).out).toContain(
      '"ai":false',
    );
  });

  it("a test run ignores AI keys, so no test can reach a paid model", async () => {
    const res = await boot({
      NODE_ENV: "test",
      OPENAI_API_KEY: "sk-real",
      ANTHROPIC_API_KEY: "sk-ant-real",
    });
    expect(res.out).toContain('"ai":true');
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });
});

describe("image generation switches (T-27-1)", () => {
  const prod = { NODE_ENV: "production", ...ALL_KEYS, SMTP_URL: "smtp://mail:25" };

  it("defaults to the mock provider with a cap of 30 scenes per shop per day", () => {
    expect(env.IMAGE_GEN_PROVIDER).toBe("mock");
    expect(env.IMAGE_GEN_DAILY_CAP_PER_SHOP).toBe(30);
    expect(env.imageGenMockDrift).toBe(false);
  });

  it("production with IMAGE_GEN_PROVIDER=openai and no OpenAI key refuses to boot; a blank key counts as unset", async () => {
    const missing = await boot({ ...prod, IMAGE_GEN_PROVIDER: "openai" });
    expect(missing.ok).toBe(false);
    expect(missing.out).toContain("IMAGE_GEN_PROVIDER=openai needs OPENAI_API_KEY");
    const blank = await boot({ ...prod, IMAGE_GEN_PROVIDER: "openai", OPENAI_API_KEY: "   " });
    expect(blank.ok).toBe(false);
    expect(
      (await boot({ ...prod, IMAGE_GEN_PROVIDER: "openai", OPENAI_API_KEY: "sk-real" })).ok,
    ).toBe(true);
    expect((await boot(prod)).ok).toBe(true);
  });

  it("IMAGE_GEN_MOCK_DRIFT is refused outside NODE_ENV=test", async () => {
    const dev = await boot({ NODE_ENV: "development", IMAGE_GEN_MOCK_DRIFT: "1" });
    expect(dev.ok).toBe(false);
    expect(dev.out).toContain("IMAGE_GEN_MOCK_DRIFT is a test-only switch");
    expect((await boot({ ...prod, IMAGE_GEN_MOCK_DRIFT: "1" })).ok).toBe(false);
    expect((await boot({ NODE_ENV: "test", IMAGE_GEN_MOCK_DRIFT: "1" })).ok).toBe(true);
  });
});
