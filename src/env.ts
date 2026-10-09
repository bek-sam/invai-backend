import { existsSync } from "node:fs";
import { FLOOR_COMPAT_BASELINE } from "@invai/contracts";
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
    /** Test Redis DB (`REDIS_URL`'s DB index is redirected to a non-zero one when unset). */
    TEST_REDIS_URL: z.url().optional(),

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
    /** Sent to imaging as `X-Imaging-Secret` (T-9-5); imaging requires 32+ chars in production. */
    IMAGING_SHARED_SECRET: secret(z.string()),

    BETTER_AUTH_SECRET: z.string().min(32),
    BETTER_AUTH_URL: z.url(),
    WEB_ORIGIN: z.url(),
    FLOOR_ORIGIN: z.url().default("http://localhost:5174"),
    /** Signs floor session tokens and station/PIN hashes. Falls back to BETTER_AUTH_SECRET. */
    FLOOR_TOKEN_SECRET: z.string().min(32).optional(),
    FLOOR_SESSION_TTL_HOURS: z.coerce.number().default(12),
    /**
     * Account security (T-28-2, ADR 0025, Amazon DPP): this many wrong passwords in a row for one
     * email lock its sign-in for ACCOUNT_LOCK_MINUTES (at most 10: the DPP's ceiling). Owners and
     * admins must turn on two-step sign-in within MFA_GRACE_DAYS (0–14).
     */
    ACCOUNT_LOCK_THRESHOLD: z.coerce.number().int().min(1).max(10).default(10),
    ACCOUNT_LOCK_MINUTES: z.coerce
      .number()
      .int()
      .min(1)
      .max(24 * 60)
      .default(30),
    MFA_GRACE_DAYS: z.coerce.number().int().min(0).max(14).default(7),
    /**
     * Oldest `X-Contract-Version` a floor tablet may call with (T-13-1, ADR 0012). Defaults to
     * contracts' hand-maintained `FLOOR_COMPAT_BASELINE`, not `CONTRACT_VERSION`, so a version bump
     * alone never refuses current tablets. The env var is the emergency/rollback override.
     */
    MIN_FLOOR_CONTRACT_VERSION: z
      .string()
      .regex(/^\d+\.\d+\.\d+$/, "expected x.y.z")
      .default(FLOOR_COMPAT_BASELINE),

    /** `<keyId>:<base64 32 bytes>[,<keyId>:<base64>]`; the first key encrypts, all keys decrypt. */
    FIELD_ENCRYPTION_KEY: z.string().min(40),

    ANTHROPIC_API_KEY: secret(z.string()),
    /** Second AI provider (decision 0021): used only when ANTHROPIC_API_KEY is unset. */
    OPENAI_API_KEY: secret(z.string()),
    /**
     * Operator token for the internal DLQ/redrive routes (`X-Internal-Token`, api/internal.ts).
     * Never shipped to a browser. Unset turns the routes off (every call 404s); set it wherever an
     * operator needs to list or redrive failed jobs.
     */
    INTERNAL_ADMIN_TOKEN: secret(z.string().min(32)),
    /** Daily (UTC) real-model AI spend caps in cents (src/ai/breaker.ts); 0 turns a scope off. */
    AI_DAILY_PLATFORM_CAP_CENTS: z.coerce.number().int().min(0).default(50_000),
    AI_DAILY_TENANT_CAP_CENTS: z.coerce.number().int().min(0).default(5_000),
    /**
     * Listing photos phase B (T-27-1, ADR 0023): which image model draws AI scenes. `openai` is used
     * only with OPENAI_API_KEY set and never for a sample workspace (src/ai/images); the owner
     * turns it on (OI-25). Per-shop daily cap on AI scene images (UTC day, mock calls count too).
     * IMAGE_GEN_MOCK_DRIFT=1 makes the mock alter the protected print region (tests only).
     */
    IMAGE_GEN_PROVIDER: z.enum(["mock", "openai"]).default("mock"),
    IMAGE_GEN_DAILY_CAP_PER_SHOP: z.coerce.number().int().min(0).default(30),
    IMAGE_GEN_MOCK_DRIFT: z.enum(["0", "1"]).optional(),
    EASYPOST_API_KEY: secret(z.string()),
    /** EasyPost webhook HMAC secret (`X-Hmac-Signature`); unset uses the mock dev secret. */
    EASYPOST_WEBHOOK_SECRET: secret(z.string()),
    SHOPIFY_API_KEY: secret(z.string()),
    SHOPIFY_API_SECRET: secret(z.string()),
    SS_ACTIVEWEAR_ACCOUNT: secret(z.string()),
    SS_ACTIVEWEAR_API_KEY: secret(z.string()),
    STRIPE_SECRET_KEY: secret(z.string()),
    STRIPE_WEBHOOK_SECRET: secret(z.string()),
    /**
     * Market-signal demand providers (T-18-2, wave 18). All optional and free/unpriced today
     * (research 14 §1.2-1.3); none is in PRODUCTION_KEYS, so InvAI runs the mock market providers
     * in production until a key is added, exactly like every other InvAI integration.
     */
    CENSUS_API_KEY: secret(z.string()),
    GOOGLE_TRENDS_API_KEY: secret(z.string()),
    PINTEREST_API_KEY: secret(z.string()),
    JUNGLE_SCOUT_API_KEY: secret(z.string()),
    /**
     * Test-only outage switch (comma list of `SignalSource`s, e.g. "google_trends,pinterest_trends")
     * that makes that mock market provider throw instead of returning data, so T-18-3 can test its
     * "stale/no source" fallback. Ignored in production (`env.marketMockFail` is always empty there).
     */
    MARKET_MOCK_FAIL: secret(z.string()),

    /** Outgoing mail. Outside production both default to Mailpit (docker compose, UI on :8025). */
    SMTP_URL: secret(z.url()),
    MAIL_FROM: secret(z.string()),
    /**
     * Postal address printed in the footer of every person-facing email (CAN-SPAM). The default
     * is an obvious placeholder until the owner answers OI-12; nothing real is sent before that.
     */
    MAIL_POSTAL_ADDRESS: z
      .string()
      .trim()
      .min(1)
      .default("InvAI, postal address pending (OI-12), USA"),

    /**
     * Weekly digest switches (wave 19, `specs/weekly-digest.md` pipeline 9-10; T-19-4 owns the
     * names, T-19-2 and T-19-3 read them). None is a provider key, so none is in PRODUCTION_KEYS.
     * `DIGEST_ENABLED=false` stops every digest build; `DIGEST_EMAIL_ENABLED=false` keeps digests
     * in-app only (`sendUserEmail` answers `skipped: disabled`). Its default is `false` in
     * production and `true` everywhere else (tech lead decision, T-19-4 round 2), so a real digest
     * email can't go out before OI-12/13/14 are answered even if `SMTP_URL` is later set for a
     * pilot; setting it explicitly always wins. `DIGEST_SUMMARY_MODE` is the AI summary's global
     * mode: it stays `shadow` (built, stored, never shown or sent) until OI-8.
     */
    DIGEST_ENABLED: z
      .enum(["true", "false"])
      .default("true")
      .transform((v) => v === "true"),
    // No static default: production must default to *off* even if the schema alone can't see
    // NODE_ENV yet, so this stays `undefined` when unset and is resolved below (`env.DIGEST_EMAIL_ENABLED`).
    DIGEST_EMAIL_ENABLED: z
      .enum(["true", "false"])
      .transform((v) => v === "true")
      .optional(),
    DIGEST_SUMMARY_MODE: z.enum(["off", "shadow", "on"]).default("shadow"),
    /** Per-shop cap for the AI summary's model spend, in cents per week (estimate before the call). */
    DIGEST_MAX_CENTS_PER_WEEK: z.coerce.number().int().min(0).default(10),

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
  // One line naming each bad variable and why, never its value (a URL holds a password). The
  // default handler prints a multi-line object; release CLIs and the API log one line (T-30-2).
  onValidationError: (issues) => {
    const list = issues
      .map(
        (i) =>
          `${(i.path ?? []).map((p) => String(typeof p === "object" ? p.key : p)).join(".") || "?"} (${i.message})`,
      )
      .join(", ");
    throw new Error(`Invalid environment variables: ${list}`);
  },
});

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

