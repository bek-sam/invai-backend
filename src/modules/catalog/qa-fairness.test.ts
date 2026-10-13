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
import { createCompany, createUser, tenantContext } from "../../test/fixtures";
import { runDesignQaJob } from "./jobs";
import { type QaStub, startQaStub } from "./qa-stub.testutil";
import { QA_BURST, takeQaTurn } from "./qa-turn";
import * as svc from "./service";

/*
 * T-43-3 (S-76 / B-399): one shop looping print-file QA can't starve another shop's QA.
 * Imaging is an in-process stub (one global slot, 429 + Retry-After). Valkey is DB 14 only.
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
});
afterAll(async () => {
  await stub.close();
});

describe("criterion 1: a looping shop A does not starve shop B", () => {
  it("B's job and B's manual QA finish; A is the one refused", () => crit1(1, 300, 1), 120_000);

  // S-79: the allowance is charged per /qa/check call, so a 5-placement loop can't hold the slot
  // longer than the refill. Wave 42's worst QA (4.3 s) and imaging's default Retry-After (5 s).
  it("same with A looping a 5-placement design at 4.3 s a call", () => crit1(5, 4_300, 5), 150_000);
});

async function crit1(aPlacements: number, delayMs: number, retryAfterSec: number) {
  try {
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
          if (err.code !== "RATE_LIMITED" || Date.now() - t0 > 30_000)
            return { ms: Date.now() - t0, error: String(err.code ?? e) };
          await sleep((err.data?.retryAfterSec ?? 1) * 1000);
        }
      }
    })();
    const [jobRes, manualRes] = await Promise.all([jobRun, manualRun]);
    stop = true;
    await loopA;
    process.stderr.write(
      `T-43-3 crit1: B job ${JSON.stringify(jobRes)} B manual ${JSON.stringify(manualRes)} A ok ${aOk} refused ${aRefused}\n`,
    );

    expect(jobRes.error).toBeUndefined();
    expect(jobRes.ms).toBeLessThan(60_000);
    expect(await qaStatusOf(b, bJobDesign.id)).toBe("passed");
    expect(manualRes.error).toBeUndefined();
    expect(manualRes.ms).toBeLessThan(30_000);
    expect(await qaStatusOf(b, bManualDesign.id)).toBe("passed");
    expect(aRefused).toBeGreaterThan(0);
  } finally {
    stub.retryAfterSec = 1;
  }
}

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
    const held = await takeQaTurn(s.id);
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
    const first = await takeQaTurn(s.id);
    await redis.del(`qa:lease:${s.id}`); // the TTL ran out
    const second = await takeQaTurn(s.id);
    expect(second.ok).toBe(true);
    if (first.ok) await first.release();
    expect(await redis.exists(`qa:lease:${s.id}`)).toBe(1);
    if (second.ok) await second.release();
    expect(await redis.exists(`qa:lease:${s.id}`)).toBe(0);
  });

  it("fails open with a warning when Valkey errors", async () => {
    const s = await shop();
    const spy = vi.spyOn(redis, "set").mockRejectedValueOnce(new Error("valkey down"));
    const t = await takeQaTurn(s.id);
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
    const held = await takeQaTurn(s.id);
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
    const heldA = await takeQaTurn(a.id);
    for (let i = 0; i < QA_BURST; i++) {
      const t = await takeQaTurn(b.id);
      expect(t.ok).toBe(true);
      if (t.ok) await t.release();
    }
    const aSecond = await takeQaTurn(a.id);
    expect(aSecond).toMatchObject({ ok: false, reason: "in_flight" });
    const bNext = await takeQaTurn(b.id);
    expect(bNext).toMatchObject({ ok: false, reason: "rate" }); // B used its own burst
    if (heldA.ok) await heldA.release();
    const cShop = await shop();
    expect((await takeQaTurn(cShop.id)).ok).toBe(true);
    const keys = [...(await redis.keys("qa:*"))];
    const uuid = /^qa:(lease|rate):[0-9a-f-]{36}$/;
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
