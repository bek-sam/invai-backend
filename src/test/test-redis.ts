import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";

/**
 * Per-run Redis test DB (T-P1-1 B-228; T-49-3 B-438). Unless the caller pins `REDIS_URL` to a
 * non-zero DB or sets `TEST_REDIS_URL`, every `vitest` invocation claims its own free DB from 1-8.
 *
 * Valkey DB map (architect ruling R2, wave 49):
 *   0      dev and production app DB (tests never touch it, B-205)
 *   1-8    harness claims only: nothing but a test run's claim may live here, which is what makes
 *          the scoped clean-up below safe
 *   9      gate scratch and `full.sh`
 *   10-14  pinned stacks and pinned test runs (`REDIS_URL=.../12`, `TEST_REDIS_URL=...`)
 *   15     claim registry only (the `test-redis-db-lock:<n>` keys), never a test target
 *
 * A claim is short-lived (`CLAIM_TTL_MS`) and renewed by a heartbeat while the run lives, so a run
 * killed by SIGKILL frees its DB within one TTL without anybody deleting anything. Release is a
 * compare-and-set on our own token, on normal end, SIGINT and SIGTERM.
 */

export const REGISTRY_DB = 15;
export const DEFAULT_KEY_PREFIX = "test-redis-db-lock:";
export const MIN_DB = 1;
export const MAX_DB = 8;
/** Pinned test runs and builders' own stacks live here (env.ts enforces it). */
export const PIN_MIN_DB = 10;
export const PIN_MAX_DB = 14;
export const CLAIM_TTL_MS = 120_000;
export const HEARTBEAT_MS = 20_000;
/** When every DB is claimed: poll this often, for at most this long, taking over only dead PIDs. */
export const REAP_POLL_MS = 2_000;
export const REAP_WAIT_MS = 140_000;
const RELEASE_BOUND_MS = 2_000;
const TOKEN_SHAPE = /^(\d+):[0-9a-f-]{36}$/;

/** Release only when the key still holds our token (never delete a DB another run now owns). */
const RELEASE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
else
  return 0
end
`;

/** Heartbeat: extend our own claim only; 0 means the key is gone or is somebody else's. */
const RENEW_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('pexpire', KEYS[1], ARGV[2])
else
  return 0
end
`;

/** Reap: swap a dead run's token for ours, only if the key still holds exactly that token. */
const TAKEOVER_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  redis.call('set', KEYS[1], ARGV[2], 'PX', ARGV[3])
  return 1
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

export function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

/** True unless `kill(pid, 0)` says ESRCH (no such process). EPERM means it exists. */
export function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** What a claim needs to remember to be cleaned up safely later (see `cleanClaimedDbLeftovers`). */
export type ClaimDescriptor = {
  baseUrl: string;
  db: number;
  registryDb: number;
  key: string;
  token: string;
  pinned: boolean;
};

export type ClaimedTestRedis = {
  redisUrl: string;
  /** The claimed DB index, or undefined for a pinned URL. */
  db?: number;
  descriptor: ClaimDescriptor | undefined;
  /** True once a heartbeat saw the claim gone or taken (the run keeps going; nothing re-claims). */
  lost(): boolean;
  /** Releases the claimed DB. No-op when the caller pinned their own. */
  cleanup(): Promise<void>;
};

