import { existsSync } from "node:fs";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

// Local development reads .env (Node 24 built-in). Production injects real env vars.
if (process.env.NODE_ENV !== "production" && !process.env.INVAI_SKIP_DOTENV) {
  for (const file of [".env", ".env.local"]) {
    if (existsSync(file)) process.loadEnvFile(file);
  }
}

const raw = createEnv({
  server: {
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().default(3000),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

    /** App role (invai_app): RLS enforced. Used by the API and workers. */
    DATABASE_URL: z.url(),
    /** Owner role (invai): migrations, seed, outbox relay and cross-tenant jobs. */
    MIGRATION_DATABASE_URL: z.url(),
    /** Test database (owner + app URLs derived from the two above when unset). */
    TEST_DATABASE_URL: z.url().optional(),
    TEST_MIGRATION_DATABASE_URL: z.url().optional(),

    REDIS_URL: z.url(),

    S3_BUCKET: z.string(),
    S3_REGION: z.string().default("us-east-1"),
    S3_ENDPOINT: z.url().optional(),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    S3_FORCE_PATH_STYLE: z
      .enum(["true", "false"])
      .default("true")
      .transform((v) => v === "true"),
    /** Public base for presigned URLs when the browser cannot reach S3_ENDPOINT (optional). */
    S3_PUBLIC_ENDPOINT: z.url().optional(),

    IMAGING_URL: z.url(),

    BETTER_AUTH_SECRET: z.string().min(32),
    BETTER_AUTH_URL: z.url(),
    WEB_ORIGIN: z.url(),
    FLOOR_ORIGIN: z.url().default("http://localhost:5174"),
    /** Signs floor session tokens and station/PIN hashes. Falls back to BETTER_AUTH_SECRET. */
    FLOOR_TOKEN_SECRET: z.string().min(32).optional(),
    FLOOR_SESSION_TTL_HOURS: z.coerce.number().default(12),

    /** `<keyId>:<base64 32 bytes>[,<keyId>:<base64>]`; the first key encrypts, all keys decrypt. */
    FIELD_ENCRYPTION_KEY: z.string().min(40),

    ANTHROPIC_API_KEY: z.string().optional(),
    EASYPOST_API_KEY: z.string().optional(),
    SHOPIFY_API_KEY: z.string().optional(),
    SHOPIFY_API_SECRET: z.string().optional(),
    SS_ACTIVEWEAR_ACCOUNT: z.string().optional(),
    SS_ACTIVEWEAR_API_KEY: z.string().optional(),
    STRIPE_SECRET_KEY: z.string().optional(),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

const isTest = raw.NODE_ENV === "test";

/**
 * Resolved config. Under NODE_ENV=test the database URLs point at the test database so a
 * test run can never touch development data. `mocks.*` is true when the real key is missing;
 * integrations pick their mock provider from these flags.
 */
export const env = {
  ...raw,
  DATABASE_URL: isTest
    ? (raw.TEST_DATABASE_URL ?? withDatabase(raw.DATABASE_URL, "invai_test"))
    : raw.DATABASE_URL,
  MIGRATION_DATABASE_URL: isTest
    ? (raw.TEST_MIGRATION_DATABASE_URL ?? withDatabase(raw.MIGRATION_DATABASE_URL, "invai_test"))
    : raw.MIGRATION_DATABASE_URL,
  FLOOR_TOKEN_SECRET: raw.FLOOR_TOKEN_SECRET ?? raw.BETTER_AUTH_SECRET,
  isDev: raw.NODE_ENV === "development",
  isTest,
  isProd: raw.NODE_ENV === "production",
  mocks: {
    ai: !raw.ANTHROPIC_API_KEY,
    carrier: !raw.EASYPOST_API_KEY,
    shopify: !raw.SHOPIFY_API_KEY || !raw.SHOPIFY_API_SECRET,
    supplier: !raw.SS_ACTIVEWEAR_ACCOUNT || !raw.SS_ACTIVEWEAR_API_KEY,
    billing: !raw.STRIPE_SECRET_KEY,
  },
} as const;

export type Env = typeof env;
