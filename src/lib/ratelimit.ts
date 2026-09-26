import { logger } from "./log";
import { redis } from "./queues";

const log = logger("ratelimit");

/*
 * Fixed-window failure counters in Redis (shared by every API process). Used for brute-force
 * lockouts such as floor PIN attempts. Redis trouble fails open after a short timeout: the
 * station token is still required, and a stuck Redis must not freeze the floor.
 */

const TIMEOUT_MS = 500;

function withTimeout<T>(p: Promise<T>): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("redis timeout")), TIMEOUT_MS)),
  ]);
}

/** Seconds until the lock clears when `key` has `max` or more failures, else null. */
export async function lockedFor(key: string, max: number): Promise<number | null> {
  try {
    const [count, ttl] = await withTimeout(
      Promise.all([redis.get(`rl:${key}`), redis.ttl(`rl:${key}`)]),
    );
    if (Number(count ?? 0) >= max) return ttl > 0 ? ttl : 1;
    return null;
  } catch (err) {
    log.warn("rate limit check failed (allowing)", { key, error: String(err) });
    return null;
  }
}

/** Count one failure; the window starts at the first failure. Returns the new count. */
export async function recordFailure(key: string, windowSec: number): Promise<number> {
  try {
    const [[, n]] = (await withTimeout(
      redis.multi().incr(`rl:${key}`).expire(`rl:${key}`, windowSec, "NX").exec(),
    )) as [[Error | null, number]];
    return n;
  } catch (err) {
    log.warn("rate limit record failed", { key, error: String(err) });
    return 0;
  }
}

export async function clearFailures(key: string): Promise<void> {
  try {
    await withTimeout(redis.del(`rl:${key}`));
  } catch (err) {
    log.warn("rate limit clear failed", { key, error: String(err) });
  }
}

/** Mark a key as revoked until it expires on its own (e.g. a logged-out floor session). */
export async function revokeUntil(key: string, ttlSec: number): Promise<void> {
  if (ttlSec <= 0) return;
  try {
    await withTimeout(redis.set(`revoked:${key}`, "1", "EX", ttlSec));
  } catch (err) {
    log.warn("revoke failed", { key, error: String(err) });
  }
}

export async function isRevoked(key: string): Promise<boolean> {
  try {
    return (await withTimeout(redis.exists(`revoked:${key}`))) === 1;
  } catch (err) {
    log.warn("revocation check failed (allowing)", { key, error: String(err) });
    return false;
  }
}

/*
 * Per-tenant API rate limits (T-12-3, B-20): a Valkey token bucket keyed by `company_id`, not
 * IP -- one office sharing a NAT and one abusive script both trip the same limit whichever IP
 * they use. Four buckets (auth, reads, writes, ai) so a slow batch of writes can't starve a read,
 * and AI calls (the most expensive) get their own, smaller budget. Same fail-open convention as
 * the rest of this file: a Redis timeout allows the request and logs a warning.
 */

export type RateBucket = "auth" | "reads" | "writes" | "ai";

export type BucketLimits = { capacity: number; refillPerSec: number };

/** Requests per minute, expressed as capacity (burst) + steady refill. */
function perMinute(capacity: number): BucketLimits {
  return { capacity, refillPerSec: capacity / 60 };
}

/** Defaults per bucket; a caller (or a test) may pass its own `BucketLimits` instead. */
export const RATE_BUCKET_LIMITS: Record<RateBucket, BucketLimits> = {
  auth: perMinute(20), // PIN/station-token attempts: tight, but a busy floor still fits
  reads: perMinute(300),
  writes: perMinute(120),
  ai: perMinute(20), // the AI gateway has its own per-company spend breaker; this is request volume
};

/**
 * Atomic Redis-side token bucket. `KEYS[1]` is the bucket key; a Redis hash holds `tokens` and
 * `ts` (last refill, seconds). One EVAL does read-refill-decide-write in a single round trip, so
 * concurrent requests (this API process or another one, same Redis) can't both read a stale
 * balance and both be admitted.
 */
const TOKEN_BUCKET_SCRIPT = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])

