import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Redis } from "ioredis";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ClaimDescriptor,
  type ClaimedTestRedis,
  claimTestRedisDb,
  cleanClaimedDbLeftovers,
  isLoopbackHost,
  MAX_DB,
  MIN_DB,
  planClaimedDbCleanup,
} from "./test-redis";

// Raw REDIS_URL host/port, exactly what global-setup.ts passes as baseUrl.
const HOST = new URL(process.env.REDIS_URL as string).host;
const BASE_URL = `redis://${HOST}`;
// 0.0.0.0 reaches the same server on macOS and Linux but is not a loopback name, so claimers
// using it can never take over a dead PID's claim: only the TTL frees a DB.
const NON_LOOPBACK_URL = `redis://${HOST.replace(/^[^:]+/, "0.0.0.0")}`;
// Registry for these tests: the DB this run itself claimed (never DB 15, never a shared one).
const OWN_DB = Number(new URL(process.env.REDIS_URL as string).pathname.slice(1));
const KEY_PREFIX = `tr-ut-${process.pid}-${randomUUID()}:`;

const url = (db: number) => `${BASE_URL}/${db}`;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const open: ClaimedTestRedis[] = [];
const kids: ChildProcess[] = [];
const admin = new Redis(url(OWN_DB), { maxRetriesPerRequest: 1 });

function claim(extra: Partial<Parameters<typeof claimTestRedisDb>[0]> = {}) {
  return claimTestRedisDb({
    baseUrl: BASE_URL,
    registryDb: OWN_DB,
    keyPrefix: KEY_PREFIX,
    minDb: 1,
    maxDb: 3,
    ttlMs: 60_000,
    heartbeatMs: 10_000,
    reapWaitMs: 200,
    reapPollMs: 50,
    signals: false,
    ...extra,
  }).then((c) => {
    open.push(c);
    return c;
  });
}

async function ownKeys() {
  const out: string[] = [];
  let cursor = "0";
  do {
    const [next, keys] = await admin.scan(cursor, "MATCH", `${KEY_PREFIX}*`, "COUNT", 500);
    cursor = next;
    out.push(...keys);
  } while (cursor !== "0");
  return out;
}

afterEach(async () => {
  for (const k of kids.splice(0)) k.kill("SIGKILL");
  for (const c of open.splice(0)) await c.cleanup();
  const keys = await ownKeys();
  if (keys.length) await admin.unlink(...keys);
});

