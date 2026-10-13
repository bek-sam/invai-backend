import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withTenant } from "../../db/client";
import {
  aiCreditLedger,
  aiJobs,
  outboxEvents,
  photoCompositions,
  photoImages,
  photoSets,
} from "../../db/schema";
import { imaging } from "../../integrations/imaging/client";
import { runJobInline } from "../../lib/queues";
import { createCompany, createUser, tenantContext } from "../../test/fixtures";
import { createDesign } from "../catalog/service";
import { dispatchSetJob, renderCompositionJob, renderSceneJob } from "./jobs";
import * as svc from "./service";

/*
 * T-42-1 (B-392): a finished photo set is immune to a re-delivered `photo_set.created` event and
 * to re-delivered render jobs, and a trial set (`dispatch: false`) writes no such event. Runs on
 * invai_test; imaging and the queue's enqueue are doubles that fail the test if reached.
 */

const logs = vi.hoisted(() => ({ info: [] as { msg: string; data?: Record<string, unknown> }[] }));
vi.mock("../../lib/log", async (orig) => {
  const actual = await orig<typeof import("../../lib/log")>();
  return {
    ...actual,
    logger: (scope: string) => {
      const real = actual.logger(scope);
      return {
        ...real,
        info: (msg: string, data?: Record<string, unknown>) => {
          logs.info.push({ msg, data });
          real.info(msg, data);
        },
      };
    },
  };
});

function renderOk(input: { out_key: string; preset: string }) {
  return Promise.resolve({
    key: input.out_key,
    width_px: 2000,
    height_px: 2000,
    format: "jpeg",
    print_box_px: [600, 500, 800, 960],
    checks: {
      passes: true,
      failures: [],
      background_pure_white: true,
      fill_ratio: 0.87,
      longest_side_px: 2000,
    },
  });
}

async function shop() {
  const company = await createCompany();
  const office = await createUser(company.id, "office");
  const ctx = tenantContext(company.id, office.id, "office");
  const design = await withTenant(company.id, (tx) =>
    createDesign(tx, ctx, {
      code: `R${Math.floor(Math.random() * 1e6)}`,
      name: "Desert Sun",
      tags: ["desert"],
      personalizationTemplateId: null,
      placements: [
        {
          placement: "front",
          fileKey: `${company.id}/designs/front.png`,
          widthIn: 10,
          heightIn: 12,
        },
      ],
    }),
  );
  return { company, ctx, design };
}

const spec = (designId: string) => ({
  designId,
  garments: ["tee", "hoodie"] as ("tee" | "hoodie")[],
  colors: [
    { name: "Black", hex: "#000000" },
    { name: "Sand", hex: "#E6D3B3" },
  ],
  views: ["front_flat"] as "front_flat"[],
  channels: ["etsy"] as "etsy"[],
  underbasePreview: true,
  idempotencyKey: `key-${crypto.randomUUID()}`,
});

/** Everything a stray re-dispatch could touch, as plain data. */
async function snapshot(companyId: string, setId: string) {
  return withTenant(companyId, async (tx) => ({
    set: await tx.select().from(photoSets).where(eq(photoSets.id, setId)),
    comps: await tx
      .select()
      .from(photoCompositions)
      .where(eq(photoCompositions.setId, setId))
      .orderBy(photoCompositions.id),
    images: await tx
      .select()
      .from(photoImages)
      .where(eq(photoImages.setId, setId))
      .orderBy(photoImages.id),
    aiJobs: (await tx.select({ id: aiJobs.id }).from(aiJobs)).length,
    ledger: await tx.select().from(aiCreditLedger).orderBy(aiCreditLedger.id),
    outbox: (await tx.select({ id: outboxEvents.id }).from(outboxEvents)).length,
  }));
}

const enqueueSpies = () => ({
  comp: vi.spyOn(renderCompositionJob, "enqueue").mockResolvedValue(undefined as never),
  scene: vi.spyOn(renderSceneJob, "enqueue").mockResolvedValue(undefined as never),
});

async function compositionIds(companyId: string, setId: string) {
  const rows = await withTenant(companyId, (tx) =>
    tx
      .select({ id: photoCompositions.id })
      .from(photoCompositions)
      .where(eq(photoCompositions.setId, setId)),
  );
  return rows.map((r) => r.id);
}

async function finishedSet() {
  const s = await shop();
  const set = await withTenant(s.company.id, (tx) => svc.createSet(tx, s.ctx, spec(s.design.id)));
  for (const compositionId of await svc.openCompositions(s.company.id, set.id))
    await runJobInline(renderCompositionJob, { companyId: s.company.id, compositionId });
  return { ...s, set };
}

beforeAll(() => {
  svc.setPhotoEnqueuers({ analysis: async () => {}, zip: async () => {}, push: async () => {} });
});