local tokens = capacity
local ts = now
local existing = redis.call('HMGET', key, 'tokens', 'ts')
if existing[1] then
  tokens = tonumber(existing[1])
  ts = tonumber(existing[2])
  local elapsed = now - ts
  if elapsed > 0 then
    tokens = math.min(capacity, tokens + elapsed * refill)
  end
end

local allowed = 0
local retryAfter = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  retryAfter = math.ceil((1 - tokens) / refill)
end

redis.call('HSET', key, 'tokens', tokens, 'ts', now)
redis.call('EXPIRE', key, ttl)
return {allowed, retryAfter}
`;

export function rateLimitKey(bucket: RateBucket, companyId: string): string {
  return `tb:${bucket}:${companyId}`;
}

/**
 * Take one token from `key`'s bucket. Fails open (allowed, `retryAfterSec: 0`) on a Redis error
 * or timeout: a stuck Valkey must not 429 every tenant.
 */
export async function takeToken(
  key: string,
  limits: BucketLimits,
): Promise<{ allowed: boolean; retryAfterSec: number }> {
  try {
    const now = Date.now() / 1000;
    const ttl = Math.ceil(limits.capacity / limits.refillPerSec) + 60;
    const [allowed, retryAfter] = (await withTimeout(
      redis.eval(TOKEN_BUCKET_SCRIPT, 1, key, limits.capacity, limits.refillPerSec, now, ttl),
    )) as [number, number];
    return { allowed: allowed === 1, retryAfterSec: allowed === 1 ? 0 : Math.max(1, retryAfter) };
  } catch (err) {
    log.warn("rate limit token bucket failed (allowing)", { key, error: String(err) });
    return { allowed: true, retryAfterSec: 0 };
  }
}

export async function checkRateLimit(
  bucket: RateBucket,
  companyId: string,
  limits: BucketLimits = RATE_BUCKET_LIMITS[bucket],
): Promise<{ allowed: boolean; retryAfterSec: number }> {
  return takeToken(rateLimitKey(bucket, companyId), limits);
}

/*
 * Better Auth rate limiting, moved to Valkey (T-2-3 follow-up, T-12-3 item 2). Better Auth's
 * built-in `rateLimit.storage: "memory"` is a plain in-process Map, so two API processes (or two
 * dev-worker restarts) each allow the full quota -- the counter never leaves the process that
 * happened to handle the request. `rateLimit.customStorage` (src/auth.ts) points it at this
 * instead: same fixed-window algorithm Better Auth's own memory/database storages use (count
 * resets once `now - lastRequest >= window`), but the read-check-write happens in one Redis EVAL,
 * shared by every process against the same Redis. Fails open on a Redis error, same convention.
 */

const AUTH_FIXED_WINDOW_SCRIPT = `
local key = KEYS[1]
local max = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local now = tonumber(ARGV[3])

local data = redis.call('HMGET', key, 'count', 'lastRequest')
local count = tonumber(data[1])
local lastRequest = tonumber(data[2])

if count == nil or (now - lastRequest) >= windowMs then
  redis.call('HSET', key, 'count', 1, 'lastRequest', now)
  redis.call('PEXPIRE', key, windowMs)
  return {1, -1}
end

if count >= max then
  return {0, lastRequest}
end

redis.call('HINCRBY', key, 'count', 1)
return {1, -1}
`;

/** `key`/`rule` match Better Auth's `BetterAuthRateLimitStorage["consume"]` shape exactly. */
export async function betterAuthConsume(
  key: string,
  rule: { window: number; max: number },
): Promise<{ allowed: boolean; retryAfter: number | null }> {
  try {
    const now = Date.now();
    const windowMs = rule.window * 1000;
    const [allowed, lastRequest] = (await withTimeout(
      redis.eval(AUTH_FIXED_WINDOW_SCRIPT, 1, `ba-rl:${key}`, rule.max, windowMs, now),
    )) as [number, number];
    if (allowed === 1) return { allowed: true, retryAfter: null };
    return {
      allowed: false,
      retryAfter: Math.max(1, Math.ceil((lastRequest + windowMs - now) / 1000)),
    };
  } catch (err) {
    log.warn("better auth rate limit check failed (allowing)", { key, error: String(err) });
    return { allowed: true, retryAfter: null };
  }
}
