import { call } from "@orpc/server";
import { DelayedError, type Job, Queue, Worker } from "bullmq";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { anonymousContext, permissionsFor } from "../../api/context";
import { router } from "../../api/router";
import { withTenant } from "../../db/client";
import { designFiles } from "../../db/schema";
import { ImagingError } from "../../integrations/imaging/client";
import { redis } from "../../lib/queues";
import {
  createCompany,
  createConnection,
  createOrder,
  createUser,
  tenantContext,
} from "../../test/fixtures";
import { itemArtworkQaJob } from "../orders/jobs";
import { setItemArtwork } from "../orders/service";
import { runDesignQaJob } from "./jobs";
import { type QaStub, startQaStub } from "./qa-stub.testutil";
import {
  QA_BURST,
  QA_COOLDOWN_MS,
  QA_IN_FLIGHT_RETRY_MS,
  QA_MANUAL_BUSY,
  QA_REDELAY_FLOOR_MS,
  QA_REFILL_MS,
  qaTimingNow,
  scaleQaTiming,
  setQaCooldown,
  takeQaTurn,
} from "./qa-turn";
import * as svc from "./service";

/*
 * T-43-3 (S-76 / B-399): one shop looping print-file QA can't starve another shop's QA.
 * Imaging is an in-process stub (one global slot, 429 + Retry-After). Valkey is the harness-claimed DB (src/test), bucket invai-test.
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
      cleanAlpha: (...a: Parameters<typeof actual.imaging.cleanAlpha>) => get().cleanAlpha(...a),
    },
  };
});

// Captured at import, before beforeAll switches the cooldown off: the module's live values.
const LIVE_TIMING = qaTimingNow();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let stub: QaStub;
let n = 0;

type Shop = { id: string; userId: string };
async function shop(): Promise<Shop> {
  const id = (await createCompany()).id;
  return { id, userId: (await createUser(id, "designer")).id };
}
const rctx = (s: Shop) => ({
  ...anonymousContext(new Headers(), null),
  sessionKind: "user" as const,
  user: { id: s.userId, name: "Tester", email: "x@test.local" },
  companyId: s.id,
  orgType: "shop" as const,
  role: "owner" as const,
  permissions: permissionsFor("owner"),
});
const ALL_PLACEMENTS = ["front", "back", "left_chest", "sleeve_left", "sleeve_right"] as const;
async function design(s: Shop, count = 1) {
  n++;
  return withTenant(s.id, (tx) =>
    svc.createDesign(tx, tenantContext(s.id, s.userId, "designer"), {
      code: `QF${n}-${Math.random().toString(36).slice(2, 6)}`,
      name: `QF ${n}`,
      tags: [],
      placements: ALL_PLACEMENTS.slice(0, count).map((placement) => ({
        placement,
        fileKey: `${s.id}/design/qf-${n}-${placement}.png`,
        widthIn: 10,
        heightIn: 10,
      })),
      personalizationTemplateId: null,
    }),
  );
}
const runQa = (s: Shop, id: string) => call(router.designs.runQa, { id }, { context: rctx(s) });
const qaStatusOf = async (s: Shop, id: string) =>
  (await withTenant(s.id, (tx) => svc.getDesign(tx, tenantContext(s.id, s.userId, "designer"), id)))
    .qaStatus;

function stubJob(over: Partial<Job> = {}) {
  const delays: number[] = [];
  const job = {
    timestamp: Date.now(),
    token: "tok",
    moveToDelayed: vi.fn(async (ts: number) => {
      delays.push(ts);
    }),
    ...over,
  } as unknown as Job;
  return { job, delays };
}

beforeAll(async () => {
  stub = await startQaStub();
  where.url = stub.url;
  setQaCooldown(0); // S-81: only the crit-1 / S-81 cases run with the cooldown on
});
afterAll(async () => {
  await stub.close();
});

describe("criterion 1: a looping shop A does not starve shop B", () => {
  it("B's job and B's manual QA finish; A is the one refused", () => crit1(1, 300, 1), 120_000);

  // S-79: the allowance is charged per /qa/check call, so a 5-placement loop can't hold the slot
  // longer than the refill. Wave 42's worst QA (4.3 s) and imaging's default Retry-After (5 s).
  // Run at 1/5 of the wall-clock time (stub delay, Retry-After, refill and in-flight hint all
  // scaled together) so the unchanged 30 s / 60 s bounds have real room instead of ~0.7 s.
  it(
    "same with A looping a 5-placement design at 4.3 s a call",
    () => crit1(5, 860, 1, 0.2),
    150_000,
  );
});

async function crit1(
  aPlacements: number,
  delayMs: number,
  retryAfterSec: number,
  scale = 1,
  artworkLoop = false,
) {
  // Real timing keeps the product lines 30 s / 60 s. The S-81 case runs scaled by f, and then
  // asserts B = f x 30 s + S81_SLACK_MS (job: f x 60 s + S81_SLACK_MS), see S81_SLACK_MS.
  const scaledBounds = artworkLoop && scale < 1;
  const manualBound = scaledBounds ? 30_000 * scale + S81_SLACK_MS : 30_000; // the test's give-up
  // T-46-3: the victim's result must also leave 2 s of the 30 s line free (headroom), scaled.
  const resultBound = scaledBounds ? 28_000 * scale + S81_SLACK_MS : 30_000;
  // Why the headroom is there: the victim is served at the next free slot, about one Retry-After
  // plus its own call (~11 s at real timing), not after the attacker's 5-call turn (30 s). Without
  // the yield this case measures 15 s at scale 0.5 (30 s real), which the 28 s line alone lets by.
  const yieldBound = scaledBounds ? 15_000 * scale + S81_SLACK_MS : 30_000;
  const jobBound = scaledBounds ? 60_000 * scale + S81_SLACK_MS : 60_000;
  const enqueue = vi.spyOn(itemArtworkQaJob, "enqueue").mockResolvedValue(undefined as never);
  try {
    scaleQaTiming(scale);
    stub.delayMs = delayMs;
    stub.retryAfterSec = retryAfterSec;
    const a = await shop();
    const b = await shop();
    const aDesign = await design(a, aPlacements);
    const bJobDesign = await design(b);
    const bManualDesign = await design(b);

    let stop = false;
    let aOk = 0;
    let aRefused = 0;
    const loopA = (async () => {
      while (!stop) {
        try {
          await runQa(a, aDesign.id);
          aOk++;
        } catch (e) {
          if ((e as { code?: string }).code === "RATE_LIMITED") {
            aRefused++;
            await sleep(25);
          } else await sleep(25); // base: upstream errors are not what we measure here
        }
      }
    })();
    let artworkAttaches = 0;
    const loopArtwork = (async () => {
      if (!artworkLoop) return;
      const conn = await createConnection(a.id);
      const itemId = (await createOrder(a.id, conn.id)).items[0]?.id as string;
      let k = 0;
      while (!stop) {
        // A fresh key each time, so every attach asks for a QA call (S-81: the second bucket).
        await withTenant(a.id, (tx) =>
          setItemArtwork(tx, tenantContext(a.id, null, "office"), {
            id: itemId,
            fileKey: `${a.id}/art/s81-${k++}.png`,
          }),
        ).catch(() => {});
        artworkAttaches++;
        await sleep(25);
      }
    })();
    await sleep(100); // A is in the middle of a call

    const t0 = Date.now();
    const jobRun = (async () => {
      const { job, delays } = stubJob();
      for (let redelays = 0; ; redelays++) {
        try {
          await runDesignQaJob.handler({ companyId: b.id, designId: bJobDesign.id }, job);
          return { ms: Date.now() - t0, redelays };
        } catch (e) {
          if (!(e instanceof DelayedError))
            return { ms: Date.now() - t0, redelays, error: String(e) };
          await sleep(Math.max(0, (delays.at(-1) ?? 0) - Date.now()));
        }
      }
    })();
    // A person who is told to wait clicks Run QA again after the retry hint; the clock keeps running.
    const manualRun = (async () => {
      for (;;) {
        try {
          await runQa(b, bManualDesign.id);
          return { ms: Date.now() - t0 };
        } catch (e) {
          const err = e as { code?: string; data?: { retryAfterSec?: number } };
          if (err.code !== "RATE_LIMITED" || Date.now() - t0 > manualBound)
            return { ms: Date.now() - t0, error: String(err.code ?? e) };
          await sleep((err.data?.retryAfterSec ?? 1) * 1000);
        }
      }
    })();
    const [jobRes, manualRes] = await Promise.all([jobRun, manualRun]);
    stop = true;
    await Promise.all([loopA, loopArtwork]);
    process.stderr.write(
      `T-43-3 crit1 (scale ${scale}): B job ${JSON.stringify(jobRes)} B manual ${JSON.stringify(manualRes)} A ok ${aOk} refused ${aRefused} artwork attaches ${artworkAttaches} bound ${manualBound} ms, margin ${manualBound - manualRes.ms} ms; job bound ${jobBound} ms, margin ${jobBound - jobRes.ms} ms; B manual ${manualRes.ms} ms\n`,
    );

    expect(jobRes.error).toBeUndefined();
    expect(jobRes.ms).toBeLessThan(jobBound);
    expect(await qaStatusOf(b, bJobDesign.id)).toBe("passed");
    expect(manualRes.error).toBeUndefined();
    expect(manualRes.ms).toBeLessThan(resultBound);
    expect(manualRes.ms).toBeLessThan(yieldBound);
    expect(await qaStatusOf(b, bManualDesign.id)).toBe("passed");
    expect(aRefused).toBeGreaterThan(0);
  } finally {
    scaleQaTiming(1); // also resets the re-delay floor and the manual busy budget
    setQaCooldown(0);
    enqueue.mockRestore();
    stub.retryAfterSec = 1;
  }
}

// S-81: one shop loops design Run QA and artwork attaches at once (4.3 s a call, Retry-After 5 s,
// 20 s refill, 6 s cooldown). Without the cooldown the two buckets' bursts run back to back and the
// victim's Run QA needs three clicks over ~42 s at real timing.
//
// The case runs at S81_SCALE = f of the wall-clock time: every timer scales (stub delay and
// Retry-After, refill, in-flight hint, cooldown, re-delay floor and jitter, manual busy budget,
// the test's own give-up). Bounds are B = f x 30 s + s for the manual result and f x 60 s + s for
// the design job; they scale by the same factor, plus a fixed slack s that does not scale:
//   - RATE_LIMITED carries a whole-second hint (router `retrySeconds`, ceil, read-only): up to
//     +1 s per refusal on the victim's path, at most two refusals before it is served;
//   - the 25 ms loop sleeps, the 100 ms head start, Valkey round trips and event-loop lag.
// s = 2 s (measured: see the T-44-2 report; the largest overhead seen was well below it). The
// hint rounding makes the test stricter than real timing, never looser. The S-81 bug (lease
// deleted at once) gives the three-click path: ~f x 42 s, which is above B + s by f x 12 s - 2 s.
const S81_SCALE = 0.5;
const S81_SLACK_MS = 2_000;
describe("S-81: a shop looping design QA and artwork attaches together", () => {
  it(
    "victim shop B: manual result within f x 30 s + s, design job within f x 60 s + s",
    () => crit1(5, 4_300 * S81_SCALE, 5 * S81_SCALE, S81_SCALE, true),
    200_000,
  );

  // T-46-3: imaging at its slow end, 5 s a call and the unchanged Retry-After of 5 s. Before the
  // yield the victim needed 30.04 s here (T-44-2 review); now 28 s is the ceiling, 2 s under the line.
  it(
    "victim shop B at 5.0 s a call: manual result within f x 28 s + s",
    () => crit1(5, 5_000 * S81_SCALE, 5 * S81_SCALE, S81_SCALE, true),
    200_000,
  );

  it("timing hooks default to the live constants and reset after a scaled run", () => {
    expect(LIVE_TIMING).toEqual({
      refillMs: 20_000,
      inFlightRetryMs: 3_000,
      cooldownMs: 6_000,
      redelayFloorMs: 1_000,
      yieldMaxMs: 6_000,
      yieldTotalMs: 12_000,
      yieldPollMs: 100,
      manualBudgetMs: 25_000,
    });
    expect(QA_REFILL_MS).toBe(20_000);
    expect(QA_IN_FLIGHT_RETRY_MS).toBe(3_000);
    expect(QA_REDELAY_FLOOR_MS).toBe(1_000);
    expect(QA_COOLDOWN_MS).toBe(6_000);
    expect(QA_MANUAL_BUSY).toEqual({ retries: 5, budgetMs: 25_000 });
    scaleQaTiming(S81_SCALE);
    try {
      expect(qaTimingNow().redelayFloorMs).toBe(QA_REDELAY_FLOOR_MS * S81_SCALE);
      expect(QA_MANUAL_BUSY.budgetMs).toBe(25_000 * S81_SCALE);
    } finally {
      scaleQaTiming(1);
      setQaCooldown(0);
    }
    expect(QA_MANUAL_BUSY.budgetMs).toBe(25_000);
  });
});

describe("criterion 2: per-company lease and allowance", () => {
  it("refuses over the burst with RATE_LIMITED at once and no imaging call", async () => {
    stub.delayMs = 5;
    const s = await shop();
    const d = await design(s);
    for (let i = 0; i < QA_BURST; i++) await runQa(s, d.id);
    const served = stub.served;
    const before = stub.calls["/qa/check"] ?? 0;
    const t0 = Date.now();
    const err = await runQa(s, d.id).catch((e) => e);
    expect(err.code).toBe("RATE_LIMITED");
    expect(err.data.retryAfterSec).toBeGreaterThanOrEqual(1);
    expect(err.data.retryAfterSec).toBeLessThanOrEqual(20);
    expect(Date.now() - t0).toBeLessThan(500);
    expect(stub.calls["/qa/check"] ?? 0).toBe(before);
    expect(stub.served).toBe(served);
  });

  it("a held lease refuses at once, is not consumed by the refusal, and release frees it", async () => {
    stub.delayMs = 5;
    const s = await shop();
    const d = await design(s);
    const held = await takeQaTurn(s.id, 1, "design");
    expect(held.ok).toBe(true);
    const before = stub.calls["/qa/check"] ?? 0;
    const err = await runQa(s, d.id).catch((e) => e);
    expect(err.code).toBe("RATE_LIMITED");
    expect(stub.calls["/qa/check"] ?? 0).toBe(before);
    if (held.ok) await held.release();
    await expect(runQa(s, d.id)).resolves.toMatchObject({ id: d.id });
    expect(await redis.exists(`qa:lease:${s.id}`)).toBe(0); // released in finally
  });

  it("the lease is released when imaging fails", async () => {
    const s = await shop();
    const d = await design(s);
    vi.spyOn(
      (await import("../../integrations/imaging/client")).imaging,
      "qaCheck",
    ).mockRejectedValueOnce(new ImagingError("/qa/check", 500, "boom"));
    const err = await runQa(s, d.id).catch((e) => e);
    expect(err.code).toBe("UPSTREAM_FAILED");
    expect(await redis.exists(`qa:lease:${s.id}`)).toBe(0);
    vi.restoreAllMocks();
  });

  it("release is compare-and-delete: an expired holder never frees the next lease", async () => {
    const s = await shop();
    const first = await takeQaTurn(s.id, 1, "design");
    await redis.del(`qa:lease:${s.id}`); // the TTL ran out
    const second = await takeQaTurn(s.id, 1, "design");
    expect(second.ok).toBe(true);
    if (first.ok) await first.release();
    expect(await redis.exists(`qa:lease:${s.id}`)).toBe(1);
    if (second.ok) await second.release();
    expect(await redis.exists(`qa:lease:${s.id}`)).toBe(0);
  });

  it("the lease is kept for the cooldown after a turn, only the holder shortens it (S-81)", async () => {
    const s = await shop();
    setQaCooldown(6_000);
    try {
      const first = await takeQaTurn(s.id, 1, "design");
      expect(first.ok).toBe(true);
      if (first.ok) await first.release();
      const ttl = await redis.pttl(`qa:lease:${s.id}`);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(6_000);
      expect(await takeQaTurn(s.id, 1, "artwork")).toMatchObject({
        ok: false,
        reason: "in_flight",
      });
      // an old holder (its lease expired and was taken by another) must not shorten the new lease
      await redis.del(`qa:lease:${s.id}`);
      const stale = first;
      setQaCooldown(0);
      const second = await takeQaTurn(s.id, 1, "design");
      setQaCooldown(6_000);
      expect(second.ok).toBe(true);
      const before = await redis.pttl(`qa:lease:${s.id}`);
      if (stale.ok) await stale.release();
      expect(await redis.pttl(`qa:lease:${s.id}`)).toBeGreaterThan(before - 50);
      expect(await redis.pttl(`qa:lease:${s.id}`)).toBeGreaterThan(6_000);
      await redis.del(`qa:lease:${s.id}`);
    } finally {
      setQaCooldown(0);
    }
  });

  it("fails open with a warning when Valkey errors", async () => {
    const s = await shop();
    const spy = vi.spyOn(redis, "set").mockRejectedValueOnce(new Error("valkey down"));
    const t = await takeQaTurn(s.id, 1, "design");
    expect(t.ok).toBe(true);
    spy.mockRestore();
  });
});

describe("criterion 3: the QA job never sleeps on a busy slot", () => {
  it("re-delays with Retry-After + jitter in well under a second while the slot stays busy", async () => {
    stub.delayMs = 300;
    const s = await shop();
    const d = await design(s);
    stub.hold(2_000);
    const { job, delays } = stubJob();
    const t0 = Date.now();
    await expect(
      runDesignQaJob.handler({ companyId: s.id, designId: d.id }, job),
    ).rejects.toBeInstanceOf(DelayedError);
    expect(Date.now() - t0).toBeLessThan(800);
    expect(stub.busy).toBe(true); // the worker is free while imaging is still busy
    expect(delays).toHaveLength(1);
    expect((delays[0] ?? 0) - t0).toBeGreaterThanOrEqual(1_000);
    expect((delays[0] ?? 0) - t0).toBeLessThan(2_600);
    expect(await qaStatusOf(s, d.id)).toBe("pending");
    expect(await redis.exists(`qa:lease:${s.id}`)).toBe(0);
    await sleep(2_100);
  });

  it("a held company lease re-delays the job without calling imaging", async () => {
    const s = await shop();
    const d = await design(s);
    const held = await takeQaTurn(s.id, 1, "design");
    const before = stub.calls["/qa/check"] ?? 0;
    const { job } = stubJob();
    await expect(
      runDesignQaJob.handler({ companyId: s.id, designId: d.id }, job),
    ).rejects.toBeInstanceOf(DelayedError);
    expect(stub.calls["/qa/check"] ?? 0).toBe(before);
    if (held.ok) await held.release();
  });

  it("after 30 minutes it leaves the design pending with one warn, never failed or passed", async () => {
    const s = await shop();
    const d = await design(s);
    stub.hold(1_500);
    const { job } = stubJob({ timestamp: Date.now() - 31 * 60_000 });
    const out = await runDesignQaJob.handler({ companyId: s.id, designId: d.id }, job);
    expect(out).toEqual({ gaveUp: true });
    expect(job.moveToDelayed).not.toHaveBeenCalled();
    expect(await qaStatusOf(s, d.id)).toBe("pending");
    await sleep(1_600);
  });

  it("run twice: one QA result, and a real BullMQ worker is free while a QA job waits", async () => {
    stub.delayMs = 50;
    const s = await shop();
    const d = await design(s);
    const q = new Queue(`w43-qa-${Date.now()}`, { connection: redis });
    const handled: string[] = [];
    const worker = new Worker(
      q.name,
      async (job) => {
        if (job.name === "qa") return runDesignQaJob.handler(job.data, job);
        handled.push(job.name);
        return "ok";
      },
      { connection: redis, concurrency: 1 },
    );
    try {
      stub.hold(2_500); // QA job hits a busy slot and must hand its worker back
      await q.add("qa", { companyId: s.id, designId: d.id });
      await sleep(400);
      await q.add("sheet-build", {});
      const t0 = Date.now();
      while (!handled.includes("sheet-build") && Date.now() - t0 < 3_000) await sleep(50);
      expect(handled).toContain("sheet-build"); // the single worker was not stuck in a QA sleep
      expect(await q.getDelayedCount()).toBe(1); // moveToDelayed with the real job.token worked
      expect(await qaStatusOf(s, d.id)).toBe("pending");
    } finally {
      await worker.close();
      await q.obliterate({ force: true });
      await q.close();
    }
    await sleep(2_200);
    // the same job again (a retry): one result
    await runDesignQaJob.handler({ companyId: s.id, designId: d.id }, stubJob().job);
    await runDesignQaJob
      .handler({ companyId: s.id, designId: d.id }, stubJob().job)
      .catch(() => {});
    const files = await withTenant(s.id, (tx) =>
      tx.select().from(designFiles).where(eq(designFiles.designId, d.id)),
    );
    expect(files).toHaveLength(1);
    expect(files[0]?.qaStatus).toBe("passed");
  }, 30_000);
});

describe("criterion 5: unchanged paths", () => {
  it("runDesignQa itself is unthrottled and takes no lease (the seed path)", async () => {
    stub.delayMs = 5;
    const s = await shop();
    const d = await design(s);
    const set = vi.spyOn(redis, "set");
    for (let i = 0; i < QA_BURST + 2; i++)
      await withTenant(s.id, (tx) =>
        svc.runDesignQa(tx, tenantContext(s.id, s.userId, "designer"), d.id),
      );
    expect(set).not.toHaveBeenCalled();
    set.mockRestore();
    expect(await qaStatusOf(s, d.id)).toBe("passed");
  });

  it("the client: other callers keep 5 busy retries; qaCheck busy options tune one call", async () => {
    const { createImagingClient } = await import("../../integrations/imaging/client");
    const sleeps: number[] = [];
    const c = createImagingClient(stub.url, 5_000, "", async (ms) => {
      sleeps.push(ms);
    });
    stub.calls["/qa/clean-alpha"] = 0;
    await expect(c.cleanAlpha({ file_key: "k", out_key: "o" })).rejects.toMatchObject({
      status: 429,
      retryAfterMs: 1_000,
    });
    expect(stub.calls["/qa/clean-alpha"]).toBe(6); // first try + 5 retries, as before
    expect(sleeps).toHaveLength(5);

    sleeps.length = 0;
    stub.hold(1_000);
    await expect(c.qaCheck({ file_key: "k" }, { retries: 0 })).rejects.toMatchObject({
      status: 429,
      retryAfterMs: 1_000,
    });
    expect(sleeps).toHaveLength(0);
    await sleep(1_100);

    stub.hold(1_000);
    await expect(
      c.qaCheck({ file_key: "k" }, { retries: 5, budgetMs: 2_500 }),
    ).rejects.toMatchObject({
      status: 429,
    });
    expect(sleeps).toEqual([1_000, 1_000]); // a third 1 s would pass the 2.5 s budget
    await sleep(1_100);
  });
});

describe("criterion 6: tenancy", () => {
  it("one company's lease and allowance never block another's; keys hold only the company id", async () => {
    const a = await shop();
    const b = await shop();
    const heldA = await takeQaTurn(a.id, 1, "design");
    for (let i = 0; i < QA_BURST; i++) {
      const t = await takeQaTurn(b.id, 1, "design");
      expect(t.ok).toBe(true);
      if (t.ok) await t.release();
    }
    const aSecond = await takeQaTurn(a.id, 1, "design");
    expect(aSecond).toMatchObject({ ok: false, reason: "in_flight" });
    const bNext = await takeQaTurn(b.id, 1, "design");
    expect(bNext).toMatchObject({ ok: false, reason: "rate" }); // B used its own burst
    if (heldA.ok) await heldA.release();
    const cShop = await shop();
    expect((await takeQaTurn(cShop.id, 1, "design")).ok).toBe(true);
    const keys = [...(await redis.keys("qa:*"))];
    const uuid = /^qa:(lease|rate:(design|artwork)):[0-9a-f-]{36}$/;
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) expect(k).toMatch(uuid);
  });

  it("company B cannot run QA on company A's design (NOT_FOUND)", async () => {
    stub.delayMs = 5;
    const a = await shop();
    const b = await shop();
    const d = await design(a);
    const err = await runQa(b, d.id).catch((e) => e);
    expect(err.code).toBe("NOT_FOUND");
  });
});

// T-46-3 (S-81 residual, B-415): a turn yields to another shop's person who is waiting on imaging.
// Run at 1/10 of the wall-clock time (every timer scales, see scaleQaTiming); durations asserted
// below are lower bounds from the stub's delays and the scaled yield cap, or generous upper bounds.
const WAITING = "qa:manual-waiting";
const Y_SCALE = 0.1;
describe("T-46-3: yield to a waiting person of another shop", () => {
  const lease = (s: Shop) => `qa:lease:${s.id}`;
  const tick = () => new Promise<void>((r) => setImmediate(r));
  async function scaled<T>(fn: () => Promise<T>): Promise<T> {
    scaleQaTiming(Y_SCALE);
    setQaCooldown(0); // scaleQaTiming scales the cooldown; these cases take several turns in a row
    stub.delayMs = 300;
    try {
      return await fn();
    } finally {
      scaleQaTiming(1);
      setQaCooldown(0);
      stub.delayMs = 300;
      stub.retryAfterSec = 1;
      stub.script = [];
      stub.failNext = 0;
      await redis.del(WAITING);
    }
  }

  it("waits before placement 2 while another shop is waiting, holds its lease, then finishes the design", async () => {
    await scaled(async () => {
      const a = await shop();
      const c = await shop();
      const d = await design(a, 2);
      const base = stub.served;
      const t0 = Date.now();
      const run = runQa(a, d.id);
      await vi.waitFor(() => expect(stub.served).toBe(base + 1));
      await redis.zadd(WAITING, Date.now(), c.id); // shop C's person is told "busy" meanwhile
      let sawFree = false;
      while (stub.served === base + 1) {
        if ((await redis.exists(lease(a))) === 0) sawFree = true;
        await tick();
      }
      await run;
      const ms = Date.now() - t0;
      expect(sawFree).toBe(false); // one call in flight per company: the lease is kept while yielding
      expect(stub.served).toBe(base + 2); // never refused half way
      expect(await qaStatusOf(a, d.id)).toBe("passed");
      // two 300 ms calls plus the whole per-placement yield cap (the waiter never went away)
      expect(ms).toBeGreaterThanOrEqual(2 * 300 + qaTimingNow().yieldMaxMs - 50);
      // ... and not longer: the cap bounds the wait (an uncapped yield runs until the entry is pruned, 2.5 s)
      expect(ms).toBeLessThan(2 * 300 + qaTimingNow().yieldMaxMs + 1_000);
    });
  }, 30_000);

  it("a waiting person of the SAME company is not waited for, and does not refuse its own turn", async () => {
    await scaled(async () => {
      const a = await shop();
      const d = await design(a, 2);
      stub.delayMs = 5;
      await redis.zadd(WAITING, Date.now(), a.id);
      const t0 = Date.now();
      await expect(runQa(a, d.id)).resolves.toMatchObject({ id: d.id });
      expect(Date.now() - t0).toBeLessThan(qaTimingNow().yieldMaxMs / 2);
      expect(await qaStatusOf(a, d.id)).toBe("passed");
    });
  }, 30_000);

  it("a NEW turn is refused with the in-flight hint while another shop's person waits, and costs nothing", async () => {
    await scaled(async () => {
      const a = await shop();
      const c = await shop();
      await redis.zadd(WAITING, Date.now(), c.id);
      const refused = await takeQaTurn(a.id, 1, "design", { person: true });
      expect(refused).toMatchObject({
        ok: false,
        reason: "in_flight",
        retryAfterMs: qaTimingNow().inFlightRetryMs,
      });
      expect(await redis.exists(lease(a))).toBe(0);
      // a job or an artwork check does not ask the question: it re-delays on its own
      const job = await takeQaTurn(a.id, 1, "design");
      expect(job.ok).toBe(true);
      if (job.ok) await job.release();
      await redis.zrem(WAITING, c.id);
      const turn = await takeQaTurn(a.id, 1, "design", { person: true });
      expect(turn.ok).toBe(true); // the refusal took no allowance token
      if (turn.ok) await turn.release();
    });
  });

  it("a person is registered only while waiting on a 429, and removed on success, give-up and failure", async () => {
    await scaled(async () => {
      stub.retryAfterSec = 0.1;
      const watch = async (s: Shop, id: string) => {
        let seen = false;
        const p = runQa(s, id).then(
          (r) => ({ r }),
          (e) => ({ e }),
        );
        let done = false;
        void p.then(() => {
          done = true;
        });
        while (!done) {
          if ((await redis.zscore(WAITING, s.id)) !== null) seen = true;
          await tick();
        }
        return { seen, out: await p };
      };
      const b = await shop();
      const d = await design(b);

      stub.script = [true, true]; // two 429s, then served
      const served = await watch(b, d.id);
      expect(served.seen).toBe(true);
      expect("r" in served.out).toBe(true);
      expect(await redis.zcard(WAITING)).toBe(0);

      stub.script = [true];
      stub.failNext = 1; // a 429, then imaging fails
      const failed = await watch(b, d.id);
      expect(failed.seen).toBe(true);
      expect((failed.out as { e: { code: string } }).e.code).toBe("UPSTREAM_FAILED");
      expect(await redis.zcard(WAITING)).toBe(0);

      stub.script = Array(8).fill(true); // busy for good: the budget runs out
      const gaveUp = await watch(b, d.id);
      expect((gaveUp.out as { e: { code: string } }).e.code).toBe("RATE_LIMITED");
      expect(await redis.zcard(WAITING)).toBe(0);
    });
  }, 30_000);

  it("two shops' multi-placement manual runs both finish, nobody is refused half way", async () => {
    await scaled(async () => {
      stub.retryAfterSec = 0.1;
      const a = await shop();
      const b = await shop();
      const da = await design(a, 2);
      const db = await design(b, 2);
      const base = stub.served;
      const t0 = Date.now();
      const runA = runQa(a, da.id);
      await vi.waitFor(() => expect(stub.served).toBe(base + 1));
      const runB = runQa(b, db.id); // B's first call gets 429 and B waits; A yields at its boundary
      await Promise.all([runA, runB]);
      expect(stub.served).toBe(base + 4);
      expect(await qaStatusOf(a, da.id)).toBe("passed");
      expect(await qaStatusOf(b, db.id)).toBe("passed");
      // 4 calls of 300 ms plus at most one yield each: far below the scaled manual budget
      expect(Date.now() - t0).toBeLessThan(4 * 300 + 2 * qaTimingNow().yieldMaxMs + 1_000);
      expect(await redis.zcard(WAITING)).toBe(0);
    });
  }, 30_000);

  it("the attacker's own interactive Run QA is still served while its own background job runs", async () => {
    await scaled(async () => {
      const a = await shop();
      const jobDesign = await design(a);
      const mine = await design(a);
      const { job } = stubJob();
      const base = stub.served;
      const background = runDesignQaJob.handler({ companyId: a.id, designId: jobDesign.id }, job);
      await vi.waitFor(() => expect(stub.served).toBe(base + 1)); // A's own job holds the slot
      const t0 = Date.now();
      let refusals = 0;
      for (;;) {
        try {
          await runQa(a, mine.id);
          break;
        } catch (e) {
          const err = e as { code?: string; data?: { retryAfterSec?: number } };
          expect(err.code).toBe("RATE_LIMITED"); // own lease busy: asked to retry, never a failure
          expect(++refusals).toBeLessThan(5);
          await sleep((err.data?.retryAfterSec ?? 1) * 1000);
        }
      }
      await background;
      expect(Date.now() - t0).toBeLessThan(30_000 * Y_SCALE + S81_SLACK_MS);
      expect(refusals).toBeGreaterThan(0);
      expect(await qaStatusOf(a, mine.id)).toBe("passed");
      expect(await qaStatusOf(a, jobDesign.id)).toBe("passed");
      expect(await redis.zcard(WAITING)).toBe(0);
    });
  }, 60_000);

  it("a turn imaging refused costs only the calls that ran: polling a busy slot burns no tokens", async () => {
    await scaled(async () => {
      const a = await shop();
      for (let i = 0; i < QA_BURST + 3; i++) {
        const t = await takeQaTurn(a.id, 1, "design");
        expect(t.ok).toBe(true); // the 4th poll would be refused for rate without the refund
        if (t.ok) await t.release({ busy: true });
      }
      const b = await shop();
      const turn = await takeQaTurn(b.id, 3, "design"); // burst 3, charged 3: empty
      if (turn.ok) await turn.release({ busy: true, ran: 1 }); // 1 of 3 ran, 2 come back
      const tokens = Number(await redis.hget(`qa:rate:design:${b.id}`, "tokens"));
      expect(tokens).toBeGreaterThan(1.9);
      expect(tokens).toBeLessThan(2.5); // refill over a few ms only
      const kept = await takeQaTurn(b.id, 1, "design");
      if (kept.ok) await kept.release({ ran: 1 }); // a turn that ended any other way keeps its charge
      expect(Number(await redis.hget(`qa:rate:design:${b.id}`, "tokens"))).toBeLessThan(1.5);
    });
  });

  it("a turn yields at most yieldTotalMs over all its placements, however long the other person waits", async () => {
    await scaled(async () => {
      const a = await shop();
      const c = await shop();
      const d = await design(a, 4);
      const base = stub.served;
      const t0 = Date.now();
      const run = runQa(a, d.id);
      await vi.waitFor(() => expect(stub.served).toBe(base + 1));
      await redis.zadd(WAITING, Date.now(), c.id);
      await run;
      const ms = Date.now() - t0;
      const { yieldTotalMs } = qaTimingNow();
      expect(stub.served).toBe(base + 4);
      expect(ms).toBeGreaterThanOrEqual(4 * 300 + yieldTotalMs - 50); // two full yields used up the total
      expect(ms).toBeLessThan(4 * 300 + yieldTotalMs + 500); // the third placement did not yield
    });
  }, 30_000);
});
