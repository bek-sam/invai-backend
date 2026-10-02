import type { DesignPhotoAnalysis, ListingDraft } from "@invai/contracts";
import { call, ORPCError } from "@orpc/server";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { chargeCredits, creditBalance } from "../../ai/credits";
import { anonymousContext, type Context, permissionsFor } from "../../api/context";
import { router } from "../../api/router";
import { type Tx, withTenant } from "../../db/client";
import { aiCreditLedger, outboxEvents, photoImages, photoSets } from "../../db/schema";
import { ImagingError, imaging } from "../../integrations/imaging/client";
import { runJobInline } from "../../lib/queues";
import { createCompany, createUser, tenantContext } from "../../test/fixtures";
import { createDesign } from "../catalog/service";
import { analyzeDesignJob, buildZipJob, renderCompositionJob } from "./jobs";
import * as svc from "./service";

/*
 * Photos module (T-26-4). Imaging and the two AI-engineer functions are test doubles here (my
 * test file, their units); everything else runs against invai_test with RLS on.
 */

function nn<T>(v: T | null | undefined): T {
  if (v === null || v === undefined) throw new Error("missing test value");
  return v;
}

const fakeDrafts = new Map<string, ListingDraft>();
const attachCalls: unknown[] = [];

vi.mock("../ai/photo-analysis", () => ({
  analyzeDesignForPhotos: vi.fn(
    async (
      _c: string,
      _u: string | null,
      i: { designId: string },
    ): Promise<DesignPhotoAnalysis> => ({
      designId: i.designId,
      source: "mock",
      model: null,
      palette: [],
      lightShare: 0,
      darkShare: 0,
      transparentShare: 0,
      style: "bold desert type",
      audience: "hikers",
      detectedText: null,
      colorDescription: "white art",
      recommendedColors: [
        { name: "White", hex: "#ffffff", reason: "classic" },
        { name: "Black", hex: "#000000", reason: "contrast" },
      ],
      contrastWarnings: [],
      sceneSuggestions: [],
      altText: { amazon: "White desert tee" },
      imageOrder: { amazon: ["back", "front_flat"] },
      creditsUsed: 1,
      analyzedAt: new Date().toISOString(),
    }),
  ),
}));

vi.mock("../ai/photo-attach", () => ({
  attachPhotosToDraft: vi.fn(async (_tx: Tx, _ctx: unknown, input: { draftId: string }) => {
    attachCalls.push(input);
    const d = fakeDrafts.get(input.draftId);
    if (!d) throw new Error("unexpected draft");
    return d;
  }),
}));

vi.mock("../ai/service", async (importOriginal) => {
  const real = await importOriginal<typeof import("../ai/service")>();
  return {
    ...real,
    getDraft: vi.fn(async (tx: Tx, ctx: { companyId: string }, id: string) => {
      const d = fakeDrafts.get(id);
      if ((d as unknown as { _company?: string } | undefined)?._company === ctx.companyId)
        return d as ListingDraft;
      return real.getDraft(tx, ctx as never, id);
    }),
  };
});

const zipEnqueued: unknown[] = [];
const analysisEnqueued: unknown[] = [];

function renderOk(input: { out_key: string; preset: string }) {
  return Promise.resolve({
    key: input.out_key,
    width_px: 2000,
    height_px: 2000,
    format: "jpeg",
    print_box_px: [600, 500, 800, 960],
    checks: {
      passes: input.preset !== "amazon_main",
      failures: input.preset === "amazon_main" ? ["illustration_not_photo", "something_new"] : [],
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
      code: `D${Math.floor(Math.random() * 1e6)}`,
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
        { placement: "back", fileKey: `${company.id}/designs/back.png`, widthIn: 11, heightIn: 14 },
      ],
    }),
  );
  return { company, office, ctx, design };
}

