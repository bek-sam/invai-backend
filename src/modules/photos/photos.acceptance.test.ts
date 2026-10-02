import type { DesignPhotoAnalysis, ListingDraft } from "@invai/contracts";
import { call, ORPCError } from "@orpc/server";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { chargeCredits, creditBalance } from "../../ai/credits";
import { anonymousContext, type Context, permissionsFor } from "../../api/context";
import { router } from "../../api/router";
import { type Tx, withTenant } from "../../db/client";
import { aiCreditLedger, photoSets } from "../../db/schema";
import { ImagingError, imaging } from "../../integrations/imaging/client";
import { runJobInline } from "../../lib/queues";
import { createCompany, createUser, tenantContext } from "../../test/fixtures";
import { createDesign } from "../catalog/service";
import { analyzeDesignJob, renderCompositionJob } from "./jobs";
import * as svc from "./service";

/*
 * T-26-4 acceptance tests (qa-engineer, independent of the author's own photos.test.ts). Written
 * from the task card's ACs 2-8 and spec/listing-photos.md, through the service/router as the
 * role, with a fake imaging client (same seam the module's unit tests use: vi.spyOn on the real
 * `imaging` client object, since this feature never calls a real marketplace or AI provider in
 * tests). Covers: analyze pending->ready (AC2), estimate/createSet (AC3), one-charge-per-
 * composition on a retried job (AC4), the credits-exhausted-before-any-row rule (AC4), the
 * approval gate for zip/attach (AC5/AC6), attach flags and keys (AC7), and signed-URL scoping
 * (AC8) — plus role access (office allowed, presser FORBIDDEN, another company NOT_FOUND).
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
      style: "QA fixture style",
      audience: "QA fixture audience",
      detectedText: null,
      colorDescription: "light art",
      recommendedColors: [
        { name: "White", hex: "#ffffff", reason: "classic" },
        { name: "Black", hex: "#000000", reason: "contrast" },
      ],
      contrastWarnings: [],
      sceneSuggestions: [],
      altText: { amazon: "QA fixture alt text" },
      imageOrder: {},
      creditsUsed: 1,
      analyzedAt: new Date().toISOString(),
    }),
  ),
}));

vi.mock("../ai/photo-attach", () => ({
  attachPhotosToDraft: vi.fn(async (_tx: Tx, _ctx: unknown, input: { draftId: string }) => {
    attachCalls.push(input);
    const d = fakeDrafts.get(input.draftId);
    if (!d) throw new Error("unexpected draft in QA acceptance fixture");
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

const analysisEnqueued: unknown[] = [];
const zipEnqueued: unknown[] = [];

/** The fake imaging client: real-size, real-hex render that always succeeds unless overridden. */
function renderOk(input: { out_key: string; preset: string }) {
  return Promise.resolve({
    key: input.out_key,
    width_px: 2000,
    height_px: 2000,
    format: "jpeg" as const,
    print_box_px: [600, 500, 800, 960] as [number, number, number, number],
    checks: {
      passes: true,
      failures: [] as string[],
      background_pure_white: true,
      fill_ratio: 0.9,
      longest_side_px: 2000,
    },
  });
}

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