function spawnClaimer(env: Record<string, string>) {
  const child = spawn(process.execPath, ["--import", "tsx", "src/test/test-redis-claimer.ts"], {
    env: {
      PATH: process.env.PATH ?? "",
      CLAIMER_BASE_URL: NON_LOOPBACK_URL,
      CLAIMER_REGISTRY_DB: String(OWN_DB),
      CLAIMER_PREFIX: KEY_PREFIX,
      CLAIMER_MIN: "1",
      CLAIMER_MAX: "3",
      CLAIMER_TTL_MS: "1500",
      CLAIMER_HEARTBEAT_MS: "300",
      CLAIMER_REAP_WAIT_MS: "100",
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  kids.push(child);
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) =>
    child.on("exit", (code, signal) => res({ code, signal })),
  );
  const claimed = new Promise<{ db: number; token: string }>((res, rej) => {
    let buf = "";
    child.stdout?.on("data", (d) => {
      buf += String(d);
      const m = /CLAIMED (\d+) (\S+)/.exec(buf);
      if (m) res({ db: Number(m[1]), token: m[2] as string });
    });
    child.stderr?.on("data", (d) => {
      buf += String(d);
      if (buf.includes("CLAIM_FAILED")) rej(new Error(buf.trim()));
    });
    exit.then(() => rej(new Error(`claimer exited before claiming: ${buf.trim()}`)));
  });
  claimed.catch(() => {});
  return { child, claimed, exit };
}

async function deadPid(): Promise<number> {
  const c = spawn(process.execPath, ["-e", ""]);
  const pid = c.pid as number;
  await new Promise((r) => c.on("exit", r));
  return pid;
}

describe("claimTestRedisDb: claim, expiry, release", () => {
  it("an explicit pin wins unchanged, with a no-op cleanup and no descriptor", async () => {
    const result = await claim({ pinnedUrl: url(14) });
    expect(result.redisUrl).toBe(url(14));
    expect(result.descriptor).toBeUndefined();
    await expect(result.cleanup()).resolves.toBeUndefined();
  });

  it("unpinned: claims a DB inside the range with a short TTL (AC1)", async () => {
    const result = await claim({ ttlMs: 5_000 });
    expect(result.db).toBeGreaterThanOrEqual(1);
    expect(result.db).toBeLessThanOrEqual(3);
    const ttl = await admin.pttl(`${KEY_PREFIX}${result.db}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(5_000);
  });

  it("the default range is 1-8 (R2): never 0, 9-14 or 15", () => {
    expect([MIN_DB, MAX_DB]).toEqual([1, 8]);
  });

  it("two concurrent unpinned claims get two different DBs", async () => {
    const [a, b] = await Promise.all([claim(), claim()]);
    expect(a.redisUrl).not.toBe(b.redisUrl);
  });

  it("the heartbeat keeps a claim alive far past its TTL (AC1)", async () => {
    const c = await claim({ ttlMs: 600, heartbeatMs: 100 });
    await sleep(2_000);
    expect(await admin.get(`${KEY_PREFIX}${c.db}`)).toBe(c.descriptor?.token);
    expect(c.lost()).toBe(false);
  });

  it("cleanup stops the heartbeat and releases (CAS DEL); a later claim reuses the DB", async () => {
    const c = await claim({ ttlMs: 600, heartbeatMs: 100, minDb: 1, maxDb: 1 });
    await c.cleanup();
    await sleep(400);
    expect(await ownKeys()).toEqual([]);
    const again = await claim({ minDb: 1, maxDb: 1 });
    expect(again.db).toBe(1);
  });

  it("a renewal never touches a foreign token and reports the loss once (CAS, AC1)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const c = await claim({ ttlMs: 400, heartbeatMs: 80 });
      const key = `${KEY_PREFIX}${c.db}`;
      await admin.set(key, "someone-else", "PX", 400, "XX");
      await sleep(900);
      // Not extended by us (a bare PEXPIRE would have kept it alive) and not overwritten.
      expect(await admin.get(key)).toBeNull();
      expect(c.lost()).toBe(true);
      const lostLines = err.mock.calls.filter((a) => String(a[0]).includes("claim lost"));
      expect(lostLines).toHaveLength(1);
    } finally {
      err.mockRestore();
    }
  });

  it("never releases a DB another run claimed after this run's lock lapsed (CAS, not a bare DEL)", async () => {
    const c = await claim();
    const key = `${KEY_PREFIX}${c.db}`;
    await admin.set(key, "another-run", "PX", 60_000, "XX");
    await c.cleanup();
    expect(await admin.get(key)).toBe("another-run");
  });

  it("fails with a clear message when every DB is claimed by a live run", async () => {
    for (let db = 1; db <= 3; db++) {
      await admin.set(`${KEY_PREFIX}${db}`, `${process.pid}:${randomUUID()}`, "PX", 60_000, "NX");
    }
    await expect(claim()).rejects.toThrow(/every test Redis DB \(1-3\) is already claimed/);
  });
});

describe("claimTestRedisDb: reap of dead PIDs (AC3)", () => {
  async function fillWith(token: (db: number) => string) {
    for (let db = 1; db <= 3; db++) {
      await admin.set(`${KEY_PREFIX}${db}`, token(db), "PX", 60_000);
    }
  }

  it("takes over a claim whose PID is dead, and never one whose PID is alive", async () => {
    const dead = `${await deadPid()}:${randomUUID()}`;
    await fillWith((db) => (db === 2 ? dead : `${process.pid}:${randomUUID()}`));
    const c = await claim();
    expect(c.db).toBe(2);
    expect(await admin.get(`${KEY_PREFIX}2`)).toBe(c.descriptor?.token);

    // All live now: nothing may be taken, the live holders keep their tokens.
    const before = await Promise.all([1, 2, 3].map((d) => admin.get(`${KEY_PREFIX}${d}`)));
    await expect(claim()).rejects.toThrow(/already claimed/);
    const after = await Promise.all([1, 2, 3].map((d) => admin.get(`${KEY_PREFIX}${d}`)));
    expect(after).toEqual(before);
  });

  it("does not take over a malformed token, even with a dead-looking PID", async () => {
    await fillWith(() => `${2 ** 22 + 12345}:not-a-uuid`);
    await expect(claim()).rejects.toThrow(/already claimed/);
  });

  it("does not take over from a non-loopback host", async () => {
    const dead = `${await deadPid()}:${randomUUID()}`;
    await fillWith(() => dead);
    await expect(claim({ baseUrl: NON_LOOPBACK_URL })).rejects.toThrow(/already claimed/);
    expect(await admin.get(`${KEY_PREFIX}1`)).toBe(dead);
    expect(isLoopbackHost("localhost") && isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
  });

  it("two reapers racing for one dead claim: exactly one wins", async () => {
    const dead = `${await deadPid()}:${randomUUID()}`;
    await admin.set(`${KEY_PREFIX}1`, dead, "PX", 60_000);
    const results = await Promise.allSettled([
      claim({ minDb: 1, maxDb: 1 }),
      claim({ minDb: 1, maxDb: 1 }),
      claim({ minDb: 1, maxDb: 1 }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(2);
  });
});

describe("claimTestRedisDb: separate processes (AC4)", () => {
  it("distinct DBs; a SIGKILLed claimer frees its DB by TTL alone; survivors keep theirs; a fourth gets the freed DB", async () => {
    const a = spawnClaimer({});
    const ca = await a.claimed;
    const b = spawnClaimer({});
    const cb = await b.claimed;
    const c = spawnClaimer({});
    const cc = await c.claimed;
    expect(new Set([ca.db, cb.db, cc.db]).size).toBe(3);

    a.child.kill("SIGKILL");
    await a.exit;
    const freedKey = `${KEY_PREFIX}${ca.db}`;
    const killedAt = Date.now();
    // Claimers use a non-loopback host, so nothing can reap: only the TTL (1.5 s) can free it.
    while ((await admin.get(freedKey)) !== null) {
      if (Date.now() - killedAt > 4_000) throw new Error("dead claimer's DB was not freed in time");
      await sleep(100);
    }
    expect(Date.now() - killedAt).toBeLessThan(3_500);

    // Several TTLs later the survivors still hold their original tokens (heartbeat).
    await sleep(4_000);
    expect(await admin.get(`${KEY_PREFIX}${cb.db}`)).toBe(cb.token);
    expect(await admin.get(`${KEY_PREFIX}${cc.db}`)).toBe(cc.token);

    const d = spawnClaimer({});
    const cd = await d.claimed;
    expect(cd.db).toBe(ca.db);
    for (const k of [b, c, d]) k.child.stdin?.write("release\n");
    await Promise.all([b.exit, c.exit, d.exit]);
    expect(await ownKeys()).toEqual([]);
  }, 25_000);

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    it(`${signal} releases the claim before the process exits, re-raising the signal`, async () => {
      // This child installs the real handlers (signals default on); loopback host is irrelevant.
      const k = spawnClaimer({});
      const claimed = await k.claimed;
      expect(await admin.get(`${KEY_PREFIX}${claimed.db}`)).toBe(claimed.token);
      k.child.kill(signal);
      const res = await k.exit;
      expect(res.signal).toBe(signal);
      expect(await admin.get(`${KEY_PREFIX}${claimed.db}`)).toBeNull();
    }, 15_000);
  }
});

describe("scoped clean-up (AC5)", () => {
  const good: ClaimDescriptor = {
    baseUrl: BASE_URL,
    db: 3,
    registryDb: 15,
    key: "k",
    token: "t",
    pinned: false,
  };

  it("refuses DB 0, 9-15, out-of-range, a pinned run, no claim and a non-loopback host", () => {
    expect(planClaimedDbCleanup(good)).toEqual({ host: HOST, db: 3 });
    for (const db of [0, 9, 10, 11, 12, 13, 14, 15, 16, -1, 1.5]) {
      expect(() => planClaimedDbCleanup({ ...good, db }), `DB ${db}`).toThrow(/clean-up refused/);
    }
    for (const db of [1, 8]) expect(planClaimedDbCleanup({ ...good, db }).db).toBe(db);
    expect(() => planClaimedDbCleanup({ ...good, pinned: true })).toThrow(/pinned/);
    expect(() => planClaimedDbCleanup(undefined)).toThrow(/no claim/);
    expect(() => planClaimedDbCleanup({ ...good, baseUrl: "redis://example.com:6379" })).toThrow(
      /loopback/,
    );
  });

  it("a pinned claim has no descriptor, so it can never be cleaned", async () => {
    const pinned = await claim({ pinnedUrl: url(12) });
    await expect(cleanClaimedDbLeftovers(pinned.descriptor)).rejects.toThrow(/clean-up refused/);
  });

  it("proves its target first: a dead endpoint is reached, fails, and deletes nothing", async () => {
    const dead: ClaimDescriptor = { ...good, baseUrl: "redis://127.0.0.1:1" };
    expect(planClaimedDbCleanup(dead)).toEqual({ host: "127.0.0.1:1", db: 3 });
    await expect(cleanClaimedDbLeftovers(dead)).rejects.toThrow();
  });

  it("empties only the DB it holds the claim on, and only when the registry still holds its token", async () => {
    // A real claim from the real registry (the same call global-setup makes): this run then owns
    // that DB, so emptying it cannot hurt anybody.
    const mine = await claimTestRedisDb({
      baseUrl: BASE_URL,
      reapWaitMs: 20_000,
      signals: false,
    });
    open.push(mine);
    const db = mine.db as number;
    expect(db).toBeGreaterThanOrEqual(1);
    expect(db).toBeLessThanOrEqual(8);
    const claimed = new Redis(url(db), { maxRetriesPerRequest: 1 });
    const app0 = new Redis(url(0), { maxRetriesPerRequest: 1 });
    try {
      const planted = Array.from({ length: 25 }, (_, i) => `leftover:${randomUUID()}:${i}`);
      for (const k of planted) await claimed.set(k, "x");
      await claimed.hset("leftover:hash", "a", "1");
      await admin.set(`${KEY_PREFIX}probe`, "keep"); // a key in the run's own DB (other DB)
      const dbsize0 = await app0.dbsize();

      // Registry token mismatch: refused, nothing removed.
      const wrongToken = { ...(mine.descriptor as ClaimDescriptor), token: "not-mine" };
      await expect(cleanClaimedDbLeftovers(wrongToken)).rejects.toThrow(/does not hold/);
      const total = await claimed.dbsize(); // 26 planted plus any stale keys of earlier runs
      expect(total).toBeGreaterThanOrEqual(26);

      const removed = await cleanClaimedDbLeftovers(mine.descriptor);
      expect(removed).toBe(total);
      expect(await claimed.dbsize()).toBe(0);
      expect(await admin.get(`${KEY_PREFIX}probe`)).toBe("keep");
      expect(await app0.dbsize()).toBe(dbsize0);
    } finally {
      // nothing left to clean: the clean-up emptied the DB this run claimed
      claimed.disconnect();
      app0.disconnect();
    }
  });

  it("the source never uses KEYS, FLUSHALL or FLUSHDB", () => {
    const src = readFileSync("src/test/test-redis.ts", "utf8");
    expect(src).not.toMatch(/\.keys\(|flushall|flushdb|"keys"|'keys'/i);
  });
});