const spec = (designId: string, key = `key-${crypto.randomUUID()}`) => ({
  designId,
  garments: ["tee", "hoodie"] as ("tee" | "hoodie")[],
  colors: [
    { name: "Black", hex: "#000000" },
    { name: "Sand", hex: "#E6D3B3" },
  ],
  views: ["front_flat", "back"] as ("front_flat" | "back")[],
  channels: ["amazon", "etsy"] as ("amazon" | "etsy")[],
  underbasePreview: true,
  idempotencyKey: key,
});

function userContext(companyId: string, userId: string, role: "office" | "presser"): Context {
  return {
    ...anonymousContext(new Headers(), null),
    sessionKind: "user",
    user: { id: userId, name: role, email: `${role}@test.local` },
    emailVerified: true,
    companyId,
    orgType: "shop",
    role,
    permissions: permissionsFor(role),
    resHeaders: new Headers(),
  };
}

async function codeOf(p: Promise<unknown>): Promise<{ code: string; data: unknown }> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ORPCError) return { code: e.code, data: e.data };
    throw e;
  }
  throw new Error("expected an error");
}

async function renderAll(companyId: string, setId: string) {
  for (const compositionId of await svc.openCompositions(companyId, setId))
    await runJobInline(renderCompositionJob, { companyId, compositionId });
}

beforeAll(() => {
  svc.setPhotoEnqueuers({
    analysis: async (i) => {
      analysisEnqueued.push(i);
    },
    zip: async (i) => {
      zipEnqueued.push(i);
    },
  });
});

