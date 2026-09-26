import { Worker } from "bullmq";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { withSystem, withTenant } from "../db/client";
import { alerts, outboxEvents } from "../db/schema";
import { defineJob, onEvent, queues, redis, safeJobId } from "../lib/queues";
import { createCompany } from "../test/fixtures";
import {
  alertParkedOutbox,
  MAX_ATTEMPTS,
  purgeDispatchedOutbox,
  redriveParkedOutbox,
  relayOnce,
} from "./outbox-relay";

/*
 * T-12-1: the relay keeps a subscriber's own jobId (T-3-4 review), dispatched rows are purged
 * after 7 days in batches, and a parked event raises one `outbox_parked` alert, not one per tick.
 */

let companyId: string;
const queue = queues.sync;

const scrapLikeJob = defineJob({
  queue: "sync",
  name: "test.t121.scrapLike",
  input: z.object({ companyId: z.uuid(), orderId: z.uuid(), transferIds: z.array(z.uuid()) }),
  jobId: (i) => `scrap-like:${i.orderId}:${[...i.transferIds].sort().join(",")}`,
  handler: async () => "ok",
});
const plainJob = defineJob({
  queue: "sync",
  name: "test.t121.plain",
  input: z.object({ companyId: z.uuid() }),
  handler: async () => "ok",
});
const toInput = (e: { companyId: string; payload: Record<string, unknown> }) => ({
  companyId: e.companyId,
  orderId: String(e.payload.orderId),
  transferIds: e.payload.transferIds as string[],
});
onEvent("test.t121.cancelled", scrapLikeJob, toInput);
onEvent("test.t121.rescrapped", scrapLikeJob, toInput);
onEvent("test.t121.plain", plainJob, (e) => ({ companyId: e.companyId }));

async function event(name: string, payload: Record<string, unknown>) {
  const [row] = await withSystem((tx) =>
    tx.insert(outboxEvents).values({ companyId, name, payload }).returning(),
  );
  return row as typeof outboxEvents.$inferSelect;
}

beforeAll(async () => {
  companyId = (await createCompany()).id;
  await queue.obliterate({ force: true });
});
beforeEach(async () => {
  // Only this file's events are relayed.
  await withSystem((tx) =>
    tx
      .update(outboxEvents)
      .set({ dispatchedAt: new Date() })
      .where(isNull(outboxEvents.dispatchedAt)),
  );
});
afterAll(async () => {
  await queue.obliterate({ force: true });
});

describe("relay job ids", () => {
  it("two events with the same payload enqueue one job under the subscriber's own id", async () => {
    const orderId = crypto.randomUUID();
    const transferIds = [crypto.randomUUID(), crypto.randomUUID()];
    const a = await event("test.t121.cancelled", { orderId, transferIds });
    const b = await event("test.t121.rescrapped", {
      orderId,
      transferIds: [...transferIds].reverse(),
    });
    expect(await relayOnce()).toBe(2);

    const expectedId = safeJobId(`scrap-like:${orderId}:${[...transferIds].sort().join(",")}`);
    const job = await queue.getJob(expectedId);
    expect(job?.name).toBe(scrapLikeJob.name);
    expect(await queue.getJob(safeJobId(`${a.id}:${scrapLikeJob.name}`))).toBeUndefined();
    expect(await queue.getJob(safeJobId(`${b.id}:${scrapLikeJob.name}`))).toBeUndefined();
    const waiting = (await queue.getJobs(["waiting", "prioritized"])).filter(
      (j) => j.name === scrapLikeJob.name,
    );
    expect(waiting).toHaveLength(1);
  });

  it("once that job finished, a later event still runs (event-scoped id)", async () => {
    const orderId = crypto.randomUUID();
    const transferIds = [crypto.randomUUID()];
    await event("test.t121.cancelled", { orderId, transferIds });
    await relayOnce();
    const ownId = safeJobId(`scrap-like:${orderId}:${transferIds[0]}`);
    const worker = new Worker(
      "sync",
      async (j) => {
        if (j.name !== scrapLikeJob.name) throw new Error("not this test's job");
        return "ok";
      },
      { connection: redis },
    );
    try {
      const until = Date.now() + 10_000;
      while ((await (await queue.getJob(ownId))?.getState()) !== "completed") {
        if (Date.now() > until) throw new Error("job did not complete");
        await new Promise((r) => setTimeout(r, 50));
      }
    } finally {
      await worker.close();
    }
    const later = await event("test.t121.rescrapped", { orderId, transferIds });
    await relayOnce();
    expect(await queue.getJob(safeJobId(`${later.id}:${scrapLikeJob.name}`))).toBeDefined();
  });

  it("a subscriber without its own id keeps the event-scoped id, so a re-relay is deduped", async () => {
    const e = await event("test.t121.plain", {});
    await relayOnce();
    const id = safeJobId(`${e.id}:${plainJob.name}`);
    expect(await queue.getJob(id)).toBeDefined();
    // Crash before marking dispatched, then relay again: still one job.
    await withSystem((tx) =>
      tx.update(outboxEvents).set({ dispatchedAt: null }).where(eq(outboxEvents.id, e.id)),
    );
    await relayOnce();
    const plain = (await queue.getJobs(["waiting", "prioritized"])).filter(
      (j) => j.name === plainJob.name && j.id === id,
    );
    expect(plain).toHaveLength(1);
  });
});