/** Default Redis DB for tests (B-205): never 0, the dev/CI worker's DB. */
const TEST_REDIS_DB = 15;

/**
 * True only when the URL's path is written exactly as a positive integer with no leading zero
 * (`/1`, `/14`, ...) — the one shape treated as "the caller explicitly pinned a non-zero DB".
 * Everything else — no path, a bare `/0`, a trailing slash (`/0/`), a decimal (`/0.5`), hex
 * (`/0x1`), blank or non-numeric text — is treated as DB 0 (unset) and redirected.
 *
 * This is deliberately *stricter* than ioredis's own parsing. ioredis picks the DB with
 * `parseInt(options.db, 10)` (`node_modules/ioredis/built/Redis.js:725-726`), so `/0/` and
 * `/0x1` both resolve to live DB 0 there too — but a naive `Number(path) !== 0` check (this
 * function's round-1 shape) reads `/0/` and `/0x1` as *non-zero* (`Number` returns `NaN`, and
 * `NaN !== 0` is true) and wrongly keeps them as "pinned", so the suite ends up on DB 0 anyway
 * (round-1 review finding). Matching ioredis's `parseInt` instead of anchoring on a canonical
 * literal would have the same hole for any other `Number`/`parseInt` divergence, so this checks
 * the literal text.
 */
