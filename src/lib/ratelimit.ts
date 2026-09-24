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
