import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";

/**
 * Per-run Redis test DB (T-P1-1, B-228/B-205 follow-up). Unless the caller pins `REDIS_URL` to a
 * non-zero DB or sets `TEST_REDIS_URL`, every `vitest` invocation claims its own free DB from
 * 1–14 — replacing the previous fallback (a single shared DB 15 every plain run piled onto,
 * which is exactly the collision `team/agent-brief.md` told agents to work around by hand).
 *
 * DB 0 is the dev/CI worker's DB (never touched by tests, per B-205) and DB 15 is never handed
 * out as a test target either: it's reserved as the registry this file's own lock keys live in,
 * so claiming/releasing a test DB never has to touch DB 0 or compete with real test data for a
 * key namespace.
 */

const REGISTRY_DB = 15;
const DEFAULT_KEY_PREFIX = "test-redis-db-lock:";
const MIN_DB = 1;
const MAX_DB = 14;
/** Long enough for a full `pnpm test` run with slack (~9 min observed; see agent memory). */
const CLAIM_TTL_MS = 2 * 60 * 60 * 1000;

/** Only releases the lock if it still holds our token (a CAS, not a bare DEL — never release a
 *  DB another run claimed after our TTL lapsed). */
const RELEASE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
else
  return 0
end
`;

function lockKey(db: number, keyPrefix: string): string {
  return `${keyPrefix}${db}`;
}

function withDb(url: string, db: number): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

export type ClaimedTestRedis = {
  redisUrl: string;
  /** Releases the claimed DB. No-op when the caller pinned their own. */
  cleanup(): Promise<void>;
};

/**
 * AC2/AC3: claims (or honors a pin for) the Redis DB a run's workers should use. `baseUrl` is the
 * raw, un-redirected `REDIS_URL` (host/port only; its own DB index, if any, is ignored — callers
 * resolve "already pinned to non-zero" before calling this, same as `env.ts`'s existing
 * `isPinnedNonZeroDb`). `pinnedUrl` is `TEST_REDIS_URL`, or a `REDIS_URL` already pinned to a
 * non-zero DB, when the caller set one.
 *
 * `registryDb`/`keyPrefix` let a caller point the claim/release bookkeeping at a different
 * registry location than the real one (DB 15, `test-redis-db-lock:`). Production callers
 * (`global-setup.ts`) never pass these, so they get the real shared registry unchanged. Unit
 * tests of this module pass a unique `keyPrefix` so they never read, write or delete another
 * run's real claim keys (T-P1-1 round 2, review finding 1).
 */
export async function claimTestRedisDb(opts: {
  baseUrl: string;
  pinnedUrl?: string;
  registryDb?: number;
  keyPrefix?: string;
}): Promise<ClaimedTestRedis> {
  if (opts.pinnedUrl) {
    return { redisUrl: opts.pinnedUrl, cleanup: async () => {} };
  }

  const registryDb = opts.registryDb ?? REGISTRY_DB;
  const keyPrefix = opts.keyPrefix ?? DEFAULT_KEY_PREFIX;
  const token = `${process.pid}:${randomUUID()}`;
  const registry = new Redis(withDb(opts.baseUrl, registryDb), {
    maxRetriesPerRequest: 1,
    lazyConnect: false,
  });
  try {
    for (let db = MIN_DB; db <= MAX_DB; db++) {
      const key = lockKey(db, keyPrefix);
      const ok = await registry.set(key, token, "PX", CLAIM_TTL_MS, "NX");
      if (ok === "OK") {
        return {
          redisUrl: withDb(opts.baseUrl, db),
          cleanup: () => releaseTestRedisDb(opts.baseUrl, registryDb, key, token),
        };
      }
    }
    throw new Error(
      `every test Redis DB (${MIN_DB}-${MAX_DB}) is already claimed; wait for another run to ` +
        `finish, or (if one crashed without releasing) clear its stale ${lockKey(MIN_DB, keyPrefix)}..${lockKey(MAX_DB, keyPrefix)} key in DB ${registryDb} once its TTL should have lapsed.`,
    );
  } finally {
    await registry.quit().catch(() => {});
  }
}

async function releaseTestRedisDb(
  baseUrl: string,
  registryDb: number,
  key: string,
  token: string,
): Promise<void> {
  const registry = new Redis(withDb(baseUrl, registryDb), { maxRetriesPerRequest: 1 });
  try {
    await registry.eval(RELEASE_SCRIPT, 1, key, token);
  } catch (err) {
    console.warn(`[test-redis] could not release ${key}: ${(err as Error).message}`);
  } finally {
    await registry.quit().catch(() => {});
  }
}