export type ClaimOptions = {
  baseUrl: string;
  pinnedUrl?: string;
  registryDb?: number;
  keyPrefix?: string;
  minDb?: number;
  maxDb?: number;
  ttlMs?: number;
  heartbeatMs?: number;
  reapWaitMs?: number;
  reapPollMs?: number;
  /** Install SIGINT/SIGTERM release handlers (default true). */
  signals?: boolean;
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Claims (or honors a pin for) the Redis DB a run's workers should use. `baseUrl` is the raw
 * `REDIS_URL` (host/port only; its own DB index is ignored). `pinnedUrl` is `TEST_REDIS_URL` or a
 * `REDIS_URL` already pinned to a non-zero DB.
 *
 * `registryDb`/`keyPrefix`/range/timing options exist for tests: production callers
 * (`global-setup.ts`) pass none and get the real registry. Tests use a unique prefix so they
 * never touch another run's real claim keys.
 */
export async function claimTestRedisDb(opts: ClaimOptions): Promise<ClaimedTestRedis> {
  if (opts.pinnedUrl) {
    return {
      redisUrl: opts.pinnedUrl,
      descriptor: undefined,
      lost: () => false,
      cleanup: async () => {},
    };
  }

  const registryDb = opts.registryDb ?? REGISTRY_DB;
  const keyPrefix = opts.keyPrefix ?? DEFAULT_KEY_PREFIX;
  const minDb = opts.minDb ?? MIN_DB;
  const maxDb = opts.maxDb ?? MAX_DB;
  const ttlMs = opts.ttlMs ?? CLAIM_TTL_MS;
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  const reapWaitMs = opts.reapWaitMs ?? REAP_WAIT_MS;
  const reapPollMs = opts.reapPollMs ?? REAP_POLL_MS;
  const token = `${process.pid}:${randomUUID()}`;
  const loopback = isLoopbackHost(new URL(opts.baseUrl).hostname);

  const registry = new Redis(withDb(opts.baseUrl, registryDb), {
    maxRetriesPerRequest: 1,
    lazyConnect: false,
  });
  // A connection error must not become an unhandled 'error' event after claiming.
  registry.on("error", () => {});

  let claimedKey: string | undefined;
  let claimedDb = 0;
  try {
    const deadline = Date.now() + reapWaitMs;
    for (;;) {
      for (let db = minDb; db <= maxDb && !claimedKey; db++) {
        const key = lockKey(db, keyPrefix);
        if ((await registry.set(key, token, "PX", ttlMs, "NX")) === "OK") {
          claimedKey = key;
          claimedDb = db;
        }
      }
      // Everything is claimed: a claim whose PID died on this host may be taken over atomically.
      if (!claimedKey && loopback) {
        for (let db = minDb; db <= maxDb && !claimedKey; db++) {
          const key = lockKey(db, keyPrefix);
          const held = await registry.get(key);
          const m = held ? TOKEN_SHAPE.exec(held) : null;
          if (!held || !m || pidIsAlive(Number(m[1]))) continue;
          const won = await registry.eval(TAKEOVER_SCRIPT, 1, key, held, token, String(ttlMs));
          if (won === 1) {
            claimedKey = key;
            claimedDb = db;
          }
        }
      }
      if (claimedKey || Date.now() >= deadline) break;
      await sleep(reapPollMs);
    }
  } catch (err) {
    await registry.quit().catch(() => {});
    throw err;
  }

  if (!claimedKey) {
    await registry.quit().catch(() => {});
    throw new Error(
      `every test Redis DB (${minDb}-${maxDb}) is already claimed by a live run; wait for one to ` +
        `finish. A run that died frees its claim by itself within ${Math.round(ttlMs / 1000)} s ` +
        `(keys ${lockKey(minDb, keyPrefix)}..${lockKey(maxDb, keyPrefix)} in DB ${registryDb}; do not delete them by hand).`,
    );
  }

  const key = claimedKey;
  let lostFlag = false;
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped || lostFlag) return;
    registry
      .eval(RENEW_SCRIPT, 1, key, token, String(ttlMs))
      .then((r) => {
        if (r === 0 && !lostFlag && !stopped) {
          lostFlag = true;
          clearInterval(timer);
          console.error(
            `test-redis claim lost: ${key} no longer holds this run's token; the run keeps its DB but nothing renews, re-claims or cleans it.`,
          );
        }
      })
      .catch(() => {});
  }, heartbeatMs);
  timer.unref();

  let released: Promise<void> | undefined;
  const release = (): Promise<void> => {
    released ??= (async () => {
      stopped = true;
      clearInterval(timer);
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
      const work = (async () => {
        try {
          await registry.eval(RELEASE_SCRIPT, 1, key, token);
        } catch (err) {
          console.warn(`[test-redis] could not release ${key}: ${(err as Error).message}`);
        } finally {
          await registry.quit().catch(() => {});
        }
      })();
      await Promise.race([work, sleep(RELEASE_BOUND_MS)]);
      registry.disconnect();
    })();
    return released;
  };

  function onSignal(signal: NodeJS.Signals) {
    // Release first, then take our handlers off and send the same signal again so the process
    // ends the way it would have without us (default action or the other handlers').
    void release().finally(() => {
      process.kill(process.pid, signal);
    });
  }
  if (opts.signals !== false) {
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  }

  return {
    redisUrl: withDb(opts.baseUrl, claimedDb),
    db: claimedDb,
    descriptor: {
      baseUrl: opts.baseUrl,
      db: claimedDb,
      registryDb,
      key,
      token,
      pinned: false,
    },
    lost: () => lostFlag,
    cleanup: release,
  };
}

/**
 * Pure precondition check of the clean-up; throws before any network call. The clean-up may only
 * ever empty a DB in 1-8 (the harness claim range, hard-coded here, not taken from options) that
 * this run claimed unpinned on a loopback host.
 */
export function planClaimedDbCleanup(d: ClaimDescriptor | undefined): {
  host: string;
  db: number;
} {
  if (!d) throw new Error("clean-up refused: no claim (the run is pinned)");
  if (d.pinned) throw new Error("clean-up refused: pinned URL");
  if (!Number.isInteger(d.db) || d.db < MIN_DB || d.db > MAX_DB) {
    throw new Error(
      `clean-up refused: DB ${d.db} is outside the harness claim range ${MIN_DB}-${MAX_DB}`,
    );
  }
  const url = new URL(d.baseUrl);
  if (!isLoopbackHost(url.hostname)) {
    throw new Error(`clean-up refused: ${url.hostname} is not a loopback host`);
  }
  return { host: url.host, db: d.db };
}

/**
 * Removes leftovers of earlier runs from the DB this run claimed (called only by global-setup,
 * right after a real-registry claim; never inside `claimTestRedisDb`). Re-checks that the registry
 * still holds this run's token, then SCAN + UNLINK on that DB only. Never a blocking full-keyspace command.
 * Returns the number of keys removed.
 */
export async function cleanClaimedDbLeftovers(d: ClaimDescriptor | undefined): Promise<number> {
  const plan = planClaimedDbCleanup(d);
  const desc = d as ClaimDescriptor;
  const registry = new Redis(withDb(desc.baseUrl, desc.registryDb), { maxRetriesPerRequest: 1 });
  registry.on("error", () => {});
  let target: Redis | undefined;
  try {
    const held = await registry.get(desc.key);
    if (held !== desc.token) {
      throw new Error(`clean-up refused: ${desc.key} does not hold this run's token`);
    }
    target = new Redis(withDb(desc.baseUrl, plan.db), { maxRetriesPerRequest: 1 });
    target.on("error", () => {});
    let removed = 0;
    let cursor = "0";
    do {
      const [next, keys] = await target.scan(cursor, "COUNT", 1000);
      cursor = next;
      if (keys.length) removed += await target.unlink(...keys);
    } while (cursor !== "0");
    return removed;
  } finally {
    await registry.quit().catch(() => {});
    if (target) await target.quit().catch(() => {});
  }
}
