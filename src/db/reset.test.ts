import { afterAll, describe, expect, it } from "vitest";
import { QUEUE_NAMES, queues, redis } from "../lib/queues";
import { obliterateQueues } from "./reset";

/*
 * T-20-5 (wave 19 gate issue 6): `pnpm db:reset` empties the app's own BullMQ queues in the
 * configured Redis DB, and nothing else: a same-DB rate-limit counter and a realtime stream
 * survive. Runs on this file's Redis DB (REDIS_URL), which every queue test already shares.
 */

const SENTINEL = "rl:t20-5:sentinel";
const STREAM = "rt:company:t20-5-test";

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

afterAll(async () => {
  await redis.del(SENTINEL, STREAM);
});

describe("obliterateQueues", () => {
  it("removes every job of every app queue and leaves other keys alone", async () => {
    for (const name of QUEUE_NAMES) {
      await queues[name].add("t20-5.dummy", { companyId: "none" }, { jobId: `t20-5-${name}` });
      await queues[name].add("t20-5.dummy", { companyId: "none" }, { delay: 60_000 });
    }
    await redis.set(SENTINEL, "1", "EX", 600);
    await redis.xadd(STREAM, "*", "name", "t20-5");
    expect(await scanCount("bull:*")).toBeGreaterThan(0);

    const removed = await obliterateQueues();

    for (const name of QUEUE_NAMES) {
      expect(removed[name]).toBeGreaterThanOrEqual(2);
      expect(await scanCount(`bull:${name}:*`)).toBe(0);
      expect(
        await queues[name].getJobCountByTypes(
          "waiting",
          "delayed",
          "active",
          "completed",
          "failed",
        ),
      ).toBe(0);
    }
    expect(await redis.get(SENTINEL)).toBe("1");
    expect(await redis.xlen(STREAM)).toBe(1);
  });

  it("refuses to run in production", async () => {
    const before = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      await expect(obliterateQueues()).rejects.toThrow(/not for production/);
    } finally {
      process.env.NODE_ENV = before;
    }
  });
});
