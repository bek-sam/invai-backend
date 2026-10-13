import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { afterEach, describe, expect, it } from "vitest";
import { type ClaimedTestRedis, claimTestRedisDb } from "./test-redis";
import { planRegistryClean, prefixOf, runRegistryClean } from "./valkey-registry-clean";

const HOST = new URL(process.env.REDIS_URL as string).host;
const BASE_URL = `redis://${HOST}`;
const [hostname, port] = HOST.split(":") as [string, string];

describe("planRegistryClean", () => {
  it("targets DB 15 only, dry run by default, loopback only", () => {
    expect(planRegistryClean([], undefined)).toEqual({
      host: "localhost",
      port: "6379",
      db: 15,
      apply: false,
    });
    // The URL's own DB is ignored: nothing can point this command at another DB.
    expect(planRegistryClean(["--apply", "--url=redis://127.0.0.1:6379/0"], undefined)).toEqual({
      host: "127.0.0.1",
      port: "6379",
      db: 15,
      apply: true,
    });
    expect(planRegistryClean([], "redis://localhost:6379/9").db).toBe(15);
  });

  it("refuses a non-loopback host and unknown arguments", () => {
    expect(() => planRegistryClean([], "redis://cache.example.test:6379")).toThrow(/loopback/);
    expect(() => planRegistryClean(["--url=redis://10.0.0.5:6379"], undefined)).toThrow(/loopback/);
    expect(() => planRegistryClean(["--db=0"], undefined)).toThrow(/unknown argument/);
  });

  it("groups keys by their first prefix", () => {
    expect(prefixOf("bull:ship:id")).toBe("bull:");
    expect(prefixOf("plain")).toBe("(no prefix)");
  });
});

describe("runRegistryClean", () => {
  const held: ClaimedTestRedis[] = [];
  afterEach(async () => {
    for (const c of held.splice(0)) await c.cleanup();
  });

  it("a dead endpoint is reached and fails; nothing else is touched", async () => {
    await expect(
      runRegistryClean({ host: "127.0.0.1", port: "1", db: 15, apply: true }),
    ).rejects.toThrow();
  });

  it("dry run lists and removes nothing; --apply removes only non-claim keys", async () => {
    // Stand-in registry: a DB this run claimed for itself, with a test claim prefix, so the real
    // DB 15 is never written by a test.
    const mine = await claimTestRedisDb({ baseUrl: BASE_URL, reapWaitMs: 20_000, signals: false });
    held.push(mine);
    const db = mine.db as number;
    const r = new Redis(`${BASE_URL}/${db}`, { maxRetriesPerRequest: 1 });
    const claimPrefix = `rc-lock-${randomUUID()}:`;
    try {
      await r.flushdb(); // the claimed DB is this run's own; start from a known state
      await r.set(`${claimPrefix}1`, "1234:claim");
      await r.set(`${claimPrefix}2`, "1235:claim");
      for (let i = 0; i < 40; i++) await r.set(`bull:ship:${i}`, "x");
      await r.set("realtime:stream", "x");
      const plan = { host: hostname, port, db, apply: false };

      const dry = await runRegistryClean(plan, claimPrefix);
      expect(dry).toMatchObject({ total: 43, other: 41, removed: 0 });
      expect(dry.claims.sort()).toEqual([`${claimPrefix}1`, `${claimPrefix}2`]);
      expect(dry.byPrefix).toEqual({ "bull:": 40, "realtime:": 1 });
      expect(await r.dbsize()).toBe(43);

      const applied = await runRegistryClean({ ...plan, apply: true }, claimPrefix);
      expect(applied.removed).toBe(41);
      expect(await r.dbsize()).toBe(2);
      expect(await r.get(`${claimPrefix}1`)).toBe("1234:claim");
      expect(await r.get(`${claimPrefix}2`)).toBe("1235:claim");
    } finally {
      r.disconnect();
    }
  });
});
