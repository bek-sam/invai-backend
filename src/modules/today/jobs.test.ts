import { randomUUID } from "node:crypto";
import { Worker } from "bullmq";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { withTenant } from "../../db/client";
import { todayActionSets } from "../../db/schema";
import {
  LIVE_JOB_STATES,
  processJob,
  queues,
  redis,
  runJobInline,
  safeJobId,
} from "../../lib/queues";
import { createCompany } from "../../test/fixtures";
import { buildTodayActionsJob, requeueBuild } from "./jobs";

/*
 * T-P2-5: after `buildTodayActionsJob`'s 3rd attempt fails for good, the failed job sits in
 * Redis (`removeOnFail` keeps it 7 days) and BullMQ ignores an `add` whose jobId already exists,
 * so without this fix no later sweep can rebuild that day. `requeueBuild` is the sweep's per-shop
 * decision (architect ruling 4, `waves/P2/reviews/plan-architect.md`): get-state-then-remove-
 * then-enqueue for a `failed` job, remove wrapped for a concurrent-sweep race, any live state or
 * `completed` left untouched. Tested directly (one company, one jobId at a time) rather than
 * through `sweepTodayActions`, which pages over every shop in the shared test database.
 */

const queue = queues.reports;
const DATE = "2026-09-30";

function jobIdFor(companyId: string, date: string) {
  return safeJobId(`today-actions-${companyId}-${date}`);
}

async function settle(jobId: string, states: string[], ms = 10_000): Promise<string> {
  const until = Date.now() + ms;
  for (;;) {
    const job = await queue.getJob(jobId);
    const state = job ? await job.getState() : "unknown";
    if (states.includes(state)) return state;
    if (Date.now() > until) throw new Error(`job ${jobId} still ${state}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function setExists(companyId: string): Promise<boolean> {
  const rows = await withTenant(companyId, (tx) =>
    tx
      .select({ id: todayActionSets.id })
      .from(todayActionSets)
      .where(eq(todayActionSets.companyId, companyId)),
  );
  return rows.length > 0;
}

describe("requeueBuild after a final failure (T-P2-5)", () => {
  let worker: Worker;

  beforeAll(async () => {
    // A stray job left over by an earlier, abnormally-stopped run (same pattern as
    // `lib/queues.test.ts`) must not confuse this file's assertions.
    await queue.obliterate({ force: true });
    worker = new Worker("reports", processJob, { connection: redis, concurrency: 5 });
  });

  afterAll(async () => {
    await worker.close();
    await queue.obliterate({ force: true });
  });

  it("removes a failed build job and enqueues a fresh one, which builds the day", async () => {
    const company = await createCompany();
    const jobId = jobIdFor(company.id, DATE);

    // Bad payload: fails Zod in the worker (`parseJobInput` -> `permanentFailure`), landing in
    // "failed" after one try with no backoff wait, as a real exhausted build job eventually would.
    await queue.add(
      buildTodayActionsJob.name,
      { companyId: company.id, date: "not-a-date" },
      { jobId },
    );
    await settle(jobId, ["failed"]);
    expect(await setExists(company.id)).toBe(false);

    expect(await requeueBuild(company.id, DATE)).toBe(true);
    await settle(jobId, ["completed"]);
    expect(await setExists(company.id)).toBe(true);
  });

  it("no existing job: enqueues normally, same as before this fix", async () => {
    const company = await createCompany();
    const jobId = jobIdFor(company.id, DATE);
    expect(await queue.getJob(jobId)).toBeUndefined();

    expect(await requeueBuild(company.id, DATE)).toBe(true);
    await settle(jobId, ["completed"]);
    expect(await setExists(company.id)).toBe(true);
  });

  it("repeat call once the set already built: still true (BullMQ dedupes the same jobId); no second set row", async () => {
    const company = await createCompany();
    await requeueBuild(company.id, DATE);
    await settle(jobIdFor(company.id, DATE), ["completed"]);
    expect(await setExists(company.id)).toBe(true);

    // The jobId's slot is taken by the completed job, so this is the `completed`-left-alone branch.
    const spy = vi.spyOn(buildTodayActionsJob, "enqueue");
    expect(await requeueBuild(company.id, DATE)).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    const rows = await withTenant(company.id, (tx) =>
      tx
        .select({ id: todayActionSets.id })
        .from(todayActionSets)
        .where(eq(todayActionSets.companyId, company.id)),
    );
    expect(rows).toHaveLength(1);
  });
});

// No worker started in this describe, and files run one at a time (`fileParallelism: false`
// above's `afterAll` already closed), so this job can never move past its initial queued state
// on its own: the assertion below is race-free without any pause/resume dance.
describe("requeueBuild leaves an already-queued (not failed) job alone", () => {
  it("a live job already queued for the same day is left alone: no second build is enqueued", async () => {
    const company = await createCompany();
    const jobId = jobIdFor(company.id, DATE);
    await queue.add(buildTodayActionsJob.name, { companyId: company.id, date: DATE }, { jobId });
    const state = await (await queue.getJob(jobId))?.getState();
    expect(LIVE_JOB_STATES as readonly string[]).toContain(state);

    const spy = vi.spyOn(buildTodayActionsJob, "enqueue");
    expect(await requeueBuild(company.id, DATE)).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();

    // Nothing will ever process this job here: remove it so it doesn't linger in Redis.
    await (await queue.getJob(jobId))?.remove();
  });
});

describe("buildTodayActionsJob handler logging (AC4)", () => {
  it("a failed build attempt logs one warn with companyId, date and attempt count, no PII", async () => {
    const bogusCompanyId = randomUUID(); // valid UUID, no row in `companies`: the insert's FK fails
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      runJobInline(
        buildTodayActionsJob,
        { companyId: bogusCompanyId, date: DATE },
        { attempt: 2, attempts: 3 },
      ),
    ).rejects.toThrow();
    expect(errSpy).toHaveBeenCalledTimes(1);
    const line = String(errSpy.mock.calls[0]?.[0]);
    errSpy.mockRestore();
    expect(line).toContain("today actions build failed");
    expect(line).toContain(bogusCompanyId);
    expect(line).toContain(DATE);
    expect(line).toContain('"attempt":2');
    expect(line).toContain('"attempts":3');
  });
});
