import { DelayedError, Worker } from "bullmq";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystem, withTenant } from "../../db/client";
import { orderItems } from "../../db/schema";
import { queues, redis } from "../../lib/queues";
import { createCompany, createConnection, createOrder, tenantContext } from "../../test/fixtures";
import { type QaStub, startQaStub } from "../catalog/qa-stub.testutil";
import { QA_WAIT_LIMIT_MS } from "../catalog/qa-turn";
import { enqueueItemArtworkQa, itemArtworkQaJob } from "./jobs";
import { setItemArtwork } from "./service";

/*
 * T-43-3 round 2: the artwork QA follow-up under imaging outages, the A13 locked re-check, and
 * re-queueing after a give-up. Imaging is an in-process stub.
 */
const where = vi.hoisted(() => ({ url: "" }));
vi.mock("../../integrations/imaging/client", async (orig) => {
  const actual = await orig<typeof import("../../integrations/imaging/client")>();
  let c: ReturnType<typeof actual.createImagingClient> | undefined;
  const get = () => {
    c ??= actual.createImagingClient(where.url);
    return c;
  };
  return {
    ...actual,
    imaging: {
      ...actual.imaging,
      isUp: () => get().isUp(),
      qaCheck: (...a: Parameters<typeof actual.imaging.qaCheck>) => get().qaCheck(...a),
    },
  };
});

import { ImagingError, imaging } from "../../integrations/imaging/client";

let stub: QaStub;
let companyId: string;

beforeAll(async () => {
  stub = await startQaStub();
  where.url = stub.url;
  stub.delayMs = 5;
  stub.issues = [
    {
      when: "lowdpi",
      list: [{ code: "low_dpi", severity: "warn", message: "Only 90 dpi at this size" }],
    },
  ];
  companyId = (await createCompany()).id;
});
afterAll(async () => {
  await stub.close();
});
beforeEach(async () => {
  vi.restoreAllMocks();
  await redis.del(
    `qa:rate:artwork:${companyId}`,
    `qa:rate:design:${companyId}`,
    `qa:lease:${companyId}`,
  );
});

async function itemWithArtwork(name: string) {
  const conn = await createConnection(companyId);
  const { items } = await createOrder(companyId, conn.id);
  const id = items[0]?.id as string;
  // Attach while the slot is busy so the item carries the artwork and no flags yet.
  stub.hold(200);
  vi.spyOn(itemArtworkQaJob, "enqueue").mockResolvedValue(undefined as never);
  await withTenant(companyId, (tx) =>
    setItemArtwork(tx, tenantContext(companyId, null, "office"), {
      id,
      fileKey: `${companyId}/art/${name}.png`,
    }),
  );
  vi.restoreAllMocks();
  await new Promise((r) => setTimeout(r, 250));
  return { id, fileKey: `${companyId}/art/${name}.png` };
}
const row = async (id: string) =>
  withTenant(
    companyId,
    async (tx) => (await tx.select().from(orderItems).where(eq(orderItems.id, id)))[0],
  );
const fakeJob = (timestamp = Date.now()) => {
  const moveToDelayed = vi.fn();
  return {
    moveToDelayed,
    job: { timestamp, token: "t", moveToDelayed } as never,
  };
};

describe("A13: the flags are written only if the key still matches under the row lock", () => {
  it("the key changes while the imaging call is in flight: no flags are applied", async () => {
    const { id, fileKey } = await itemWithArtwork("lowdpi-a13");
    const real = imaging.qaCheck;
    vi.spyOn(imaging, "qaCheck").mockImplementationOnce(async (...a) => {
      const res = await real(...a);
      // Someone attaches another file after the job's first read and before its write.
      await withSystem((tx) =>
        tx
          .update(orderItems)
          .set({ artworkKey: `${companyId}/art/replaced.png` })
          .where(eq(orderItems.id, id)),
      );
      return res;
    });
    const { job } = fakeJob();
    const out = await itemArtworkQaJob.handler({ companyId, itemId: id, fileKey }, job);
    expect(out).toEqual({ skipped: true });
    expect((await row(id))?.flags.map((f) => f.code)).toEqual([]);
  });
});

