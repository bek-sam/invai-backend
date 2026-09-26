import { existsSync } from "node:fs";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

// Local development reads .env (Node 24 built-in). Production injects real env vars.
if (process.env.NODE_ENV !== "production" && !process.env.INVAI_SKIP_DOTENV) {
  for (const file of [".env", ".env.local"]) {
    if (existsSync(file)) process.loadEnvFile(file);
  }
}

/**
 * Provider keys and mail config: trimmed, and blank or whitespace-only counts as unset, so a
 * secret rendered as " " can't pass the production guard or turn a mock flag off.
 */
function secret<T extends z.ZodType<string>>(schema: T) {
  return z.preprocess(
    (v) => (typeof v === "string" ? v.trim() || undefined : v),
    schema.optional(),
  );
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

    ANTHROPIC_API_KEY: secret(z.string()),
    /** Daily (UTC) real-model AI spend caps in cents (src/ai/breaker.ts); 0 turns a scope off. */
    AI_DAILY_PLATFORM_CAP_CENTS: z.coerce.number().int().min(0).default(50_000),
    AI_DAILY_TENANT_CAP_CENTS: z.coerce.number().int().min(0).default(5_000),
    EASYPOST_API_KEY: secret(z.string()),
    /** EasyPost webhook HMAC secret (`X-Hmac-Signature`); unset uses the mock dev secret. */
    EASYPOST_WEBHOOK_SECRET: secret(z.string()),
    SHOPIFY_API_KEY: secret(z.string()),
    SHOPIFY_API_SECRET: secret(z.string()),
    SS_ACTIVEWEAR_ACCOUNT: secret(z.string()),
    SS_ACTIVEWEAR_API_KEY: secret(z.string()),
    STRIPE_SECRET_KEY: secret(z.string()),
    STRIPE_WEBHOOK_SECRET: secret(z.string()),

    /** Outgoing mail. Outside production both default to Mailpit (docker compose, UI on :8025). */
    SMTP_URL: secret(z.url()),
    MAIL_FROM: secret(z.string()),

    /**
     * Production refuses to boot while any provider key is missing (it would run on a mock).
     * `ALLOW_MOCKS=true` lets a demo or staging stage boot anyway, with a warning on every start.
     */
    ALLOW_MOCKS: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
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
const isProd = raw.NODE_ENV === "production";

/**
 * Keys production needs so no provider silently runs on its mock. Supplier (S&S) keys are not
 * here: supplier credentials are tenant-owned (T-1-3), so there is no platform-wide supplier mock.
 */
export const PRODUCTION_KEYS = [
  "EASYPOST_API_KEY",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "ANTHROPIC_API_KEY",
  "SHOPIFY_API_KEY",
  "SHOPIFY_API_SECRET",
  "SMTP_URL",
  "MAIL_FROM",
] as const;

export function missingProductionKeys(
  values: Partial<Record<(typeof PRODUCTION_KEYS)[number], string | undefined>>,
): string[] {
  return PRODUCTION_KEYS.filter((key) => !values[key]?.trim());
}

const missingInProd = isProd ? missingProductionKeys(raw) : [];
if (missingInProd.length && !raw.ALLOW_MOCKS) {
  throw new Error(
    `Refusing to start in production: missing ${missingInProd.join(", ")}. ` +
      "Without them InvAI would use mock providers and fake success. Set the keys, or set " +
      "ALLOW_MOCKS=true for a demo or staging stage only.",
  );
}
if (missingInProd.length) {
  // lib/log imports env, so log directly (same JSON shape as the production logger).
  console.error(
    JSON.stringify({
      t: new Date().toISOString(),
      level: "warn",
      scope: "env",
      msg: "ALLOW_MOCKS=true: running production on MOCK providers. Not for real shops.",
      missing: missingInProd,
    }),
  );
}

/**
 * Resolved config. Under NODE_ENV=test the database URLs point at the test database so a
 * test run can never touch development data. `mocks.*` is true when the real key is missing;
 * integrations pick their mock provider from these flags. Production refuses to boot with any
 * of PRODUCTION_KEYS missing unless ALLOW_MOCKS=true.
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
  /** Undefined only in production with ALLOW_MOCKS=true; the mailer then logs instead of sending. */
  SMTP_URL: raw.SMTP_URL ?? (isProd ? undefined : "smtp://localhost:1025"),
  MAIL_FROM: raw.MAIL_FROM ?? (isProd ? undefined : "InvAI <sheets@invai.local>"),
  isDev: raw.NODE_ENV === "development",
  isTest,
  isProd,
  /** ALLOW_MOCKS=true: production may boot on mock providers (demo or staging stages only). */
  allowMocks: raw.ALLOW_MOCKS,
  mocks: {
    ai: !raw.ANTHROPIC_API_KEY,
    carrier: !raw.EASYPOST_API_KEY,
    shopify: !raw.SHOPIFY_API_KEY || !raw.SHOPIFY_API_SECRET,
    supplier: !raw.SS_ACTIVEWEAR_ACCOUNT || !raw.SS_ACTIVEWEAR_API_KEY,
    billing: !raw.STRIPE_SECRET_KEY,
    /** Outside production a missing SMTP_URL means the local Mailpit sink. */
    mail: !raw.SMTP_URL,
  },
} as const;

export type Env = typeof env;
