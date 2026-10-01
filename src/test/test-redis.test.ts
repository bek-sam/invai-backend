import { Redis } from "ioredis";
import { afterEach, describe, expect, it } from "vitest";
import { claimTestRedisDb } from "./test-redis";

// Raw REDIS_URL (host/port only; env.ts never mutates process.env, only its own exported `env`
// object), exactly what global-setup.ts passes as baseUrl.
const BASE_URL = `redis://${new URL(process.env.REDIS_URL as string).host}`;
const REGISTRY_DB = 15;

function withDb(db: number): string {
  return `${BASE_URL}/${db}`;
}

async function registryClient() {
  return new Redis(withDb(REGISTRY_DB), { maxRetriesPerRequest: 1 });
}

/** Clears every test-redis-db-lock:* key left by a run this file didn't clean up itself. */
async function clearRegistry() {
  const client = await registryClient();
  try {
    const keys = await client.keys("test-redis-db-lock:*");
    if (keys.length) await client.del(...keys);
  } finally {
    await client.quit();
  }
}

describe("claimTestRedisDb", () => {
  afterEach(clearRegistry);

  it("an explicit pin wins unchanged, with a no-op cleanup", async () => {
    const claim = await claimTestRedisDb({ baseUrl: BASE_URL, pinnedUrl: withDb(14) });
    expect(claim.redisUrl).toBe(withDb(14));
    await expect(claim.cleanup()).resolves.toBeUndefined();
  });

  it("unpinned: claims a DB in 1-14, never 0 or 15 (AC2)", async () => {
    const claim = await claimTestRedisDb({ baseUrl: BASE_URL });
    try {
      const db = Number(new URL(claim.redisUrl).pathname.slice(1));
      expect(db).toBeGreaterThanOrEqual(1);
      expect(db).toBeLessThanOrEqual(14);
    } finally {
      await claim.cleanup();
    }
  });

  it("two concurrent unpinned claims get two different DBs", async () => {
    const [a, b] = await Promise.all([
      claimTestRedisDb({ baseUrl: BASE_URL }),
      claimTestRedisDb({ baseUrl: BASE_URL }),
    ]);
    try {
      expect(a.redisUrl).not.toBe(b.redisUrl);
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  });

  it("cleanup releases the DB so a later claim can reuse it", async () => {
    const first = await claimTestRedisDb({ baseUrl: BASE_URL });
    await first.cleanup();

    const client = await registryClient();
    try {
      const held = await client.keys("test-redis-db-lock:*");
      expect(held).toEqual([]);
    } finally {
      await client.quit();
    }
  });

  it("fails with a clear message when every DB (1-14) is already claimed", async () => {
    const client = await registryClient();
    try {
      for (let db = 1; db <= 14; db++) {
        await client.set(`test-redis-db-lock:${db}`, "someone-else", "PX", 60_000, "NX");
      }
      await expect(claimTestRedisDb({ baseUrl: BASE_URL })).rejects.toThrow(
        /every test Redis DB \(1-14\) is already claimed/,
      );
    } finally {
      await client.quit();
    }
  });

  it("never releases a DB another run claimed after this run's lock lapsed (CAS, not a bare DEL)", async () => {
    const claim = await claimTestRedisDb({ baseUrl: BASE_URL });
    const db = Number(new URL(claim.redisUrl).pathname.slice(1));

    // Simulate another run reclaiming the same DB after our TTL lapsed.
    const client = await registryClient();
    try {
      await client.set(`test-redis-db-lock:${db}`, "another-run", "PX", 60_000, "XX");
      await claim.cleanup(); // must not release a lock value that isn't ours
      const stillHeld = await client.get(`test-redis-db-lock:${db}`);
      expect(stillHeld).toBe("another-run");
    } finally {
      await client.del(`test-redis-db-lock:${db}`);
      await client.quit();
    }
  });
});