describe("imaging down or unreachable: the follow-up waits, bounded, and never fails (B-399)", () => {
  it("health check down: re-delays itself (no throw to BullMQ's attempts)", async () => {
    const { id, fileKey } = await itemWithArtwork("lowdpi-down");
    vi.spyOn(imaging, "isUp").mockResolvedValue(false);
    const { job, moveToDelayed } = fakeJob();
    await expect(
      itemArtworkQaJob.handler({ companyId, itemId: id, fileKey }, job),
    ).rejects.toBeInstanceOf(DelayedError);
    expect(moveToDelayed).toHaveBeenCalledTimes(1);
    // 30 s retry plus up to 1 s jitter
    const at = moveToDelayed.mock.calls[0]?.[0] as number;
    expect(at - Date.now()).toBeGreaterThan(25_000);
    expect(at - Date.now()).toBeLessThanOrEqual(31_100);
  });

  it("imaging dies between the health check and the call: re-delays too", async () => {
    const { id, fileKey } = await itemWithArtwork("lowdpi-mid");
    vi.spyOn(imaging, "qaCheck").mockRejectedValueOnce(
      new ImagingError("/qa/check", 0, "connection refused"),
    );
    const { job, moveToDelayed } = fakeJob();
    await expect(
      itemArtworkQaJob.handler({ companyId, itemId: id, fileKey }, job),
    ).rejects.toBeInstanceOf(DelayedError);
    expect(moveToDelayed).toHaveBeenCalledTimes(1);
  });

  it("past the 30-minute bound it gives up quietly: completes, flags unchanged", async () => {
    const { id, fileKey } = await itemWithArtwork("lowdpi-bound");
    vi.spyOn(imaging, "isUp").mockResolvedValue(false);
    const { job, moveToDelayed } = fakeJob(Date.now() - QA_WAIT_LIMIT_MS - 1_000);
    expect(await itemArtworkQaJob.handler({ companyId, itemId: id, fileKey }, job)).toEqual({
      gaveUp: true,
    });
    expect(moveToDelayed).not.toHaveBeenCalled();
    expect((await row(id))?.flags.map((f) => f.code)).toEqual([]);
  });

  it("when imaging is back the same job applies the flags once (run twice = one flag)", async () => {
    const { id, fileKey } = await itemWithArtwork("lowdpi-back");
    const { job } = fakeJob();
    await itemArtworkQaJob.handler({ companyId, itemId: id, fileKey }, job);
    await itemArtworkQaJob.handler({ companyId, itemId: id, fileKey }, job);
    expect((await row(id))?.flags.map((f) => f.code)).toEqual(["artwork_low_dpi"]);
  });
});

describe("a finished (given-up) follow-up does not block queueing the same file again", () => {
  it("enqueueItemArtworkQa replaces a completed job with the same id", async () => {
    const { id, fileKey } = await itemWithArtwork("lowdpi-requeue");
    const input = { companyId, itemId: id, fileKey };
    // Simulate the give-up: the job is picked up and completes without checking anything.
    const first = await itemArtworkQaJob.enqueue(input);
    const worker = new Worker(queues.render.name, async () => ({ gaveUp: true }), {
      connection: redis,
      concurrency: 1,
    });
    try {
      const t0 = Date.now();
      while ((await first.getState()) !== "completed" && Date.now() - t0 < 5_000)
        await new Promise((r) => setTimeout(r, 50));
      expect(await first.getState()).toBe("completed");
    } finally {
      await worker.close();
    }
    // A plain enqueue is a no-op on a kept id; the helper queues a fresh job.
    const noop = await itemArtworkQaJob.enqueue(input);
    expect(await noop.getState()).toBe("completed");
    const again = await enqueueItemArtworkQa(input);
    // Follow-ups carry BULK_PRIORITY (T-43-3 r3), and BullMQ reports a prioritized job as such.
    expect(await again.getState()).toBe("prioritized");
    expect(again.opts.priority).toBe(10);
    await again.remove();
  });
});
