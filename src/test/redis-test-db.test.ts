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

describe("Redis DB policy in test mode (B-205, T-49-3)", () => {
  it("has no fallback: an unpinned REDIS_URL (no path, /0, /0/, /0.5, /0x1) refuses to boot", async () => {
    for (const path of ["", "/0", "/0/", "/0.5", "/0x1"]) {
      const out = await bootRedisUrlExpectError({
        NODE_ENV: "test",
        REDIS_URL: `redis://localhost:6379${path}`,
      });
      expect(out, `path "${path}"`).toMatch(/No test Redis DB/);
    }
  });

  it("keeps a REDIS_URL pinned on 10-14", async () => {
    const url = await bootRedisUrl({ NODE_ENV: "test", REDIS_URL: "redis://localhost:6379/14" });
    expect(url).toBe("redis://localhost:6379/14");
  });

  it("refuses a REDIS_URL pinned on 1-9 or 15 (harness claims, gate, registry)", async () => {
    for (const db of [1, 8, 9, 15]) {
      const out = await bootRedisUrlExpectError({
        NODE_ENV: "test",
        REDIS_URL: `redis://localhost:6379/${db}`,
      });
      expect(out, `DB ${db}`).toMatch(/not allowed/);
    }
  });

  it("TEST_REDIS_URL on 10-14 wins over a plain REDIS_URL", async () => {
    const url = await bootRedisUrl({
      NODE_ENV: "test",
      REDIS_URL: "redis://localhost:6379",
      TEST_REDIS_URL: "redis://localhost:6379/13",
    });
    expect(url).toBe("redis://localhost:6379/13");
  });

  it("refuses TEST_REDIS_URL on DB 0 or a non-canonical DB 0 spelling", async () => {
    for (const path of ["/0", "/0/"]) {
      const out = await bootRedisUrlExpectError({
        NODE_ENV: "test",
        REDIS_URL: "redis://localhost:6379/14",
        TEST_REDIS_URL: `redis://localhost:6379${path}`,
      });
      expect(out).toMatch(/TEST_REDIS_URL must point at a non-zero Redis DB/);
      expect(out).toMatch(/never DB 0/);
    }
  });

  it("refuses TEST_REDIS_URL on 1-9 or 15 unless the harness claimed exactly that DB", async () => {
    for (const db of [1, 8, 9, 15]) {
      const out = await bootRedisUrlExpectError({
        NODE_ENV: "test",
        REDIS_URL: "redis://localhost:6379",
        TEST_REDIS_URL: `redis://localhost:6379/${db}`,
      });
      expect(out, `DB ${db}`).toMatch(/not allowed/);
    }
    // The harness's own claim (global-setup marks the DB it claimed): 1-8 only, and only that one.
    const claimed = await bootRedisUrl({
      NODE_ENV: "test",
      REDIS_URL: "redis://localhost:6379",
      TEST_REDIS_URL: "redis://localhost:6379/3",
      INVAI_TEST_REDIS_CLAIMED: "3",
    });
    expect(claimed).toBe("redis://localhost:6379/3");
    for (const [db, mark] of [
      [4, "3"],
      [9, "9"],
      [15, "15"],
    ] as const) {
      const out = await bootRedisUrlExpectError({
        NODE_ENV: "test",
        REDIS_URL: "redis://localhost:6379",
        TEST_REDIS_URL: `redis://localhost:6379/${db}`,
        INVAI_TEST_REDIS_CLAIMED: mark,
      });
      expect(out, `DB ${db} mark ${mark}`).toMatch(/not allowed/);
    }
  });

  it("this suite's own live env.REDIS_URL (claimed by global-setup, or pinned) is allowed and non-zero", async () => {
    const { env } = await import("../env");
    expect(env.isTest).toBe(true);
    const db = dbIndex(env.REDIS_URL);
    expect(db).toBeGreaterThanOrEqual(1);
    expect(db).not.toBe(9);
    expect(db).not.toBe(15);
  });
});

describe("Redis DB policy outside test (API, worker, scripts) (T-49-3 AC6)", () => {
  it("refuses a REDIS_URL on DB 1-8 or 15, in development and production, non-zero exit", async () => {
    for (const db of [1, 5, 8, 15]) {
      const out = await bootRedisUrlExpectError({
        NODE_ENV: "development",
        REDIS_URL: `redis://localhost:6379/${db}`,
      });
      expect(out, `DB ${db}`).toMatch(/reserved/);
    }
    for (const path of ["/1/", "/01"]) {
      const out = await bootRedisUrlExpectError({
        NODE_ENV: "development",
        REDIS_URL: `redis://localhost:6379${path}`,
      });
      expect(out, path).toMatch(/reserved/);
    }
  });

  it("uses the DB ioredis selects, including the db query parameter, and refuses ambiguity", async () => {
    for (const tail of ["?db=15", "/?db=3", "?db=1", "/?db=8"]) {
      const out = await bootRedisUrlExpectError({
        NODE_ENV: "development",
        REDIS_URL: `redis://localhost:6379${tail}`,
      });
      expect(out, tail).toMatch(/reserved/);
    }
    for (const tail of ["/2?db=15", "/0?db=15", "?db=3&db=12", "?db=abc"]) {
      const out = await bootRedisUrlExpectError({
        NODE_ENV: "development",
        REDIS_URL: `redis://localhost:6379${tail}`,
      });
      expect(out, tail).toMatch(/two different|more than one|not a whole number/);
    }
    const ok = await bootRedisUrl({
      NODE_ENV: "development",
      REDIS_URL: "redis://localhost:6379?db=12",
    });
    expect(ok).toContain("db=12");
  });

  it("in test mode a pinned URL may not carry a db query at all", async () => {
    for (const tail of ["?db=15", "/?db=3", "/12?db=12", "/2?db=15"]) {
      const out = await bootRedisUrlExpectError({
        NODE_ENV: "test",
        REDIS_URL: "redis://localhost:6379/12",
        TEST_REDIS_URL: `redis://localhost:6379${tail}`,
      });
      expect(out, tail).toMatch(/non-zero Redis DB|not allowed/);
    }
  });

  it("the harness claim marker does not unlock a reserved DB outside test mode", async () => {
    for (const db of [3, 15]) {
      const out = await bootRedisUrlExpectError({
        NODE_ENV: "development",
        REDIS_URL: `redis://localhost:6379/${db}`,
        INVAI_TEST_REDIS_CLAIMED: String(db),
      });
      expect(out, `DB ${db}`).toMatch(/reserved/);
    }
  });

  it("allows DB 0 (with or without a path), 9 and the pinned 10-14 stacks", async () => {
    for (const path of ["", "/0", "/9", "/10", "/14"]) {
      const url = await bootRedisUrl({
        NODE_ENV: "development",
        REDIS_URL: `redis://localhost:6379${path}`,
      });
      expect(url).toBe(`redis://localhost:6379${path}`);
    }
  });

  it("leaves a production URL without a path (DB 0) alone", async () => {
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
      REDIS_URL: "rediss://cache.example.test:6380",
      ...prodExtra,
    });
    expect(prod).toBe("rediss://cache.example.test:6380");
  });
});