beforeEach(() => {
  logs.info.length = 0;
  vi.spyOn(imaging, "photoRender").mockImplementation(renderOk);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a finished set and a re-delivered photo_set.created (B-392)", () => {
  it("dispatches nothing, charges nothing, rewrites nothing, and says so once per delivery", async () => {
    const { company, set } = await finishedSet();
    const before = await snapshot(company.id, set.id);
    expect(before.set[0]?.status).toBe("ready");
    expect(before.images.every((i) => i.status === "rendered")).toBe(true);

    vi.mocked(imaging.photoRender).mockClear();
    const spies = enqueueSpies();
    const input = { companyId: company.id, setId: set.id };
    expect(await runJobInline(dispatchSetJob, input)).toEqual({ enqueued: 0, scenes: 0 });
    expect(await runJobInline(dispatchSetJob, input)).toEqual({ enqueued: 0, scenes: 0 });
    // Then every render job, as the worker would run them for the old event's compositions.
    for (const compositionId of await compositionIds(company.id, set.id)) {
      await runJobInline(renderCompositionJob, { companyId: company.id, compositionId });
      await runJobInline(renderSceneJob, { companyId: company.id, compositionId });
    }

    expect(spies.comp).not.toHaveBeenCalled();
    expect(spies.scene).not.toHaveBeenCalled();
    expect(imaging.photoRender).not.toHaveBeenCalled();
    expect(await snapshot(company.id, set.id)).toEqual(before);
    const lines = logs.info.filter((l) => l.msg === "photo set had nothing open");
    expect(lines).toHaveLength(2);
    expect(lines[0]?.data).toMatchObject({ companyId: company.id, setId: set.id });
  });

  it("a failed set (every image terminal) is just as inert", async () => {
    const { company, set } = await finishedSet();
    await withTenant(company.id, async (tx) => {
      await tx.update(photoImages).set({ status: "failed" }).where(eq(photoImages.setId, set.id));
      await tx.update(photoSets).set({ status: "failed" }).where(eq(photoSets.id, set.id));
    });
    const before = await snapshot(company.id, set.id);
    const spies = enqueueSpies();
    vi.mocked(imaging.photoRender).mockClear();
    await runJobInline(dispatchSetJob, { companyId: company.id, setId: set.id });
    for (const compositionId of await compositionIds(company.id, set.id))
      await runJobInline(renderCompositionJob, { companyId: company.id, compositionId });
    expect(spies.comp).not.toHaveBeenCalled();
    expect(imaging.photoRender).not.toHaveBeenCalled();
    expect(await snapshot(company.id, set.id)).toEqual(before);
  });

  it("a render job for a composition whose images are all terminal returns skipped and writes nothing", async () => {
    const { company, set } = await finishedSet();
    const before = await snapshot(company.id, set.id);
    vi.mocked(imaging.photoRender).mockClear();
    const [compositionId] = await compositionIds(company.id, set.id);
    const out = await runJobInline(renderCompositionJob, {
      companyId: company.id,
      compositionId: compositionId as string,
    });
    expect(out).toMatchObject({ rendered: 0, failed: 0, charged: false, skipped: true });
    expect(imaging.photoRender).not.toHaveBeenCalled();
    expect(await snapshot(company.id, set.id)).toEqual(before);
  });

  it("a new set with queued images still dispatches all of them, a partly finished one only the open", async () => {
    const s = await shop();
    const set = await withTenant(s.company.id, (tx) => svc.createSet(tx, s.ctx, spec(s.design.id)));
    const spies = enqueueSpies();
    const fresh = await runJobInline(dispatchSetJob, { companyId: s.company.id, setId: set.id });
    expect(fresh).toEqual({ enqueued: 4, scenes: 0 });
    expect(spies.comp).toHaveBeenCalledTimes(4);

    const open = await svc.openCompositions(s.company.id, set.id);
    for (const compositionId of open.slice(0, 3))
      await runJobInline(renderCompositionJob, { companyId: s.company.id, compositionId });
    spies.comp.mockClear();
    const partial = await runJobInline(dispatchSetJob, { companyId: s.company.id, setId: set.id });
    expect(partial).toEqual({ enqueued: 1, scenes: 0 });
    expect(spies.comp).toHaveBeenCalledTimes(1);
    expect(spies.comp.mock.calls[0]?.[0]).toMatchObject({ compositionId: open[3] });
  });
});

describe("createSet dispatch option (trial sets)", () => {
  const created = (companyId: string) =>
    withTenant(companyId, (tx) =>
      tx.select().from(outboxEvents).where(eq(outboxEvents.name, "photo_set.created")),
    );

  it("writes one photo_set.created by default and none with dispatch: false", async () => {
    const s = await shop();
    await withTenant(s.company.id, (tx) => svc.createSet(tx, s.ctx, spec(s.design.id)));
    expect(await created(s.company.id)).toHaveLength(1);
    const trial = await withTenant(s.company.id, (tx) =>
      svc.createSet(tx, s.ctx, spec(s.design.id), { dispatch: false }),
    );
    expect(await created(s.company.id)).toHaveLength(1);
    expect(trial.images.every((i) => i.status === "queued")).toBe(true);
    expect(trial.compositions).toHaveLength(4);
  });

  it("keeps the idempotency key: the same trial spec twice is one set", async () => {
    const s = await shop();
    const input = spec(s.design.id);
    const a = await withTenant(s.company.id, (tx) =>
      svc.createSet(tx, s.ctx, input, { dispatch: false }),
    );
    const b = await withTenant(s.company.id, (tx) =>
      svc.createSet(tx, s.ctx, input, { dispatch: false }),
    );
    expect(b.id).toBe(a.id);
    expect(await created(s.company.id)).toHaveLength(0);
  });
});