describe("outbox purge and parked events", () => {
  async function aged(days: number, patch: Partial<typeof outboxEvents.$inferInsert> = {}) {
    const [row] = await withSystem((tx) =>
      tx
        .insert(outboxEvents)
        .values({
          companyId,
          name: "test.t121.old",
          payload: {},
          dispatchedAt: new Date(Date.now() - days * 86_400_000),
          attempts: 1,
          ...patch,
        })
        .returning({ id: outboxEvents.id }),
    );
    return row?.id as string;
  }
  const exists = async (ids: string[]) =>
    (
      await withSystem((tx) =>
        tx.select({ id: outboxEvents.id }).from(outboxEvents).where(inArray(outboxEvents.id, ids)),
      )
    ).map((r) => r.id);

  it("deletes dispatched rows older than 7 days in batches, keeps recent and parked rows", async () => {
    const old = [await aged(8), await aged(9), await aged(10), await aged(30)];
    const recent = await aged(2);
    const pending = (await event("test.t121.none", {})).id;
    const parkedOld = await aged(20, { attempts: MAX_ATTEMPTS, lastError: "boom" });
    const res = await purgeDispatchedOutbox({ batch: 2 });
    expect(res.deleted).toBeGreaterThanOrEqual(4);
    expect(await exists(old)).toEqual([]);
    expect((await exists([recent, pending, parkedOld])).sort()).toEqual(
      [recent, pending, parkedOld].sort(),
    );
  });

  it("a parked row raises exactly one outbox_parked alert across two sweeps", async () => {
    const id = await aged(0, { attempts: MAX_ATTEMPTS, lastError: "Error: redis down" });
    await alertParkedOutbox();
    await alertParkedOutbox();
    const rows = await withTenant(companyId, (tx) =>
      tx
        .select()
        .from(alerts)
        .where(and(eq(alerts.kind, "outbox_parked"), eq(alerts.dedupeKey, `outbox_parked:${id}`))),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ severity: "critical", entityType: null });

    // Resolved by a person: the next sweep doesn't reopen it.
    await withSystem((tx) =>
      tx
        .update(alerts)
        .set({ status: "resolved", resolvedAt: new Date() })
        .where(eq(alerts.id, rows[0]?.id as string)),
    );
    await alertParkedOutbox();
    const [after] = await withTenant(companyId, (tx) =>
      tx
        .select()
        .from(alerts)
        .where(eq(alerts.id, rows[0]?.id as string)),
    );
    expect(after?.status).toBe("resolved");
  });

  it("redrive puts parked rows back in the relay", async () => {
    const id = await aged(0, { attempts: MAX_ATTEMPTS, lastError: "boom" });
    const res = await redriveParkedOutbox();
    expect(res.reset).toBeGreaterThanOrEqual(1);
    const [row] = await withSystem((tx) =>
      tx.select().from(outboxEvents).where(eq(outboxEvents.id, id)),
    );
    expect(row).toMatchObject({ dispatchedAt: null, attempts: 0 });
    await withSystem((tx) =>
      tx.execute(sql`update outbox_events set dispatched_at = now() where id = ${id}`),
    );
  });
});
