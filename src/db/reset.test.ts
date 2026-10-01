import { Queue } from "bullmq";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { QUEUE_NAMES, redis } from "../lib/queues";
import { assertSafeToReset, obliterateQueues } from "./reset";

/*
 * T-20-5 (wave 19 gate issue 6): `pnpm db:reset` empties the app's own BullMQ queues in the
 * configured Redis DB, and nothing else: a same-DB rate-limit counter and a realtime stream
 * survive. The test runs the same code over a prefix of its own (`bull-t20-5`), so the real
 * `bull:*` queues a dev worker may be using in this Redis DB are never touched.
 */

const PREFIX = "bull-t20-5-test";
const OTHER_PREFIX = "bull-t20-5-other";
const SENTINEL = "rl:t20-5:sentinel";
const STREAM = "rt:company:t20-5-test";

const own = Object.fromEntries(
  QUEUE_NAMES.map((name) => [name, new Queue(name, { connection: redis, prefix: PREFIX })]),
) as Record<(typeof QUEUE_NAMES)[number], Queue>;
// A same-named queue under another prefix stands in for the real `bull:*` queues.
const other = new Queue("ship", { connection: redis, prefix: OTHER_PREFIX });

async function scanCount(pattern: string): Promise<number> {
  let cursor = "0";
  let n = 0;
  do {
    const [next, keys] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 500);
    cursor = next;
    n += keys.length;
  } while (cursor !== "0");
  return n;
}

beforeAll(async () => {
  for (const q of [...Object.values(own), other]) await q.obliterate({ force: true });
});

afterAll(async () => {
  for (const q of [...Object.values(own), other]) {
    await q.obliterate({ force: true });
    await q.close();
  }
  await redis.del(SENTINEL, STREAM);
});

describe("obliterateQueues", () => {
  it("removes every job of every app queue and leaves other keys alone", async () => {
    for (const name of QUEUE_NAMES) {
      await own[name].add("t20-5.dummy", { companyId: "none" }, { jobId: `t20-5-${name}` });
      await own[name].add("t20-5.dummy", { companyId: "none" }, { delay: 60_000 });
    }
    await redis.set(SENTINEL, "1", "EX", 600);
    await redis.xadd(STREAM, "*", "name", "t20-5");
    await other.add("t20-5.dummy", { companyId: "none" }, { delay: 60_000 });
    expect(await scanCount(`${PREFIX}:*`)).toBeGreaterThan(0);

    const removed = await obliterateQueues({ prefix: PREFIX });

    for (const name of QUEUE_NAMES) {
      expect(removed[name]).toBeGreaterThanOrEqual(2);
      expect(await scanCount(`${PREFIX}:${name}:*`)).toBe(0);
      expect(
        await own[name].getJobCountByTypes("waiting", "delayed", "active", "completed", "failed"),
      ).toBe(0);
    }
    expect(await redis.get(SENTINEL)).toBe("1");
    expect(await redis.xlen(STREAM)).toBe(1);
    expect(await other.getJobCountByTypes("delayed")).toBe(1);
  });

  it("refuses to run in production", async () => {
    const before = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      await expect(obliterateQueues({ prefix: PREFIX })).rejects.toThrow(/not for production/);
    } finally {
      process.env.NODE_ENV = before;
    }
  });
});

/*
 * T-P6-1 (B-219): a reset of any database other than the shared `invai` must refuse unless
 * REDIS_URL already pins a non-zero DB, so a scratch-DB reset can never obliterate the shared
 * dev/CI queues in Redis DB 0 again (incidents 2026-09-29 T-23-9, 2026-10-01 T-P5-1). `invai`
 * itself must stay reset-able with any REDIS_URL, including the default (no path = DB 0), so the
 * gate (`invai-infra/scripts/gate.sh:108`) and CI keep working unchanged.
 */
describe("assertSafeToReset", () => {
  const DB_URL = (name: string) => `postgres://invai:invai@localhost:5432/${name}`;

  it("allows the shared invai database with the default (DB 0) Redis URL", () => {
    expect(() => assertSafeToReset(DB_URL("invai"), "redis://localhost:6379")).not.toThrow();
  });

  it("allows the shared invai database with any pinned Redis DB too", () => {
    expect(() => assertSafeToReset(DB_URL("invai"), "redis://localhost:6379/7")).not.toThrow();
  });

  it("refuses another database on the default (DB 0) Redis URL", () => {
    expect(() => assertSafeToReset(DB_URL("invai_p6_reset"), "redis://localhost:6379")).toThrow(
      /refusing: resetting invai_p6_reset would wipe the queues in the shared Redis DB 0/,
    );
  });

  it("refuses another database when REDIS_URL's DB is written as 0 explicitly", () => {
    expect(() => assertSafeToReset(DB_URL("invai_p6_reset"), "redis://localhost:6379/0")).toThrow(
      /shared Redis DB 0/,
    );
  });

  it("refuses another database when REDIS_URL's DB is not a plain positive integer", () => {
    for (const bad of ["redis://localhost:6379/0/", "redis://localhost:6379/0x1"]) {
      expect(() => assertSafeToReset(DB_URL("invai_p6_reset"), bad)).toThrow(/shared Redis DB 0/);
    }
  });

  it("allows another database with an explicit non-zero Redis DB index", () => {
    expect(() =>
      assertSafeToReset(DB_URL("invai_p6_reset"), "redis://localhost:6379/13"),
    ).not.toThrow();
  });
});
