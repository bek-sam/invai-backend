import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);

// The minimum a process needs to load src/env.ts; no provider keys.
const BASE = {
  PATH: process.env.PATH ?? "",
  DATABASE_URL: "postgres://invai_app:invai@localhost:5432/invai",
  MIGRATION_DATABASE_URL: "postgres://invai:invai@localhost:5432/invai",
  S3_BUCKET: "invai-local",
  IMAGING_URL: "http://localhost:8000",
  BETTER_AUTH_SECRET: "x".repeat(32),
  BETTER_AUTH_URL: "http://localhost:3000",
  WEB_ORIGIN: "http://localhost:5173",
  FIELD_ENCRYPTION_KEY: "k1:KzQaGJQ4pwuYge713w7utD2NrzYH21qNtk//UkCed+E=",
  INVAI_SKIP_DOTENV: "1",
};

/** Boots src/env.ts in a fresh process (as the api and worker do) and prints the resolved REDIS_URL. */
async function bootRedisUrl(extra: Record<string, string>) {
  const { stdout, stderr } = await run(
    process.execPath,
    [
      "--import",
      "tsx",
      "-e",
      "import('./src/env.ts').then(({ env }) => console.log('REDIS_URL=' + env.REDIS_URL))",
    ],
    { env: { ...BASE, ...extra }, cwd: process.cwd() },
  );
  const out = stdout + stderr;
  const match = out.match(/REDIS_URL=(\S+)/);
  const url = match?.[1];
  if (!url) throw new Error(`no REDIS_URL printed: ${out}`);
  return url;
}

function dbIndex(url: string): number {
  const path = new URL(url).pathname.replace(/^\//, "");
  return path === "" ? 0 : Number(path);
}

/** Boots src/env.ts expecting the module load itself to throw (an unhandled rejection exits
 *  the process non-zero); returns the combined stdout+stderr for a message assertion, or fails
 *  the test if the process exited 0 (env.ts did not throw as expected). */
async function bootRedisUrlExpectError(extra: Record<string, string>): Promise<string> {
  let succeeded: { stdout: string; stderr: string } | undefined;
  let failure: { stdout?: string; stderr?: string; message?: string } | undefined;
  try {
    succeeded = await run(
      process.execPath,
      [
        "--import",
        "tsx",
        "-e",
        "import('./src/env.ts').then(({ env }) => console.log('REDIS_URL=' + env.REDIS_URL))",
      ],
      { env: { ...BASE, ...extra }, cwd: process.cwd() },
    );
  } catch (err) {
    failure = err as { stdout?: string; stderr?: string; message?: string };
  }
  if (succeeded) {
    throw new Error(
      `expected boot to fail, but it printed: ${succeeded.stdout}${succeeded.stderr}`,
    );
  }
  return `${failure?.stdout ?? ""}${failure?.stderr ?? ""}${failure?.message ?? ""}`;
}

describe("REDIS_URL test redirect (B-205)", () => {
  it("redirects DB 0 to a non-zero test DB under NODE_ENV=test", async () => {
    const url = await bootRedisUrl({ NODE_ENV: "test", REDIS_URL: "redis://localhost:6379" });
    expect(dbIndex(url)).not.toBe(0);
    expect(dbIndex("redis://localhost:6379")).toBe(0);
  });

  it("also redirects an explicit /0", async () => {
    const url = await bootRedisUrl({ NODE_ENV: "test", REDIS_URL: "redis://localhost:6379/0" });
    expect(dbIndex(url)).not.toBe(0);
  });

  // These three paths all parse to `Number(...) !== 0` (NaN, 0.5, or a hex-parsed 1), so a naive
  // "already non-zero" check (this file's own `dbIndex`, and round 1's `redisDbIndex`) reads them
  // as "caller pinned a DB" and leaves them untouched — but ioredis's own `parseInt(path, 10)`
  // resolves every one of them to live DB 0. Assert the literal redirected path (not just
  // `dbIndex(url) !== 0`, which round 1's bug would also satisfy for `/0x1`) to actually catch it.
  it("redirects a trailing-slash DB 0 (/0/), never keeps it as pinned", async () => {
    const url = await bootRedisUrl({ NODE_ENV: "test", REDIS_URL: "redis://localhost:6379/0/" });
    expect(new URL(url).pathname).toBe("/15");
  });

  it("redirects a decimal DB path (/0.5), never keeps it as pinned", async () => {
    const url = await bootRedisUrl({ NODE_ENV: "test", REDIS_URL: "redis://localhost:6379/0.5" });
    expect(new URL(url).pathname).toBe("/15");
  });

  it("redirects a hex-looking DB path (/0x1), never keeps it as pinned", async () => {
    const url = await bootRedisUrl({ NODE_ENV: "test", REDIS_URL: "redis://localhost:6379/0x1" });
    expect(new URL(url).pathname).toBe("/15");
  });

  it("keeps an explicit non-zero DB the caller already pinned (agent-brief pattern)", async () => {
    const url = await bootRedisUrl({ NODE_ENV: "test", REDIS_URL: "redis://localhost:6379/14" });
    expect(url).toBe("redis://localhost:6379/14");
  });

  it("TEST_REDIS_URL wins over a plain REDIS_URL redirect when both are set", async () => {
    const url = await bootRedisUrl({
      NODE_ENV: "test",
      REDIS_URL: "redis://localhost:6379",
      TEST_REDIS_URL: "redis://localhost:6379/13",
    });
    expect(url).toBe("redis://localhost:6379/13");
  });

  it("refuses to boot when TEST_REDIS_URL itself points at DB 0", async () => {
    const out = await bootRedisUrlExpectError({
      NODE_ENV: "test",
      REDIS_URL: "redis://localhost:6379/14",
      TEST_REDIS_URL: "redis://localhost:6379/0",
    });
    expect(out).toMatch(/TEST_REDIS_URL must point at a non-zero Redis DB/);
    expect(out).toMatch(/never DB 0/);
  });

  it("refuses to boot when TEST_REDIS_URL is a non-canonical DB 0 spelling (/0/)", async () => {
    const out = await bootRedisUrlExpectError({
      NODE_ENV: "test",
      REDIS_URL: "redis://localhost:6379/14",
      TEST_REDIS_URL: "redis://localhost:6379/0/",
    });
    expect(out).toMatch(/TEST_REDIS_URL must point at a non-zero Redis DB/);
  });

  it("leaves REDIS_URL unchanged outside test (development, production)", async () => {
    const dev = await bootRedisUrl({
      NODE_ENV: "development",
      REDIS_URL: "redis://localhost:6379",
    });
    expect(dev).toBe("redis://localhost:6379");

    const prodExtra = {
      EASYPOST_API_KEY: "k",
      STRIPE_SECRET_KEY: "k",
      STRIPE_WEBHOOK_SECRET: "k",
      ANTHROPIC_API_KEY: "k",
      SHOPIFY_API_KEY: "k",
      SHOPIFY_API_SECRET: "k",
      SMTP_URL: "smtp://mail:25",
      MAIL_FROM: "a@b.test",
      IMAGING_SHARED_SECRET: "s".repeat(32),
    };
    const prod = await bootRedisUrl({
      NODE_ENV: "production",
      REDIS_URL: "redis://localhost:6379",
      ...prodExtra,
    });
    expect(prod).toBe("redis://localhost:6379");
  });

  it("this suite's own live env.REDIS_URL (as vitest.config.ts / global-setup.ts set it) is a non-zero test DB", async () => {
    const { env } = await import("../env");
    expect(env.isTest).toBe(true);
    expect(dbIndex(env.REDIS_URL)).not.toBe(0);
  });
});