async function shop() {
  const company = await createCompany();
  const office = await createUser(company.id, "office");
  const ctx = tenantContext(company.id, office.id, "office");
  const design = await withTenant(company.id, (tx) =>
    createDesign(tx, ctx, {
      code: `QA${Math.floor(Math.random() * 1e6)}`,
      name: "QA Fixture Design",
      tags: ["qa"],
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
  return { company, office, ctx, design };
}

const spec = (designId: string, key = `qa-key-${crypto.randomUUID()}`) => ({
  designId,
  garments: ["tee", "hoodie"] as ("tee" | "hoodie")[],
  colors: [
    { name: "Black", hex: "#000000" },
    { name: "White", hex: "#ffffff" },
  ],
  views: ["front_flat", "back"] as ("front_flat" | "back")[],
  channels: ["amazon", "etsy"] as ("amazon" | "etsy")[],
  underbasePreview: true,
  idempotencyKey: key,
});

async function renderAll(companyId: string, setId: string) {
  for (const compositionId of await svc.openCompositions(companyId, setId))
    await runJobInline(renderCompositionJob, { companyId, compositionId });
}

async function readySet() {
  const s = await shop();
  const set = await withTenant(s.company.id, (tx) => svc.createSet(tx, s.ctx, spec(s.design.id)));
  await renderAll(s.company.id, set.id);
  const full = await withTenant(s.company.id, (tx) => svc.getSet(tx, s.ctx, { id: set.id }));
  return { ...s, set: full };
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
  vi.spyOn(imaging, "photoZip").mockImplementation(async (i) => ({ key: i.out_key, bytes: 999 }));
  vi.spyOn(imaging, "photoPalette").mockResolvedValue({
    colors: [{ hex: "#fafafa", share: 0.8 }],
    light_share: 0.9,
    dark_share: 0.01,
    transparent_share: 0.1,
  });
  analysisEnqueued.length = 0;
  zipEnqueued.length = 0;
  attachCalls.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AC2: analyzeDesign is pending, then ready via the job, with contrast warnings computed in code", () => {
  it("enqueues once, caches while pending, then the job produces a ready analysis", async () => {
    const { company, ctx, design } = await shop();
    const first = await withTenant(company.id, (tx) =>
      svc.analyzeDesign(tx, ctx, { designId: design.id }),
    );
    expect(first.status).toBe("pending");
    expect(analysisEnqueued).toHaveLength(1);

    // Calling again while pending doesn't enqueue a second job.
    const again = await withTenant(company.id, (tx) =>
      svc.analyzeDesign(tx, ctx, { designId: design.id }),
    );
    expect(again).toEqual(first);
    expect(analysisEnqueued).toHaveLength(1);

    const jobId = first.status === "pending" ? first.jobId : "";
    const result = await runJobInline(analyzeDesignJob, {
      companyId: company.id,
      designId: design.id,
      jobId,
      userId: ctx.userId,
    });
    expect(result).toEqual({ status: "ready" });

    const ready = await withTenant(company.id, (tx) =>
      svc.analyzeDesign(tx, ctx, { designId: design.id }),
    );
    expect(ready.status).toBe("ready");
    if (ready.status !== "ready") return;
    // The warning is computed from the imaging palette against the recommended/shop blanks, not
    // claimed by the mocked AI route (which returned contrastWarnings: []).
    const white = ready.analysis.contrastWarnings.find((w) => w.blank.hex === "#ffffff");
    expect(white).toBeDefined();
    expect(white?.kind).toBe("light_on_light");
    expect(typeof white?.ratio).toBe("number");
  });

  it("another company's design id is NOT_FOUND", async () => {
    const { design } = await shop();
    const other = await createCompany();
    const otherCtx = tenantContext(other.id, (await createUser(other.id, "office")).id, "office");
    const err = await codeOf(
      withTenant(other.id, (tx) => svc.analyzeDesign(tx, otherCtx, { designId: design.id })),
    );
    expect(err.code).toBe("NOT_FOUND");
  });
});

describe("AC3: estimate counts and createSet", () => {
  it("estimate counts compositions, images and credits for the chosen spec", async () => {
    const { company, ctx, design } = await shop();
    const est = await withTenant(company.id, (tx) => svc.estimate(tx, ctx, spec(design.id)));
    // 2 garments x 2 colors x 1 view (front_flat; back is skipped: no back file) = 4 compositions.
    expect(est.compositions).toBe(4);
    expect(est.images).toBe(est.compositions * 2); // 2 channels
    expect(est.credits).toBe(4);
    expect(est.canAfford).toBe(true);
    expect(est.skipped.filter((s) => s.reason === "no_back_print_file")).toHaveLength(2);
  });

  it("createSet is idempotent on idempotencyKey: same key returns the same set, no second job", async () => {
    const { company, ctx, design } = await shop();
    const input = spec(design.id);
    const a = await withTenant(company.id, (tx) => svc.createSet(tx, ctx, input));
    const b = await withTenant(company.id, (tx) => svc.createSet(tx, ctx, input));
    expect(b.id).toBe(a.id);
    expect(a.status).toBe("queued");
    expect(imaging.photoRender).not.toHaveBeenCalled(); // createSet only enqueues
    const rows = await withTenant(company.id, (tx) =>
      tx.select().from(photoSets).where(eq(photoSets.companyId, company.id)),
    );
    expect(rows).toHaveLength(1); // the second call created no extra row
  });
});

describe("AC4: CREDITS_EXHAUSTED refuses before any row is written", () => {
  it("createSet throws CREDITS_EXHAUSTED and leaves no photo_sets row", async () => {
    const { company, ctx, design } = await shop();
    await withTenant(company.id, async (tx) => {
      const b = await creditBalance(tx, company.id);
      // Spend the balance down to less than the 4-credit estimate for this spec.
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
    const rows = await withTenant(company.id, (tx) =>
      tx.select().from(photoSets).where(eq(photoSets.companyId, company.id)),
    );
    expect(rows).toHaveLength(0);
  });
});

describe("AC4/9: a render job run twice charges a composition exactly once", () => {
  it("retrying (or duplicating) the render job for the same composition charges one ledger row", async () => {
    const { company, ctx, design } = await shop();
    const set = await withTenant(company.id, (tx) => svc.createSet(tx, ctx, spec(design.id)));
    const compositionIds = set.compositions.map((c) => c.id);

    // First pass renders everything; second pass simulates a crash/redelivery retry.
    for (const compositionId of compositionIds)
      await runJobInline(renderCompositionJob, { companyId: company.id, compositionId });
    for (const compositionId of compositionIds)
      await runJobInline(renderCompositionJob, { companyId: company.id, compositionId });

    const ledger = await withTenant(company.id, (tx) =>
      tx.select().from(aiCreditLedger).where(eq(aiCreditLedger.refType, "photo_composition")),
    );
    expect(ledger).toHaveLength(compositionIds.length);
    expect(new Set(ledger.map((l) => l.refId)).size).toBe(compositionIds.length);

    const after = await withTenant(company.id, (tx) => svc.getSet(tx, ctx, { id: set.id }));
    expect(after.status).toBe("ready");
    expect(after.creditsCharged).toBe(compositionIds.length);
  });

  it("imaging down: images fail readably, the set still finishes, and nothing is charged", async () => {
    vi.spyOn(imaging, "photoRender").mockRejectedValue(
      new ImagingError("/photo/render", 0, "ECONNREFUSED"),
    );
    const { company, ctx, design } = await shop();
    const set = await withTenant(company.id, (tx) => svc.createSet(tx, ctx, spec(design.id)));
    await renderAll(company.id, set.id);
    const after = await withTenant(company.id, (tx) => svc.getSet(tx, ctx, { id: set.id }));
    expect(after.status).toBe("failed");
    expect(after.images[0]?.status).toBe("failed");
    expect(after.images[0]?.error).toBeTruthy();
    const ledger = await withTenant(company.id, (tx) =>
      tx.select().from(aiCreditLedger).where(eq(aiCreditLedger.refType, "photo_composition")),
    );
    expect(ledger).toHaveLength(0);
  });
});

describe("AC5/AC6: approval gates zip and attach", () => {
  it("exportZip refuses naming the count still waiting; succeeds for approved images only", async () => {
    const { company, ctx, set } = await readySet();
    const none = await codeOf(
      withTenant(company.id, (tx) => svc.exportZip(tx, ctx, { setId: set.id })),
    );
    expect(none).toMatchObject({
      code: "BAD_REQUEST",
      data: { reason: "not_approved", count: set.images.length },
    });

    const pick = set.images.slice(0, 2);
    await withTenant(company.id, (tx) =>
      svc.reviewImages(tx, ctx, { setId: set.id, approve: pick.map((i) => i.id), reject: [] }),
    );
    const ok = await withTenant(company.id, (tx) => svc.exportZip(tx, ctx, { setId: set.id }));
    expect(ok.included).toBe(2);
    expect(ok.excluded).toHaveLength(set.images.length - 2);
  });

  it("attachToDraft refuses when nothing is approved, naming the count; succeeds for approved images", async () => {
    const { company, ctx, set, design } = await readySet();
    const draftId = crypto.randomUUID();
    fakeDrafts.set(draftId, {
      id: draftId,
      designId: design.id,
      channel: "etsy",
      _company: company.id,
    } as unknown as ListingDraft);
    const etsy = set.images.filter((i) => i.channel === "etsy");
    const refused = await codeOf(
      withTenant(company.id, (tx) =>
        svc.attachToDraft(tx, ctx, {
          setId: set.id,
          draftId,
          imageIds: etsy.map((i) => i.id),
        }),
      ),
    );
    expect(refused).toMatchObject({
      code: "BAD_REQUEST",
      data: { reason: "not_approved", count: etsy.length },
    });

    await withTenant(company.id, (tx) =>
      svc.reviewImages(tx, ctx, {
        setId: set.id,
        approve: [nn(etsy[0]).id],
        reject: [],
      }),
    );
    const res = await withTenant(company.id, (tx) =>
      svc.attachToDraft(tx, ctx, { setId: set.id, draftId, imageIds: [nn(etsy[0]).id] }),
    );
    expect(res.attached).toBe(1);
  });
});

describe("AC7: attach sends the approved images' keys with phase-A flags false/false", () => {
  it("passes imageKeys and aiGenerated=false, syntheticPerformer=false for drawn-template images", async () => {
    const { company, ctx, set, design } = await readySet();
    const img = nn(set.images[0]);
    await withTenant(company.id, (tx) =>
      svc.reviewImages(tx, ctx, { setId: set.id, approve: [img.id], reject: [] }),
    );
    const draftId = crypto.randomUUID();
    fakeDrafts.set(draftId, {
      id: draftId,
      designId: design.id,
      channel: img.channel,
      _company: company.id,
    } as unknown as ListingDraft);
    await withTenant(company.id, (tx) =>
      svc.attachToDraft(tx, ctx, { setId: set.id, draftId, imageIds: [img.id] }),
    );
    expect(attachCalls).toHaveLength(1);
    expect(attachCalls[0]).toEqual({
      draftId,
      imageKeys: [img.key],
      aiGenerated: false,
      syntheticPerformer: false,
    });
  });

  it("another company's draft id is NOT_FOUND", async () => {
    const { company, ctx, set } = await readySet();
    const img = nn(set.images[0]);
    await withTenant(company.id, (tx) =>
      svc.reviewImages(tx, ctx, { setId: set.id, approve: [img.id], reject: [] }),
    );
    const other = await shop();
    const foreignDraft = crypto.randomUUID();
    fakeDrafts.set(foreignDraft, {
      id: foreignDraft,
      designId: other.design.id,
      channel: img.channel,
      _company: other.company.id,
    } as unknown as ListingDraft);
    const err = await codeOf(
      withTenant(company.id, (tx) =>
        svc.attachToDraft(tx, ctx, { setId: set.id, draftId: foreignDraft, imageIds: [img.id] }),
      ),
    );
    expect(err.code).toBe("NOT_FOUND");
  });
});

describe("AC8: signed URLs never cross a company prefix, and listSets signs only the lead image", () => {
  it("getSet returns null for an image key outside the caller's company prefix", async () => {
    const { company, ctx, set } = await readySet();
    const { photoImages } = await import("../../db/schema");
    const victim = nn(set.images[1]);
    await withTenant(company.id, (tx) =>
      tx
        .update(photoImages)
        .set({ key: `${crypto.randomUUID()}/photos/leaked/x.jpg` })
        .where(eq(photoImages.id, victim.id)),
    );
    const after = await withTenant(company.id, (tx) => svc.getSet(tx, ctx, { id: set.id }));
    expect(after.images.find((i) => i.id === victim.id)?.url).toBeNull();
  });

  it("listSets signs only the lead (slot-0) image per set, not every image", async () => {
    const { company, ctx, set } = await readySet();
    const list = await withTenant(company.id, (tx) =>
      svc.listSets(tx, ctx, { limit: 10, designId: set.designId }),
    );
    expect(list.items).toHaveLength(1);
    expect(list.items[0]?.leadImageUrl).toMatch(/^http/);
    expect("images" in (list.items[0] ?? {})).toBe(false);
  });
});

describe("Role access: office allowed, presser FORBIDDEN, another company's id is NOT_FOUND", () => {
  it("an office user can call photos.estimate through the router", async () => {
    const { company, office, design } = await shop();
    const ctx = userContext(company.id, office.id, "office");
    const est = (await call(router.photos.estimate, spec(design.id), { context: ctx })) as {
      compositions: number;
    };
    expect(est.compositions).toBeGreaterThan(0);
  });

  it("a presser is FORBIDDEN from photos.estimate and photos.createSet", async () => {
    const { company, design } = await shop();
    const presser = await createUser(company.id, "presser");
    const ctx = userContext(company.id, presser.id, "presser");
    const estErr = await codeOf(call(router.photos.estimate, spec(design.id), { context: ctx }));
    expect(estErr.code).toBe("FORBIDDEN");
    const createErr = await codeOf(
      call(router.photos.createSet, spec(design.id), { context: ctx }),
    );
    expect(createErr.code).toBe("FORBIDDEN");
  });

  it("another company's set id is NOT_FOUND through the router, never another tenant's data", async () => {
    const { set } = await readySet();
    const other = await shop();
    const ctx = userContext(other.company.id, other.office.id, "office");
    const err = await codeOf(call(router.photos.getSet, { id: set.id }, { context: ctx }));
    expect(err.code).toBe("NOT_FOUND");
  });
});
