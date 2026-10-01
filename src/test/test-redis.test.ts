import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { afterEach, describe, expect, it } from "vitest";
import { claimTestRedisDb } from "./test-redis";

// Raw REDIS_URL (host/port only; env.ts never mutates process.env, only its own exported `env`
// object), exactly what global-setup.ts passes as baseUrl.
const BASE_URL = `redis://${new URL(process.env.REDIS_URL as string).host}`;
const REGISTRY_DB = 15;

// T-P1-1 round 2 (review finding 1): this suite used to read/write/delete the *real* shared
// registry keys (`test-redis-db-lock:*`) in the live DB-15 registry — the same registry every
// concurrently running `pnpm test` invocation claims its Redis DB from. Its `afterEach` deleted
// every key matching that prefix, including other live runs' claims, and one test filled all 14
// slots for 60s under that same prefix, so a run starting elsewhere during this file could fail
// to claim a DB or (worse) share one with another run. Using a unique prefix per test-file run
// means every `SET`/`GET`/`DEL`/`KEYS` this file does only ever touches its own keys, never the
// real registry, so this suite is safe to run alongside any number of other live `pnpm test`
// invocations without affecting them.
const KEY_PREFIX = `test-redis-db-lock-ut-${process.pid}-${randomUUID()}:`;

function withDb(db: number): string {
  return `${BASE_URL}/${db}`;
}

function claim(opts: { pinnedUrl?: string } = {}) {
  return claimTestRedisDb({ baseUrl: BASE_URL, keyPrefix: KEY_PREFIX, ...opts });
}

async function registryClient() {
  return new Redis(withDb(REGISTRY_DB), { maxRetriesPerRequest: 1 });
}

/** Clears only this run's own `KEY_PREFIX` keys — never a global sweep of the real registry. */
async function clearOwnKeys() {
  const client = await registryClient();
  try {
    const keys = await client.keys(`${KEY_PREFIX}*`);
    if (keys.length) await client.del(...keys);
  } finally {
    await client.quit();
  }
}

describe("claimTestRedisDb", () => {
  afterEach(clearOwnKeys);

  it("an explicit pin wins unchanged, with a no-op cleanup", async () => {
    const result = await claim({ pinnedUrl: withDb(14) });
    expect(result.redisUrl).toBe(withDb(14));
    await expect(result.cleanup()).resolves.toBeUndefined();
  });

  it("unpinned: claims a DB in 1-14, never 0 or 15 (AC2)", async () => {
    const result = await claim();
    try {
      const db = Number(new URL(result.redisUrl).pathname.slice(1));
      expect(db).toBeGreaterThanOrEqual(1);
      expect(db).toBeLessThanOrEqual(14);
    } finally {
      await result.cleanup();
    }
  });

  it("two concurrent unpinned claims get two different DBs", async () => {
    const [a, b] = await Promise.all([claim(), claim()]);
    try {
      expect(a.redisUrl).not.toBe(b.redisUrl);
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  });

  it("cleanup releases the DB so a later claim can reuse it", async () => {
    const first = await claim();
    await first.cleanup();

    const client = await registryClient();
    try {
      // Scoped to this run's own prefix only — never a global "the registry is empty" claim,
      // which would be false whenever another run is live at the same time.
      const held = await client.keys(`${KEY_PREFIX}*`);
      expect(held).toEqual([]);
    } finally {
      await client.quit();
    }
  });

  it("fails with a clear message when every DB (1-14) is already claimed", async () => {
    const client = await registryClient();
    try {
      for (let db = 1; db <= 14; db++) {
        await client.set(`${KEY_PREFIX}${db}`, "someone-else", "PX", 60_000, "NX");
      }
      await expect(claim()).rejects.toThrow(/every test Redis DB \(1-14\) is already claimed/);
    } finally {
      await client.quit();
    }
  });

  it("never releases a DB another run claimed after this run's lock lapsed (CAS, not a bare DEL)", async () => {
    const result = await claim();
    const db = Number(new URL(result.redisUrl).pathname.slice(1));

    // Simulate another run reclaiming the same DB after our TTL lapsed.
    const client = await registryClient();
    try {
      await client.set(`${KEY_PREFIX}${db}`, "another-run", "PX", 60_000, "XX");
      await result.cleanup(); // must not release a lock value that isn't ours
      const stillHeld = await client.get(`${KEY_PREFIX}${db}`);
      expect(stillHeld).toBe("another-run");
    } finally {
      await client.del(`${KEY_PREFIX}${db}`);
      await client.quit();
    }
  });
});