beforeEach(() => {
  vi.spyOn(imaging, "photoRender").mockImplementation(renderOk);
  vi.spyOn(imaging, "photoZip").mockImplementation(async (i) => ({ key: i.out_key, bytes: 12345 }));
  vi.spyOn(imaging, "photoPalette").mockResolvedValue({
    colors: [
      { hex: "#FAFAFA", share: 0.7 },
      { hex: "#eeeeee", share: 0.2 },
      { hex: "#000000", share: 0.01 },
    ],
    light_share: 0.9,
    dark_share: 0.01,
    transparent_share: 0.5,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("estimate", () => {
  it("counts compositions, images and credits; skips a back view without a back file and duplicate colors", async () => {
    const { company, ctx, design } = await shop();
    const est = await withTenant(company.id, (tx) => svc.estimate(tx, ctx, spec(design.id)));
    expect(est).toMatchObject({
      compositions: 8,
      images: 16,
      credits: 8,
      canAfford: true,
      skipped: [],
    });

    const frontOnly = await withTenant(company.id, (tx) =>
      createDesign(tx, ctx, {
        code: `F${Math.floor(Math.random() * 1e6)}`,
        name: "Front only",
        tags: [],
        personalizationTemplateId: null,
        placements: [
          { placement: "front", fileKey: `${company.id}/designs/f.png`, widthIn: 10, heightIn: 10 },
        ],
      }),
    );
    const s = spec(frontOnly.id);
    s.colors.push({ name: "Black again", hex: "#000000" });
    const est2 = await withTenant(company.id, (tx) => svc.estimate(tx, ctx, s));
    expect(est2.compositions).toBe(4); // 2 garments x 1 view (front) x 2 distinct colors
    expect(est2.skipped.filter((x) => x.reason === "no_back_print_file")).toHaveLength(2);
    expect(est2.skipped.filter((x) => x.reason === "duplicate_color")).toHaveLength(2);
  });
});

describe("createSet", () => {
  it("is idempotent on the key, only enqueues, and refuses a reused key with another spec", async () => {
    const { company, ctx, design } = await shop();
    const input = spec(design.id);
    const a = await withTenant(company.id, (tx) => svc.createSet(tx, ctx, input));
    const b = await withTenant(company.id, (tx) => svc.createSet(tx, ctx, input));
    expect(b.id).toBe(a.id);
    expect(a.status).toBe("queued");
    expect(a.compositions).toHaveLength(8);
    expect(a.images).toHaveLength(16);
    expect(a.images.every((i) => i.status === "queued" && i.key === null)).toBe(true);
    expect(imaging.photoRender).not.toHaveBeenCalled();
    const events = await withTenant(company.id, (tx) =>
      tx.select().from(outboxEvents).where(eq(outboxEvents.name, "photo_set.created")),
    );
    expect(events).toHaveLength(1);
    // Amazon slot 0 is the main preset; the analysis order would put back first (none cached here).
    const amazon = a.images.filter((i) => i.channel === "amazon").sort((x, y) => x.slot - y.slot);
    expect(amazon[0]?.preset).toBe("amazon_main");
    expect(amazon.slice(1).every((i) => i.preset === "amazon_alt")).toBe(true);

    const other = { ...input, channels: ["etsy" as const] as ("amazon" | "etsy")[] };
    const err = await codeOf(withTenant(company.id, (tx) => svc.createSet(tx, ctx, other)));
    expect(err.code).toBe("CONFLICT");
  });

  it("refuses with CREDITS_EXHAUSTED when the balance is below the estimate", async () => {
    const { company, ctx, design } = await shop();
    await withTenant(company.id, async (tx) => {
      const b = await creditBalance(tx, company.id);
      await chargeCredits(tx, {
        companyId: company.id,
        kind: "listing_draft",
        credits: b.remaining - 3,
        model: null,
        usage: null,
      });
    });
    const err = await codeOf(
      withTenant(company.id, (tx) => svc.createSet(tx, ctx, spec(design.id))),
    );
    expect(err.code).toBe("CREDITS_EXHAUSTED");
    const sets = await withTenant(company.id, (tx) => tx.select().from(photoSets));
    expect(sets).toHaveLength(0);
  });

  it("refuses more than 48 compositions with BAD_REQUEST", async () => {
    const { company, office, design } = await shop();
    const ctx = userContext(company.id, office.id, "office");
    const colors = Array.from({ length: 12 }, (_, i) => ({
      name: `C${i}`,
      hex: `#0000${String(i).padStart(2, "0")}`,
    }));
    const input = {
      ...spec(design.id),
      garments: ["tee", "hoodie", "crewneck", "tank"],
      colors,
      views: ["front_flat", "back"],
    };
    const err = await codeOf(call(router.photos.createSet, input as never, { context: ctx }));
    expect(err.code).toBe("BAD_REQUEST");
  });
});

describe("render jobs", () => {
  it("renders each composition's images, charges once per composition, and a rerun charges nothing", async () => {
    const { company, ctx, design } = await shop();
    const set = await withTenant(company.id, (tx) => svc.createSet(tx, ctx, spec(design.id)));
    await renderAll(company.id, set.id);
    // Run every composition job again (a retried or duplicated job).
    for (const c of set.compositions)
      await runJobInline(renderCompositionJob, { companyId: company.id, compositionId: c.id });

    const ledger = await withTenant(company.id, (tx) =>
      tx.select().from(aiCreditLedger).where(eq(aiCreditLedger.refType, "photo_composition")),
    );
    expect(ledger).toHaveLength(8);
    expect(new Set(ledger.map((l) => l.refId)).size).toBe(8);
    expect(ledger.every((l) => l.kind === "photo_image" && l.credits === -1)).toBe(true);
    expect(imaging.photoRender).toHaveBeenCalledTimes(16);

    const after = await withTenant(company.id, (tx) => svc.getSet(tx, ctx, { id: set.id }));
    expect(after.status).toBe("ready");
    expect(after.counts.rendered).toBe(16);
    expect(after.creditsCharged).toBe(8);
    expect(after.compositions.every((c) => c.chargedAt && c.creditsCharged === 1)).toBe(true);
    const img = after.images.find((i) => i.preset === "amazon_main");
    expect(img?.key).toBe(`${company.id}/photos/${set.id}/${img?.id}.jpg`);
    expect(img?.url).toMatch(/^http/);
    expect(img?.checks?.failures.map((f) => f.code)).toEqual(["illustration_not_photo"]);
    // Real print size and the chosen hex went to imaging.
    const call0 = vi.mocked(imaging.photoRender).mock.calls.find((c) => c[0].placement === "back");
    expect(call0?.[0]).toMatchObject({ design_width_in: 11, design_height_in: 14 });
    const completed = await withTenant(company.id, (tx) =>
      tx.select().from(outboxEvents).where(eq(outboxEvents.name, "photo_set.completed")),
    );
    expect(completed).toHaveLength(1);
  });

  it("imaging down: images fail with a readable error, the set fails, nothing is charged", async () => {
    vi.spyOn(imaging, "photoRender").mockRejectedValue(
      new ImagingError("/photo/render", 0, "ECONNREFUSED"),
    );
    const { company, ctx, design } = await shop();
    const set = await withTenant(company.id, (tx) => svc.createSet(tx, ctx, spec(design.id)));
    await renderAll(company.id, set.id);
    const after = await withTenant(company.id, (tx) => svc.getSet(tx, ctx, { id: set.id }));
    expect(after.status).toBe("failed");
    expect(after.counts.failed).toBe(16);
    expect(after.images[0]?.error).toMatch(/not responding/);
    const ledger = await withTenant(company.id, (tx) => tx.select().from(aiCreditLedger));
    expect(ledger.filter((l) => l.refType === "photo_composition")).toHaveLength(0);
  });

  it("a transient error before the last attempt retries; a later success charges once", async () => {
    const { company, ctx, design } = await shop();
    const set = await withTenant(company.id, (tx) => svc.createSet(tx, ctx, spec(design.id)));
    const comp = set.compositions[0]?.id as string;
    vi.spyOn(imaging, "photoRender").mockRejectedValueOnce(
      new ImagingError("/photo/render", 503, "busy"),
    );
    await expect(
      runJobInline(
        renderCompositionJob,
        { companyId: company.id, compositionId: comp },
        { attempt: 1, attempts: 4 },
      ),
    ).rejects.toThrow();
    await runJobInline(
      renderCompositionJob,
      { companyId: company.id, compositionId: comp },
      { attempt: 2, attempts: 4 },
    );
    const after = await withTenant(company.id, (tx) => svc.getSet(tx, ctx, { id: set.id }));
    const imgs = after.images.filter((i) => i.compositionId === comp);
    expect(imgs.every((i) => i.status === "rendered")).toBe(true);
    expect(imgs.reduce((s, i) => s + i.creditsCharged, 0)).toBe(1);
    expect(after.status).toBe("rendering");
  });

  it("one failed image of many: the set ends ready with the failure counted", async () => {
    vi.spyOn(imaging, "photoRender").mockImplementation(async (i) => {
      if (
        i.preset === "etsy" &&
        i.view === "back" &&
        i.garment === "tee" &&
        i.blank_hex === "#000000"
      )
        throw new ImagingError("/photo/render", 422, "bad design");
      return renderOk(i);
    });
    const { company, ctx, design } = await shop();
    const set = await withTenant(company.id, (tx) => svc.createSet(tx, ctx, spec(design.id)));
    await renderAll(company.id, set.id);
    const after = await withTenant(company.id, (tx) => svc.getSet(tx, ctx, { id: set.id }));
    expect(after.status).toBe("ready");
    expect(after.counts.failed).toBe(1);
    expect(after.error).toMatch(/1 of 16/);
    expect(after.creditsCharged).toBe(8);
  });
});

async function readySet() {
  const s = await shop();
  const set = await withTenant(
    s.company.id,
    (tx) => s.ctx && svc.createSet(tx, s.ctx, spec(s.design.id)),
  );
  await renderAll(s.company.id, set.id);
  const full = await withTenant(s.company.id, (tx) => svc.getSet(tx, s.ctx, { id: set.id }));
  return { ...s, set: full };
}

describe("review, zip, attach", () => {
  it("approves and rejects; refuses images outside the set or not yet rendered; presser is FORBIDDEN", async () => {
    const { company, office, ctx, set } = await readySet();
    const [a, b, c, d] = set.images;
    const out = await withTenant(company.id, (tx) =>
      svc.reviewImages(tx, ctx, {
        setId: set.id,
        approve: [nn(a).id, nn(b).id],
        reject: [nn(c).id],
      }),
    );
    expect(out.counts.approved).toBe(2);
    expect(out.counts.rejected).toBe(1);
    expect(out.images.find((i) => i.id === nn(a).id)?.reviewedBy).toBe(office.id);

    await withTenant(company.id, (tx) =>
      tx
        .update(photoImages)
        .set({ status: "failed" })
        .where(eq(photoImages.id, nn(d).id)),
    );
    const notRev = await codeOf(
      withTenant(company.id, (tx) =>
        svc.reviewImages(tx, ctx, { setId: set.id, approve: [nn(d).id], reject: [] }),
      ),
    );
    expect(notRev).toMatchObject({
      code: "BAD_REQUEST",
      data: { reason: "not_reviewable", count: 1 },
    });
    const notIn = await codeOf(
      withTenant(company.id, (tx) =>
        svc.reviewImages(tx, ctx, { setId: set.id, approve: [crypto.randomUUID()], reject: [] }),
      ),
    );
    expect(notIn).toMatchObject({
      code: "BAD_REQUEST",
      data: { reason: "image_not_in_set", count: 1 },
    });

    const presser = await createUser(company.id, "presser");
    const forbidden = await codeOf(
      call(
        router.photos.reviewImages,
        { setId: set.id, approve: [nn(a).id], reject: [] },
        { context: userContext(company.id, presser.id, "presser") },
      ),
    );
    expect(forbidden.code).toBe("FORBIDDEN");
    const ok = (await call(
      router.photos.getSet,
      { id: set.id },
      { context: userContext(company.id, office.id, "office") },
    )) as { id: string };
    expect(ok.id).toBe(set.id);
  });

  it("zips only approved images, names them by channel/slot, and reuses an unchanged zip", async () => {
    const { company, ctx, set } = await readySet();
    const none = await codeOf(
      withTenant(company.id, (tx) => svc.exportZip(tx, ctx, { setId: set.id })),
    );
    expect(none).toMatchObject({
      code: "BAD_REQUEST",
      data: { reason: "not_approved", count: 16 },
    });

    const pick = set.images.filter((i) => i.channel === "etsy").slice(0, 3);
    await withTenant(company.id, (tx) =>
      svc.reviewImages(tx, ctx, { setId: set.id, approve: pick.map((i) => i.id), reject: [] }),
    );
    zipEnqueued.length = 0;
    const first = await withTenant(company.id, (tx) => svc.exportZip(tx, ctx, { setId: set.id }));
    expect(first.included).toBe(3);
    expect(first.excluded).toHaveLength(13);
    expect(zipEnqueued).toHaveLength(1);
    const job = { companyId: company.id, setId: set.id, zipJobId: first.jobId };
    await runJobInline(buildZipJob, job);
    await runJobInline(buildZipJob, job);
    expect(imaging.photoZip).toHaveBeenCalledTimes(1);
    const names = vi.mocked(imaging.photoZip).mock.calls[0]?.[0].items.map((i) => i.name) ?? [];
    expect(names).toHaveLength(3);
    for (const n of names)
      expect(n).toMatch(/^etsy\/\d{2}-(tee|hoodie)-(front_flat|back)-(black|sand)\.jpg$/);

    const again = await withTenant(company.id, (tx) => svc.exportZip(tx, ctx, { setId: set.id }));
    expect(again.jobId).toBe(first.jobId);
    expect(again.zip.status).toBe("ready");
    expect(zipEnqueued).toHaveLength(1);
    const full = await withTenant(company.id, (tx) => svc.getSet(tx, ctx, { id: set.id }));
    expect(full.zip.url).toMatch(/^http/);
    expect(full.zip.imageCount).toBe(3);
  });

  it("attaches approved images with template flags; excludes unapproved; a foreign draft is NOT_FOUND", async () => {
    const { company, ctx, set, design } = await readySet();
    const etsy = set.images.filter((i) => i.channel === "etsy").sort((a, b) => a.slot - b.slot);
    const amazon = set.images.find((i) => i.channel === "amazon");
    await withTenant(company.id, (tx) =>
      svc.reviewImages(tx, ctx, {
        setId: set.id,
        approve: [nn(etsy[0]).id, nn(etsy[1]).id, nn(amazon).id],
        reject: [],
      }),
    );
    const draftId = crypto.randomUUID();
    const draft = { id: draftId, designId: design.id, channel: "etsy", _company: company.id };
    fakeDrafts.set(draftId, draft as unknown as ListingDraft);
    attachCalls.length = 0;
    const res = await withTenant(company.id, (tx) =>
      svc.attachToDraft(tx, ctx, {
        setId: set.id,
        draftId,
        imageIds: [nn(etsy[0]).id, nn(etsy[1]).id, nn(etsy[2]).id, nn(amazon).id],
      }),
    );
    expect(res.attached).toBe(2);
    expect(res.excluded).toEqual(
      expect.arrayContaining([
        { imageId: nn(etsy[2]).id, reason: "not_approved" },
        { imageId: nn(amazon).id, reason: "channel_mismatch" },
      ]),
    );
    expect(attachCalls[0]).toEqual({
      draftId,
      imageKeys: [nn(etsy[0]).key, nn(etsy[1]).key],
      aiGenerated: false,
      syntheticPerformer: false,
    });

    const other = await shop();
    const foreignDraft = crypto.randomUUID();
    fakeDrafts.set(foreignDraft, {
      id: foreignDraft,
      designId: other.design.id,
      channel: "etsy",
      _company: other.company.id,
    } as unknown as ListingDraft);
    const err = await codeOf(
      withTenant(company.id, (tx) =>
        svc.attachToDraft(tx, ctx, {
          setId: set.id,
          draftId: foreignDraft,
          imageIds: [nn(etsy[0]).id],
        }),
      ),
    );
    expect(err.code).toBe("NOT_FOUND");
  });
});

describe("analysis", () => {
  it("enqueues, then caches; contrast warnings are computed in code; refresh supersedes the old job", async () => {
    const { company, ctx, design } = await shop();
    analysisEnqueued.length = 0;
    const first = await withTenant(company.id, (tx) =>
      svc.analyzeDesign(tx, ctx, { designId: design.id }),
    );
    expect(first.status).toBe("pending");
    expect(analysisEnqueued).toHaveLength(1);
    const again = await withTenant(company.id, (tx) =>
      svc.analyzeDesign(tx, ctx, { designId: design.id }),
    );
    expect(again).toEqual(first);
    expect(analysisEnqueued).toHaveLength(1);

    const jobId = first.status === "pending" ? first.jobId : "";
    const input = { companyId: company.id, designId: design.id, jobId, userId: ctx.userId };
    expect(await runJobInline(analyzeDesignJob, input)).toEqual({ status: "ready" });
    expect(await runJobInline(analyzeDesignJob, input)).toEqual({ status: "skipped" });
    const ready = await withTenant(company.id, (tx) =>
      svc.analyzeDesign(tx, ctx, { designId: design.id }),
    );
    expect(ready.status).toBe("ready");
    if (ready.status !== "ready") return;
    expect(ready.analysis.palette[0]).toEqual({ hex: "#fafafa", share: 0.7 });
    const white = ready.analysis.contrastWarnings.find((w) => w.blank.hex === "#ffffff");
    expect(white?.kind).toBe("light_on_light");
    expect(nn(white).ratio).toBeLessThan(1.2);
    expect(ready.analysis.contrastWarnings.some((w) => w.blank.hex === "#000000")).toBe(false);

    const refreshed = await withTenant(company.id, (tx) =>
      svc.analyzeDesign(tx, ctx, { designId: design.id, refresh: true }),
    );
    expect(refreshed.status).toBe("pending");
    expect(await runJobInline(analyzeDesignJob, input)).toEqual({ status: "skipped" });
  });

  it("imaging down on the last attempt marks the analysis failed with a readable error", async () => {
    vi.spyOn(imaging, "photoPalette").mockRejectedValue(
      new ImagingError("/photo/palette", 0, "down"),
    );
    const { company, ctx, design } = await shop();
    const r = await withTenant(company.id, (tx) =>
      svc.analyzeDesign(tx, ctx, { designId: design.id }),
    );
    const jobId = r.status === "pending" ? r.jobId : "";
    await runJobInline(analyzeDesignJob, {
      companyId: company.id,
      designId: design.id,
      jobId,
      userId: null,
    });
    const { photoAnalyses } = await import("../../db/schema");
    const [row] = await withTenant(company.id, (tx) =>
      tx
        .select()
        .from(photoAnalyses)
        .where(and(eq(photoAnalyses.designId, design.id))),
    );
    expect(row?.status).toBe("failed");
    expect(row?.error).toMatch(/not responding/);
  });
});

describe("tenancy", () => {
  it("another company gets NOT_FOUND for every procedure that takes an id, and sees none of the sets", async () => {
    const a = await readySet();
    const b = await shop();
    const bc = b.ctx;
    const img = nn(a.set.images[0]).id;
    const calls: [string, (tx: Tx) => Promise<unknown>][] = [
      ["analyzeDesign", (tx) => svc.analyzeDesign(tx, bc, { designId: a.design.id })],
      ["estimate", (tx) => svc.estimate(tx, bc, spec(a.design.id))],
      ["createSet", (tx) => svc.createSet(tx, bc, spec(a.design.id))],
      ["getSet", (tx) => svc.getSet(tx, bc, { id: a.set.id })],
      [
        "reviewImages",
        (tx) => svc.reviewImages(tx, bc, { setId: a.set.id, approve: [img], reject: [] }),
      ],
      ["exportZip", (tx) => svc.exportZip(tx, bc, { setId: a.set.id })],
      [
        "attachToDraft",
        (tx) =>
          svc.attachToDraft(tx, bc, {
            setId: a.set.id,
            draftId: crypto.randomUUID(),
            imageIds: [img],
          }),
      ],
    ];
    for (const [name, fn] of calls) {
      const err = await codeOf(withTenant(b.company.id, fn));
      expect(err.code, name).toBe("NOT_FOUND");
    }
    const list = await withTenant(b.company.id, (tx) => svc.listSets(tx, bc, { limit: 50 }));
    expect(list.items).toHaveLength(0);
    // A's images are untouched by B's attempts.
    const still = await withTenant(a.company.id, (tx) => svc.getSet(tx, a.ctx, { id: a.set.id }));
    expect(still.counts.approved).toBe(0);
  });

  it("listSets signs only the lead image; getSet never signs a key outside the company prefix", async () => {
    const { company, ctx, set } = await readySet();
    const list = await withTenant(company.id, (tx) =>
      svc.listSets(tx, ctx, { limit: 10, designId: set.designId }),
    );
    expect(list.items).toHaveLength(1);
    expect(list.items[0]?.leadImageUrl).toMatch(/^http/);
    expect(list.items[0]?.counts.total).toBe(16);
    expect("images" in (list.items[0] ?? {})).toBe(false);

    const victim = nn(set.images[1]);
    await withTenant(company.id, (tx) =>
      tx
        .update(photoImages)
        .set({ key: `${crypto.randomUUID()}/photos/x/y.jpg` })
        .where(eq(photoImages.id, victim.id)),
    );
    const full = await withTenant(company.id, (tx) => svc.getSet(tx, ctx, { id: set.id }));
    expect(full.images.find((i) => i.id === victim.id)?.url).toBeNull();
  });
});