function isPinnedNonZeroDb(url: string): boolean {
  const path = new URL(url).pathname.replace(/^\//, "");
  return /^[1-9]\d*$/.test(path);
}

/**
 * Redirects a Redis URL to `TEST_REDIS_DB` (B-205), unless the caller already picked a non-zero
 * DB (`REDIS_URL=redis://localhost:6379/14`, the pattern `team/agent-brief.md` tells agents to
 * use): that explicit choice always wins, so two agents pinning different DBs never collide.
 */
function withTestRedisDb(url: string): string {
  if (isPinnedNonZeroDb(url)) return url;
  const u = new URL(url);
  u.pathname = `/${TEST_REDIS_DB}`;
  return u.toString();
}

/**
 * `TEST_REDIS_URL` is an explicit, higher-trust opt-in (a second agent pinning its own DB per
 * `team/agent-brief.md`) — but "explicit" must not mean "even DB 0 is honored verbatim". Round 1
 * used `raw.TEST_REDIS_URL` as-is with no check at all. A `TEST_REDIS_URL` that isn't a pinned
 * non-zero DB fails the boot with a clear message instead of silently sharing the dev/CI worker's
 * DB 0 (chosen over a silent redirect so a mistyped `TEST_REDIS_URL` can't go unnoticed).
 */
function assertTestRedisDbPinned(url: string): string {
  if (!isPinnedNonZeroDb(url)) {
    throw new Error(
      `TEST_REDIS_URL must point at a non-zero Redis DB (got "${url}"), never DB 0 — the ` +
        "dev/CI worker's DB (B-205). Use e.g. redis://localhost:6379/14.",
    );
  }
  return url;
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
  "IMAGING_SHARED_SECRET",
] as const;

/**
 * Either AI key satisfies the AI requirement (decision 0021); with neither set, the missing key is
 * reported as ANTHROPIC_API_KEY, the preferred provider.
 */
export function missingProductionKeys(
  values: Partial<Record<(typeof PRODUCTION_KEYS)[number] | "OPENAI_API_KEY", string | undefined>>,
): string[] {
  const hasOpenAi = !!values.OPENAI_API_KEY?.trim();
  return PRODUCTION_KEYS.filter(
    (key) => !values[key]?.trim() && !(key === "ANTHROPIC_API_KEY" && hasOpenAi),
  );
}

if (isProd && raw.IMAGE_GEN_PROVIDER === "openai" && !raw.OPENAI_API_KEY) {
  throw new Error(
    "Refusing to start in production: IMAGE_GEN_PROVIDER=openai needs OPENAI_API_KEY. Set the " +
      "key, or set IMAGE_GEN_PROVIDER=mock to keep sample scenes.",
  );
}
if (raw.IMAGE_GEN_MOCK_DRIFT !== undefined && !isTest) {
  throw new Error("IMAGE_GEN_MOCK_DRIFT is a test-only switch; unset it outside NODE_ENV=test.");
}

const missingInProd = isProd ? missingProductionKeys(raw) : [];
if (missingInProd.length && !raw.ALLOW_MOCKS) {
  throw new Error(
    `Refusing to start in production: missing ${missingInProd.join(", ")}. ` +
      "Without them InvAI would use mock providers and fake success. Set the keys, or set " +
      "ALLOW_MOCKS=true for a demo or staging stage only. OPENAI_API_KEY can stand in for " +
      "ANTHROPIC_API_KEY.",
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
  /**
   * Under test, redirected to a non-zero DB so the suite never shares BullMQ queues or realtime
   * streams with a dev worker on DB 0 (B-205), mirroring how DATABASE_URL redirects to invai_test.
   * `TEST_REDIS_URL` wins when set, but it must itself be a pinned non-zero DB (throws otherwise,
   * `assertTestRedisDbPinned`); otherwise an already non-zero `REDIS_URL` DB is kept as-is;
   * otherwise it redirects to `TEST_REDIS_DB` (15).
   */
  REDIS_URL: isTest
    ? raw.TEST_REDIS_URL
      ? assertTestRedisDbPinned(raw.TEST_REDIS_URL)
      : withTestRedisDb(raw.REDIS_URL)
    : raw.REDIS_URL,
  /**
   * Under test the AI keys from .env are dropped (decision 0021): a test run must never reach a
   * paid model or send test data out. Tests that exercise a real provider stub its HTTP layer.
   */
  ANTHROPIC_API_KEY: isTest ? undefined : raw.ANTHROPIC_API_KEY,
  OPENAI_API_KEY: isTest ? undefined : raw.OPENAI_API_KEY,
  FLOOR_TOKEN_SECRET: raw.FLOOR_TOKEN_SECRET ?? raw.BETTER_AUTH_SECRET,
  /** Undefined only in production with ALLOW_MOCKS=true; the mailer then logs instead of sending. */
  SMTP_URL: raw.SMTP_URL ?? (isProd ? undefined : "smtp://localhost:1025"),
  MAIL_FROM: raw.MAIL_FROM ?? (isProd ? undefined : "InvAI <sheets@invai.local>"),
  /**
   * Imaging's public dev default (invai-imaging `DEV_SHARED_SECRET`). Never used in production:
   * there a missing secret sends no header, and imaging (which refuses the dev secret) answers 401.
   */
  IMAGING_SHARED_SECRET:
    raw.IMAGING_SHARED_SECRET ?? (isProd ? undefined : "invai-imaging-dev-secret"),
  /**
   * Tech lead decision (T-19-4 round 2, wave 19): a real digest email must not be able to go out
   * before OI-12/13/14 are answered, even if `SMTP_URL` is later set for a pilot. Off by default
   * in production; on everywhere else (dev, test), matching the digest acceptance tests, which
   * expect a send with no env override.
   */
  DIGEST_EMAIL_ENABLED: raw.DIGEST_EMAIL_ENABLED ?? !isProd,
  isDev: raw.NODE_ENV === "development",
  isTest,
  isProd,
  /** ALLOW_MOCKS=true: production may boot on mock providers (demo or staging stages only). */
  allowMocks: raw.ALLOW_MOCKS,
  mocks: {
    /** The mock only when neither AI key is set; Anthropic wins when both are (gateway.ts). */
    ai: isTest || (!raw.ANTHROPIC_API_KEY && !raw.OPENAI_API_KEY),
    carrier: !raw.EASYPOST_API_KEY,
    shopify: !raw.SHOPIFY_API_KEY || !raw.SHOPIFY_API_SECRET,
    supplier: !raw.SS_ACTIVEWEAR_ACCOUNT || !raw.SS_ACTIVEWEAR_API_KEY,
    billing: !raw.STRIPE_SECRET_KEY,
    /** Outside production a missing SMTP_URL means the local Mailpit sink. */
    mail: !raw.SMTP_URL,
    census: !raw.CENSUS_API_KEY,
    googleTrends: !raw.GOOGLE_TRENDS_API_KEY,
    pinterest: !raw.PINTEREST_API_KEY,
    jungleScout: !raw.JUNGLE_SCOUT_API_KEY,
  },
  /**
   * Sources a market mock should fail for right now (empty outside a deliberate test). Always
   * empty in production, whatever MARKET_MOCK_FAIL is set to: it exists to test the "no compliant
   * source" fallback, never to disable a real source in a real shop's account.
   */
  /** Test-only: the mock image provider alters the protected print region (drift path). */
  imageGenMockDrift: isTest && raw.IMAGE_GEN_MOCK_DRIFT === "1",
  marketMockFail: new Set(
    isProd
      ? []
      : (raw.MARKET_MOCK_FAIL ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
  ),
} as const;

export type Env = typeof env;
