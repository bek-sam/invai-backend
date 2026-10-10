import { env } from "../env";
import { logContext } from "./log-context";
import { activeTraceId } from "./tracing";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;
const threshold = LEVELS[env.LOG_LEVEL];

/* ---- Redaction (T-32-5, S-29 logging part) ------------------------------------------------- */

export const REDACTED = "[redacted]";

/** A key holding any of these words is redacted, whatever its depth: `shipTo.email`, `x_api_token`. */
const PII_WORDS = new Set([
  "email",
  "emails",
  "phone",
  "phones",
  "address",
  "addresses",
  "street",
  "street1",
  "street2",
  "city",
  "zip",
  "zipcode",
  "personalization",
  "password",
  "passwd",
  "secret",
  "secrets",
  "token",
  "authorization",
  "cookie",
  "cookies",
]);

/** Whole keys (lowercase, separators removed). Bare `name` is NOT here: event and job names. */
const PII_KEYS = new Set([
  "buyername",
  "shipname",
  "firstname",
  "lastname",
  "fullname",
  "recipientname",
  "customername",
  "buyernote",
  "buyernotes",
  "giftmessage",
  "postalcode",
  "line1",
  "line2",
  "apikey",
  "values",
  "params",
]);

/** Ids, counts and flags about a field are not the field: `stationTokenId`, `emailVerified`. */
const SAFE_LAST_WORDS = new Set(["id", "ids", "count", "verified", "at", "kind", "type", "status"]);

function words(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export function isSensitiveKey(key: string): boolean {
  const w = words(key);
  if (w.length === 0) return false;
  const compact = w.join("");
  if (compact.startsWith("fieldencryption")) return true;
  if (SAFE_LAST_WORDS.has(w[w.length - 1] as string)) return false;
  return PII_KEYS.has(compact) || w.some((x) => PII_WORDS.has(x));
}

const MAX_DEPTH = 8;

/**
 * A copy of `value` safe to log, at any depth: every sensitive key's value is `[redacted]`, every
 * string loses drizzle's `params:` tail (S-68: `{ error: String(err) }` call sites), an `Error`
 * becomes `errorData(err)`, and any other class instance becomes its own fields, redacted the same
 * way (or `[ClassName]` when it has none). Dates are kept.
 */
export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return scrubParams(value);
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Error) return errorData(value);
  if (value instanceof Date) return value;
  if (seen.has(value)) return "[circular]";
  if (depth >= MAX_DEPTH) return "[depth]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1, seen));
  const proto = Object.getPrototypeOf(value);
  const plain = proto === Object.prototype || proto === null;
  const className = (proto?.constructor as { name?: string } | undefined)?.name || "Object";
  if (!plain && (ArrayBuffer.isView(value) || value instanceof ArrayBuffer))
    return `[${className}]`;
  const entries = Object.entries(value);
  if (!plain && entries.length === 0) return `[${className}]`;
  const out: Record<string, unknown> = {};
  for (const [k, v] of entries) out[k] = isSensitiveKey(k) ? REDACTED : redact(v, depth + 1, seen);
  return out;
}

/* ---- Lines ---------------------------------------------------------------------------------- */

/**
 * One log record: the scope's context (requestId / queue, job, jobId / companyId, from
 * lib/log-context.ts), the active traceId when tracing is on, then the call's data, redacted.
 */
export function logRecord(
  level: Level,
  scope: string,
  msg: string,
  data?: Record<string, unknown>,
): Record<string, unknown> {
  const traceId = activeTraceId();
  const fields = {
    ...logContext(),
    ...(traceId ? { traceId } : {}),
    ...(data ? (redact(data) as Record<string, unknown>) : {}),
  };
  return { t: new Date().toISOString(), level, scope, msg, ...fields };
}

function write(level: Level, scope: string, msg: string, data?: Record<string, unknown>) {
  if (LEVELS[level] < threshold) return;
  const line = logRecord(level, scope, msg, data);
  const out = level === "error" || level === "warn" ? console.error : console.log;
  if (env.isProd) return out(JSON.stringify(line));
  const { t: _t, level: _l, scope: _s, msg: _m, ...fields } = line;
  out(`[${scope}] ${msg}${Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : ""}`);
}

/** Tiny structured logger. `logger("orders")` gives a scoped instance. */
export function logger(scope: string) {
  return {
    debug: (msg: string, data?: Record<string, unknown>) => write("debug", scope, msg, data),
    info: (msg: string, data?: Record<string, unknown>) => write("info", scope, msg, data),
    warn: (msg: string, data?: Record<string, unknown>) => write("warn", scope, msg, data),
    error: (msg: string, data?: Record<string, unknown>) => write("error", scope, msg, data),
  };
}

export type Logger = ReturnType<typeof logger>;

/* ---- Errors --------------------------------------------------------------------------------- */

/** drizzle's DrizzleQueryError appends `\nparams: <values>` to its message and stack. */
const PARAMS_FROM = "\nparams: ";
/** Fallback for a stack whose header isn't the message: cut up to the first V8 frame line. */
const PARAMS_LINE = /\nparams: [\s\S]*?(?=\n {4}at |$)/g;

/**
 * Cuts a non-stack text from drizzle's `\nparams: ` to its end, so a multi-line value (even one
 * with a line that looks like a stack frame) leaves nothing behind (S-68 c).
 */
export function scrubParams(text: string): string {
  const i = text.indexOf(PARAMS_FROM);
  return i < 0 ? text : text.slice(0, i);
}

function scrubMessage(err: Error): string {
  const q = err as Error & { query?: unknown; params?: unknown };
  if (typeof q.query === "string" && "params" in q) return `Failed query: ${q.query}`;
  return scrubParams(err.message);
}

/** The stack with its message header replaced by the scrubbed message; frames are kept. */
function scrubStack(stack: string, err: Error, message: string): string {
  const i = err.message ? stack.indexOf(err.message) : -1;
  const out = i < 0 ? stack : stack.slice(0, i) + message + stack.slice(i + err.message.length);
  return out.replace(PARAMS_LINE, "");
}

type PgFields = { code?: unknown; constraint?: unknown };

/**
 * Loggable fields of an error: the message and (outside production) the stack, both without
 * query parameters, plus the Postgres `code` and `constraint` of the error or its cause. The
 * cause's `detail` and message are never copied: a unique violation echoes the duplicate value.
 */
export function errorData(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return { error: scrubParams(String(err)) };
  const error = scrubMessage(err);
  const out: Record<string, unknown> = {
    error,
    stack: env.isProd || !err.stack ? undefined : scrubStack(err.stack, err, error),
  };
  for (const src of [err as PgFields, err.cause as PgFields | undefined]) {
    if (!src || typeof src !== "object") continue;
    if (typeof src.code === "string" && out.code === undefined) out.code = src.code;
    if (typeof src.constraint === "string" && out.constraint === undefined)
      out.constraint = src.constraint;
  }
  return out;
}
