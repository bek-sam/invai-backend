import { Queue } from "bullmq";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { QUEUE_NAMES, redis } from "../lib/queues";
import { obliterateQueues } from "./reset";

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
