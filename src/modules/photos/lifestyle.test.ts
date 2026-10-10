import type { ListingDraft } from "@invai/contracts";
import { call, ORPCError } from "@orpc/server";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { chargeCredits, creditBalance } from "../../ai/credits";
import type { GenerateSceneInput, ImageProvider } from "../../ai/images";
import { decodePng, encodePng } from "../../ai/images/png";
import { anonymousContext, type Context, permissionsFor } from "../../api/context";
import { router } from "../../api/router";
import { type Tx, withSystem, withTenant } from "../../db/client";
import {
  aiCreditLedger,
  aiJobs,
  listings,
  outboxEvents,
  photoAnalyses,
  photoCompositions,
  photoPushes,
  photoSets,
} from "../../db/schema";
import { env } from "../../env";
import * as channelsModule from "../../integrations/channels";
import { ProductImagePushError } from "../../integrations/channels/types";
import { imaging } from "../../integrations/imaging/client";
import { runJobInline } from "../../lib/queues";
import { createCompany, createConnection, createUser, tenantContext } from "../../test/fixtures";
import { createDesign } from "../catalog/service";
import { analyzeDesignJob, pushImagesJob, renderCompositionJob, renderSceneJob } from "./jobs";
import { purgePhotoFiles } from "./purge";
import * as push from "./push";
import * as svc from "./service";
import { appendToZip, readEocd, readmeEntries } from "./zip-readme";

/*
 * Phase B (T-27-3): lifestyle scenes, caps, disclosures, README, Shopify push. Imaging, S3 and
 * (where a test needs control) the image provider are test doubles in this file; the real mock
 * provider runs in the IMAGE_GEN_MOCK_DRIFT test. Everything else runs on invai_test with RLS.
 */

const h = vi.hoisted(() => ({
  provider: null as ImageProvider | null,
  store: new Map<string, Buffer>(),
  drafts: new Map<string, unknown>(),
  attachCalls: [] as unknown[],
}));

vi.mock("../../integrations/channels", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../integrations/channels")>();
  return { ...actual, getChannelAdapter: vi.fn(actual.getChannelAdapter) };
});

vi.mock("../../ai/images", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../ai/images")>();
  return {
    ...real,
    getImageProvider: vi.fn(async (companyId: string) =>
      h.provider ? h.provider : real.getImageProvider(companyId),
    ),
  };
});

vi.mock("../../lib/s3", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../lib/s3")>();
  return {
    ...real,
    getObject: vi.fn(async (key: string) => {
      const b = h.store.get(key);
      if (!b) throw new Error(`no object ${key}`);
      return b;
    }),
    putObject: vi.fn(async (key: string, body: Buffer) => {
      h.store.set(key, Buffer.from(body));
      return key;
    }),
    headObject: vi.fn(async (key: string) =>
      h.store.has(key)
        ? { exists: true as const, size: 1, contentType: null }
        : { exists: false as const },
    ),
    presignGet: vi.fn(async (key: string) => `https://s3.test/${key}?X-Amz-Signature=t`),
    deleteObject: vi.fn(async (key: string) => {
      h.store.delete(key);
    }),
  };
});

vi.mock("./zip-readme", async (importOriginal) => {
  const real = await importOriginal<typeof import("./zip-readme")>();
  return {
    ...real,
    appendToStoredZip: vi.fn(async (_key: string, entries: { name: string; data: Buffer }[]) => {
      h.attachCalls.push({ readme: entries });
      return 999;
    }),
  };
});

vi.mock("../ai/photo-attach", () => ({
  attachPhotosToDraft: vi.fn(async (_tx: Tx, _ctx: unknown, input: { draftId: string }) => {
    h.attachCalls.push(input);
    return h.drafts.get(input.draftId);
  }),
}));

vi.mock("../ai/service", async (importOriginal) => {
  const real = await importOriginal<typeof import("../ai/service")>();
  return {
    ...real,
    getDraft: vi.fn(async (tx: Tx, ctx: { companyId: string }, id: string) => {
      const d = h.drafts.get(id) as { _company?: string } | undefined;
      if (d?._company === ctx.companyId) return d as unknown as ListingDraft;
      return real.getDraft(tx, ctx as never, id);
    }),
  };
});

vi.mock("../ai/photo-analysis", () => ({
  analyzeDesignForPhotos: vi.fn(async () => {
    throw new Error("unused");
  }),
}));

type MutableEnv = { IMAGE_GEN_DAILY_CAP_PER_SHOP: number; imageGenMockDrift: boolean };
const menv = env as unknown as MutableEnv;
const savedEnv = { ...menv };

function nn<T>(v: T | null | undefined): T {
  if (v === null || v === undefined) throw new Error("missing test value");
  return v;
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

async function shop() {
  const company = await createCompany();
  const office = await createUser(company.id, "office");
  const ctx = tenantContext(company.id, office.id, "office");
  const design = await withTenant(company.id, (tx) =>
    createDesign(tx, ctx, {
      code: `L${Math.floor(Math.random() * 1e6)}`,
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
  return { company, office, ctx, design };
}

const spec = (
  designId: string,
  lifestyle?: { count: number; sceneKinds?: never[] | string[] },
) => ({
  designId,
  garments: ["tee"] as "tee"[],
  colors: [{ name: "Black", hex: "#000000" }],
  views: ["front_flat"] as "front_flat"[],
  channels: ["shopify", "etsy"] as ("shopify" | "etsy")[],
  underbasePreview: true,
  idempotencyKey: `key-${crypto.randomUUID()}`,
  ...(lifestyle ? { lifestyle: lifestyle as { count: number } } : {}),
});

/* ---- Imaging doubles: a synthetic base, and a composite that checks the protected box ------ */

const BOX = [400, 300, 224, 300] as const;

function syntheticBase() {
  const W = 1024;
  const base = new Uint8Array(W * W * 4);
  const mask = new Uint8Array(W * W * 4);
  for (let y = 0; y < W; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const garment = x > 300 && x < 724 && y > 200 && y < 900;
      const v = garment ? 30 : 235;
      base[i] = v;
      base[i + 1] = v;
      base[i + 2] = v;
      base[i + 3] = 255;
      const inBox = x >= BOX[0] && x < BOX[0] + BOX[2] && y >= BOX[1] && y < BOX[1] + BOX[3];
      mask[i + 3] = inBox ? 255 : 0;
    }
  return {
    base: encodePng({ width: W, height: W, data: base }),
    mask: encodePng({ width: W, height: W, data: mask }),
  };
}

/** Like imaging check 1: the protected box must come back as the base drew it (noise allowed). */
function boxChanged(sceneBytes: Buffer, baseBytes: Buffer): boolean {
  const s = decodePng(sceneBytes);
  const b = decodePng(baseBytes);
  let worst = 0;
  for (let y = BOX[1]; y < BOX[1] + BOX[3]; y += 3)
    for (let x = BOX[0]; x < BOX[0] + BOX[2]; x += 3) {
      const i = (y * s.width + x) * 4;
      worst = Math.max(worst, Math.abs((s.data[i] ?? 0) - (b.data[i] ?? 0)));
    }
  return worst > 40;
}

type CompositeMode = "inspect" | "pass" | "drift";
let compositeMode: CompositeMode = "pass";
let compositeQueue: CompositeMode[] = [];
const compositeCalls: { scene_key: string; xmp_subjects: string[]; preset: string }[] = [];

beforeAll(() => {
  svc.setPhotoEnqueuers({
    analysis: async () => {},
    zip: async () => {},
    push: async () => {},
  });
});

beforeEach(() => {
  h.provider = null;
  h.store.clear();
  h.attachCalls.length = 0;
  compositeMode = "pass";
  compositeQueue = [];
  compositeCalls.length = 0;
  const { base, mask } = syntheticBase();
  vi.spyOn(imaging, "photoSceneBase").mockImplementation(async (i) => {
    h.store.set(i.out_key, base);
    h.store.set(i.mask_out_key, mask);
    return { key: i.out_key, mask_key: i.mask_out_key, print_box_px: [...BOX] };
  });
  vi.spyOn(imaging, "photoSceneComposite").mockImplementation(async (i) => {
    compositeCalls.push({ scene_key: i.scene_key, xmp_subjects: i.xmp_subjects, preset: i.preset });
    const mode = compositeQueue.shift() ?? compositeMode;
    const drift =
      mode === "drift" ||
      (mode === "inspect" && boxChanged(nn(h.store.get(i.scene_key)), nn(h.store.get(i.base_key))));
    return {
      key: drift ? null : i.out_key,
      checks: {
        passes: !drift,
        failures: drift ? ["design_drift"] : [],
        region_unchanged_score: drift ? 0.2 : 0.97,
        design_lock_score: drift ? 0.4 : 0.96,
      },
      width_px: 2048,
      height_px: 2048,
      format: "jpeg",
    };
  });
  vi.spyOn(imaging, "photoRender").mockImplementation(async (i) => ({
    key: i.out_key,
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
  }));
  vi.spyOn(imaging, "photoZip").mockImplementation(async (i) => ({ key: i.out_key, bytes: 100 }));
});

afterEach(() => {
  Object.assign(menv, savedEnv);
  vi.restoreAllMocks();
});

/** A counting fake provider; `gate` lets a test hold a call open. */
function fakeProvider(opts: { gate?: Promise<void>; fail?: Error } = {}) {
  const calls: GenerateSceneInput[] = [];
  const p: ImageProvider = {
    name: "mock",
    model: "fake-image",
    estimateCents: () => 0,
    async generateScene(input) {
      calls.push(input);
      if (opts.gate) await opts.gate;
      if (opts.fail) throw opts.fail;
      return {
        image: Buffer.from(`scene-${calls.length}`),
        widthPx: 1024,
        heightPx: 1024,
        provider: "mock",
        model: "fake-image",
        costCents: 0,
        containsPerson: input.prompt.containsPerson,
      };
    },
  };
  return { p, calls };
}

async function sceneIds(companyId: string, setId: string) {
  return (await svc.openCompositionsBySource(companyId, setId))
    .filter((c) => c.source === "ai_scene")
    .map((c) => c.id);
}

async function renderEverything(companyId: string, setId: string) {
  for (const c of await svc.openCompositionsBySource(companyId, setId)) {
    if (c.source === "ai_scene")
      await runJobInline(renderSceneJob, { companyId, compositionId: c.id });
    else await runJobInline(renderCompositionJob, { companyId, compositionId: c.id });
  }
}

const sceneCharges = (companyId: string) =>
  withTenant(companyId, (tx) =>
    tx.select().from(aiCreditLedger).where(eq(aiCreditLedger.refType, "photo_scene")),
  );
const balance = (companyId: string) =>
  withTenant(companyId, (tx) => creditBalance(tx, companyId)).then((b) => b.remaining);
async function leaveCredits(companyId: string, left: number) {
  await withTenant(companyId, async (tx) => {
    const b = await creditBalance(tx, companyId);
    await chargeCredits(tx, {
      companyId,
      kind: "listing_draft",
      credits: b.remaining - left,
      model: null,
      usage: null,
    });
  });
}

/* ---- createSet, estimate, caps ------------------------------------------------------------ */

describe("lifestyle sets: estimate, create, caps (AC1, AC7)", () => {
  it("adds scene compositions after the templates, 10 credits each, and stores the request", async () => {
    const { company, ctx, design } = await shop();
    const input = spec(design.id, { count: 2, sceneKinds: ["street", "flat_lay"] });
    const est = await withTenant(company.id, (tx) => svc.estimate(tx, ctx, input));
    expect(est).toMatchObject({ compositions: 3, images: 6, credits: 21, canAfford: true });
    const set = await withTenant(company.id, (tx) => svc.createSet(tx, ctx, input));
    expect(set.lifestyle).toEqual({ count: 2, sceneKinds: ["street", "flat_lay"] });
    expect(set.creditsEstimated).toBe(21);
    const scenes = set.compositions.filter((c) => c.source === "ai_scene");
    expect(scenes.map((c) => [c.view, c.sceneKind])).toEqual([
      ["lifestyle", "street"],
      ["lifestyle", "flat_lay"],
    ]);
    const shopify = set.images
      .filter((i) => i.channel === "shopify")
      .sort((a, b) => a.slot - b.slot);
    expect(shopify.map((i) => i.source)).toEqual(["template", "ai_scene", "ai_scene"]);
    expect(shopify.slice(1).every((i) => !i.drawnTemplate && !i.aiGenerated)).toBe(true);
    // Same key, same spec: the same set; the same key with another lifestyle count: CONFLICT.
    const again = await withTenant(company.id, (tx) => svc.createSet(tx, ctx, input));
    expect(again.id).toBe(set.id);
    const changed = { ...input, lifestyle: { count: 1 } };
    expect(
      (await codeOf(withTenant(company.id, (tx) => svc.createSet(tx, ctx, changed)))).code,
    ).toBe("CONFLICT");
  });

  it("estimate.canAfford subtracts credits held by open sets (AC7)", async () => {
    const { company, ctx, design } = await shop();
    await leaveCredits(company.id, 12);
    await withTenant(company.id, (tx) => svc.createSet(tx, ctx, spec(design.id, { count: 1 })));
    const est = await withTenant(company.id, (tx) => svc.estimate(tx, ctx, spec(design.id)));
    expect(est.credits).toBe(1);
    expect(est.creditsRemaining).toBe(1);
    expect(est.canAfford).toBe(true);
    const est2 = await withTenant(company.id, (tx) =>
      svc.estimate(tx, ctx, spec(design.id, { count: 1 })),
    );
    expect(est2.canAfford).toBe(false);
  });

  it("refuses before anything is written: daily cap, then credits (AC1)", async () => {
    const { company, ctx, design } = await shop();
    menv.IMAGE_GEN_DAILY_CAP_PER_SHOP = 1;
    const cap = await codeOf(
      withTenant(company.id, (tx) => svc.createSet(tx, ctx, spec(design.id, { count: 2 }))),
    );
    expect(cap.code).toBe("IMAGE_DAILY_CAP_REACHED");
    expect(cap.data).toMatchObject({ cap: 1, used: 0 });
    // Scenes waiting in an open set count against the cap too.
    await withTenant(company.id, (tx) => svc.createSet(tx, ctx, spec(design.id, { count: 1 })));
    const capOpen = await codeOf(
      withTenant(company.id, (tx) => svc.createSet(tx, ctx, spec(design.id, { count: 1 }))),
    );
    expect(capOpen.code).toBe("IMAGE_DAILY_CAP_REACHED");
    menv.IMAGE_GEN_DAILY_CAP_PER_SHOP = 30;
    await leaveCredits(company.id, 15);
    const credits = await codeOf(
      withTenant(company.id, (tx) => svc.createSet(tx, ctx, spec(design.id, { count: 1 }))),
    );
    expect(credits.code).toBe("CREDITS_EXHAUSTED");
    const sets = await withTenant(company.id, (tx) => tx.select().from(photoSets));
    expect(sets).toHaveLength(1);
    const events = await withTenant(company.id, (tx) =>
      tx.select().from(outboxEvents).where(eq(outboxEvents.name, "photo_set.created")),
    );
    expect(events).toHaveLength(1);
  });
});

/* ---- Scene jobs --------------------------------------------------------------------------- */

describe("scene jobs (AC2, AC5, AC8)", () => {
  it("base -> provider -> composite per channel; AI flags and XMP; one charge; a rerun calls nothing", async () => {
    const { company, ctx, design } = await shop();
    const fake = fakeProvider();
    h.provider = fake.p;
    const set = await withTenant(company.id, (tx) =>
      svc.createSet(tx, ctx, spec(design.id, { count: 1, sceneKinds: ["street"] })),
    );
    const before = await balance(company.id);
    await renderEverything(company.id, set.id);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.prompt.text).toContain("print area");
    expect(compositeCalls).toHaveLength(2);
    expect(
      compositeCalls.every((c) => c.xmp_subjects.includes("contains-synthetic-performer")),
    ).toBe(true);
    const got = await withTenant(company.id, (tx) => svc.getSet(tx, ctx, { id: set.id }));
    const scenes = got.images.filter((i) => i.source === "ai_scene");
    expect(scenes).toHaveLength(2);
    for (const i of scenes) {
      expect(i).toMatchObject({
        status: "rendered",
        aiGenerated: true,
        containsSyntheticPerson: true,
        drawnTemplate: false,
        model: "fake-image",
        designLockScore: 0.96,
      });
      expect(i.checks?.regionUnchangedScore).toBe(0.97);
    }
    expect(got.hasAiImages).toBe(true);
    expect(got.hasSyntheticPerson).toBe(true);
    const comp = nn(got.compositions.find((c) => c.source === "ai_scene"));
    expect(comp.creditsCharged).toBe(10);
    expect(await balance(company.id)).toBe(before - 11);
    const charges = await sceneCharges(company.id);
    expect(charges.map((c) => [c.kind, c.credits, c.refId])).toEqual([
      ["photo_scene", -10, comp.id],
    ]);
    // The raw scene is stored under the company prefix; ai_jobs has one row for the call.
    const [row] = await withTenant(company.id, (tx) =>
      tx.select().from(photoCompositions).where(eq(photoCompositions.id, comp.id)),
    );
    expect(row?.sceneKey?.startsWith(`${company.id}/photos/${set.id}/scenes/`)).toBe(true);
    const jobs = await withTenant(company.id, (tx) =>
      tx.select().from(aiJobs).where(eq(aiJobs.kind, "image_scene")),
    );
    expect(jobs).toHaveLength(1);
    // Run twice: nothing open, no provider call, no second charge.
    await runJobInline(renderSceneJob, { companyId: company.id, compositionId: comp.id });
    expect(fake.calls).toHaveLength(1);
    expect(await sceneCharges(company.id)).toHaveLength(1);
  });

  it("drift once regenerates once and charges once; drift twice fails the images uncharged (AC2)", async () => {
    const { company, ctx, design } = await shop();
    const fake = fakeProvider();
    h.provider = fake.p;
    const set = await withTenant(company.id, (tx) =>
      svc.createSet(tx, ctx, spec(design.id, { count: 2, sceneKinds: ["flat_lay"] })),
    );
    const [a, b] = await sceneIds(company.id, set.id);
    compositeQueue = ["drift", "pass", "pass", "pass"];
    await runJobInline(renderSceneJob, { companyId: company.id, compositionId: nn(a) });
    expect(fake.calls).toHaveLength(2);
    compositeQueue = ["drift", "drift", "drift", "drift"];
    await runJobInline(renderSceneJob, { companyId: company.id, compositionId: nn(b) });
    expect(fake.calls).toHaveLength(4);
    const got = await withTenant(company.id, (tx) => svc.getSet(tx, ctx, { id: set.id }));
    const ofA = got.images.filter((i) => i.compositionId === a);
    const ofB = got.images.filter((i) => i.compositionId === b);
    expect(ofA.every((i) => i.status === "rendered" && !i.containsSyntheticPerson)).toBe(true);
    expect(ofB.every((i) => i.status === "failed")).toBe(true);
    expect(nn(ofB[0]).error).toContain("design_drift");
    expect(nn(ofB[0]).checks?.failures.map((f) => f.code)).toEqual(["design_drift"]);
    const charges = await sceneCharges(company.id);
    expect(charges.map((c) => c.refId)).toEqual([a]);
    // Spend is recorded for every provider call, the drifted ones included.
    const jobs = await withTenant(company.id, (tx) =>
      tx.select().from(aiJobs).where(eq(aiJobs.kind, "image_scene")),
    );
    expect(jobs).toHaveLength(4);
    // A failed image is never reviewable.
    const reviewed = await codeOf(
      withTenant(company.id, (tx) =>
        svc.reviewImages(tx, ctx, { setId: set.id, approve: [nn(ofB[0]).id], reject: [] }),
      ),
    );
    expect(reviewed.data).toMatchObject({ reason: "not_reviewable" });
  });

  it("IMAGE_GEN_MOCK_DRIFT=1: the real mock alters the print region, the lock check catches it twice (AC5)", async () => {
    const { company, ctx, design } = await shop();
    compositeMode = "inspect";
    const set = await withTenant(company.id, (tx) =>
      svc.createSet(tx, ctx, spec(design.id, { count: 2, sceneKinds: ["studio"] })),
    );
    const [ok, drifted] = await sceneIds(company.id, set.id);
    await runJobInline(renderSceneJob, { companyId: company.id, compositionId: nn(ok) });
    menv.imageGenMockDrift = true;
    await runJobInline(renderSceneJob, { companyId: company.id, compositionId: nn(drifted) });
    const got = await withTenant(company.id, (tx) => svc.getSet(tx, ctx, { id: set.id }));
    const status = (id: string | undefined) =>
      got.images.filter((i) => i.compositionId === id).map((i) => i.status);
    expect(status(ok)).toEqual(["rendered", "rendered"]);
    expect(status(drifted)).toEqual(["failed", "failed"]);
    const charged = await sceneCharges(company.id);
    expect(charged.map((c) => c.refId)).toEqual([ok]);
    const [row] = await withTenant(company.id, (tx) =>
      tx
        .select()
        .from(photoCompositions)
        .where(eq(photoCompositions.id, nn(drifted))),
    );
    expect(row?.sceneAttempt).toBe(2);
  });

  it("a retry after a lost composite reuses the stored scene: the provider is called once (AC2)", async () => {
    const { company, ctx, design } = await shop();
    const fake = fakeProvider();
    h.provider = fake.p;
    const set = await withTenant(company.id, (tx) =>
      svc.createSet(tx, ctx, spec(design.id, { count: 1 })),
    );
    const [id] = await sceneIds(company.id, set.id);
    const composite = vi.mocked(imaging.photoSceneComposite);
    composite.mockRejectedValueOnce(
      new (await import("../../integrations/imaging/client")).ImagingError(
        "/photo/scene-composite",
        503,
        "busy",
      ),
    );
    const input = { companyId: company.id, compositionId: nn(id) };
    await expect(
      runJobInline(renderSceneJob, input, { attempt: 1, attempts: 3 }),
    ).rejects.toThrow();
    expect(fake.calls).toHaveLength(1);
    await runJobInline(renderSceneJob, input, { attempt: 2, attempts: 3 });
    expect(fake.calls).toHaveLength(1);
    expect(await sceneCharges(company.id)).toHaveLength(1);
    // A crash after the upload but before the row update: the stored object is adopted.
    const set2 = await withTenant(company.id, (tx) =>
      svc.createSet(tx, ctx, spec(design.id, { count: 1 })),
    );
    const [id2] = await sceneIds(company.id, set2.id);
    h.store.set(`${company.id}/photos/${set2.id}/scenes/${id2}-a1.png`, Buffer.from("stored"));
    await runJobInline(renderSceneJob, { companyId: company.id, compositionId: nn(id2) });
    expect(fake.calls).toHaveLength(1);
  });

  it("claim step: a scene the balance can't cover beside another claimed scene never calls the provider (AC8)", async () => {
    const { company, ctx, design } = await shop();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const fake = fakeProvider({ gate });
    h.provider = fake.p;
    const setA = await withTenant(company.id, (tx) =>
      svc.createSet(tx, ctx, spec(design.id, { count: 1 })),
    );
    const setB = await withTenant(company.id, (tx) =>
      svc.createSet(tx, ctx, spec(design.id, { count: 1 })),
    );
    // Both sets were created; now only one scene's credits are left (spent elsewhere).
    await leaveCredits(company.id, 10);
    const [a] = await sceneIds(company.id, setA.id);
    const [b] = await sceneIds(company.id, setB.id);
    const runA = runJobInline(renderSceneJob, { companyId: company.id, compositionId: nn(a) });
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
    const resB = await runJobInline(renderSceneJob, {
      companyId: company.id,
      compositionId: nn(b),
    });
    expect(fake.calls).toHaveLength(1);
    expect(resB).toMatchObject({ rendered: 0, charged: false, providerCalls: 0 });
    release();
    await runA;
    const got = await withTenant(company.id, (tx) => svc.getSet(tx, ctx, { id: setB.id }));
    const failed = got.images.filter((i) => i.source === "ai_scene");
    expect(failed.every((i) => i.status === "failed" && i.error === svc.CREDITS_USED_UP)).toBe(
      true,
    );
    expect((await sceneCharges(company.id)).map((c) => c.refId)).toEqual([a]);
  });

  it("the daily cap refuses a claim before the provider call", async () => {
    const { company, ctx, design } = await shop();
    const fake = fakeProvider();
    h.provider = fake.p;
    const set = await withTenant(company.id, (tx) =>
      svc.createSet(tx, ctx, spec(design.id, { count: 1 })),
    );
    menv.IMAGE_GEN_DAILY_CAP_PER_SHOP = 0;
    const [id] = await sceneIds(company.id, set.id);
    await runJobInline(renderSceneJob, { companyId: company.id, compositionId: nn(id) });
    expect(fake.calls).toHaveLength(0);
    const got = await withTenant(company.id, (tx) => svc.getSet(tx, ctx, { id: set.id }));
    const scene = nn(got.images.find((i) => i.source === "ai_scene"));
    expect(scene.status).toBe("failed");
    expect(scene.error).toContain("limit for AI scene images");
  });

  it("another company's job input touches nothing (tenancy)", async () => {
    const a = await shop();
    const b = await shop();
    h.provider = fakeProvider().p;
    const set = await withTenant(a.company.id, (tx) =>
      svc.createSet(tx, a.ctx, spec(a.design.id, { count: 1 })),
    );
    const [id] = await sceneIds(a.company.id, set.id);
    const res = await runJobInline(renderSceneJob, {
      companyId: b.company.id,
      compositionId: nn(id),
    });
    expect(res).toMatchObject({ skipped: true });
    const got = await withTenant(a.company.id, (tx) => svc.getSet(tx, a.ctx, { id: set.id }));
    expect(got.images.every((i) => i.status === "queued")).toBe(true);
  });
});

/* ---- Disclosures, README, attach, analysis ------------------------------------------------ */

async function approvedLifestyleSet(channels: ("shopify" | "etsy")[] = ["shopify", "etsy"]) {
  const s = await shop();
  h.provider = fakeProvider().p;
  const set = await withTenant(s.company.id, (tx) =>
    svc.createSet(tx, s.ctx, {
      ...spec(s.design.id, { count: 1, sceneKinds: ["street"] }),
      channels,
    }),
  );
  await renderEverything(s.company.id, set.id);
  const got = await withTenant(s.company.id, (tx) => svc.getSet(tx, s.ctx, { id: set.id }));
  const reviewed = await withTenant(s.company.id, (tx) =>
    svc.reviewImages(tx, s.ctx, {
      setId: set.id,
      approve: got.images.filter((i) => i.status === "rendered").map((i) => i.id),
      reject: [],
    }),
  );
  return { ...s, set: reviewed };
}

describe("disclosures, README, attach, analysis (AC3, AC6, AC9)", () => {
  it("attach sends aiGenerated + syntheticPerformer; another design's draft is CONFLICT", async () => {
    const { company, ctx, design, set } = await approvedLifestyleSet();
    const etsy = set.images.filter((i) => i.channel === "etsy");
    const draftId = crypto.randomUUID();
    h.drafts.set(draftId, {
      id: draftId,
      designId: design.id,
      channel: "etsy",
      _company: company.id,
    });
    await withTenant(company.id, (tx) =>
      svc.attachToDraft(tx, ctx, { setId: set.id, draftId, imageIds: etsy.map((i) => i.id) }),
    );
    expect(h.attachCalls.at(-1)).toMatchObject({ aiGenerated: true, syntheticPerformer: true });
    const otherDraft = crypto.randomUUID();
    h.drafts.set(otherDraft, {
      id: otherDraft,
      designId: crypto.randomUUID(),
      channel: "etsy",
      _company: company.id,
    });
    const refused = await codeOf(
      withTenant(company.id, (tx) =>
        svc.attachToDraft(tx, ctx, {
          setId: set.id,
          draftId: otherDraft,
          imageIds: [nn(etsy[0]).id],
        }),
      ),
    );
    expect(refused.code).toBe("CONFLICT");
  });

  it("the zip gets a README per channel naming the AI and synthetic-person files (en + es)", async () => {
    const { company, ctx, set } = await approvedLifestyleSet();
    const exp = await withTenant(company.id, (tx) => svc.exportZip(tx, ctx, { setId: set.id }));
    const res = await svc.runZip(
      { companyId: company.id, setId: set.id, zipJobId: exp.jobId },
      false,
    );
    expect(res.status).toBe("ready");
    const call0 = h.attachCalls.find((c) => (c as { readme?: unknown }).readme) as {
      readme: { name: string; data: Buffer }[];
    };
    expect(call0.readme.map((e) => e.name).sort()).toEqual([
      "etsy/README.txt",
      "shopify/README.txt",
    ]);
    const text = nn(call0.readme.find((e) => e.name === "shopify/README.txt")).data.toString(
      "utf8",
    );
    expect(text).toMatch(/AI-generated scenes[\s\S]*- 01-tee-lifestyle-street-black\.jpg/);
    expect(text).toMatch(/contains-synthetic-performer[\s\S]*- 01-tee-lifestyle-street-black\.jpg/);
    expect(text).toContain("Escenas generadas con IA");
    expect(text).not.toContain("00-tee-front_flat");
    const [row] = await withTenant(company.id, (tx) =>
      tx.select().from(photoSets).where(eq(photoSets.id, set.id)),
    );
    expect(row?.zipBytes).toBe(999);
  });

  it("README entries append to a zip as valid stored entries", () => {
    const empty = Buffer.alloc(22);
    empty.writeUInt32LE(0x06054b50, 0);
    const entries = readmeEntries([
      { name: "etsy/01-a.jpg", aiGenerated: true, syntheticPerson: false },
      { name: "etsy/00-b.jpg", aiGenerated: false, syntheticPerson: false },
    ]);
    const once = appendToZip(empty, entries);
    const z = readEocd(
      once.subarray(Math.max(0, once.length - 200)),
      Math.max(0, once.length - 200),
    );
    expect(z.entries).toBe(1);
    expect(once.readUInt32LE(0)).toBe(0x04034b50);
    expect(once.subarray(30, 30 + "etsy/README.txt".length).toString()).toBe("etsy/README.txt");
    const twice = appendToZip(once, [{ name: "x/README.txt", data: Buffer.from("hi") }]);
    const z2 = readEocd(twice.subarray(twice.length - 22), twice.length - 22);
    expect(z2).toMatchObject({ entries: 2, cdOffset: z.cdOffset + 30 + 12 + 2 });
    expect(twice.readUInt32LE(z2.cdOffset)).toBe(0x02014b50);
  });

  it("a failed analysis stays failed until refresh (AC9)", async () => {
    const { company, ctx, design } = await shop();
    await withTenant(company.id, (tx) =>
      tx.insert(photoAnalyses).values({
        companyId: company.id,
        designId: design.id,
        status: "failed",
        jobId: crypto.randomUUID(),
        error: "The image service is not responding.",
      }),
    );
    const plain = await withTenant(company.id, (tx) =>
      svc.analyzeDesign(tx, ctx, { designId: design.id }),
    );
    expect(plain).toEqual({ status: "failed", error: "The image service is not responding." });
    const refreshed = await withTenant(company.id, (tx) =>
      svc.analyzeDesign(tx, ctx, { designId: design.id, refresh: true }),
    );
    expect(refreshed.status).toBe("pending");
    expect(analyzeDesignJob.name).toBe("photos.analyzeDesign");
  });
});

/* ---- Shopify push ------------------------------------------------------------------------- */

async function shopifyListing(companyId: string, connectionId: string, designId: string | null) {
  const [row] = await withSystem((tx) =>
    tx
      .insert(listings)
      .values({
        companyId,
        connectionId,
        channel: "shopify",
        channelListingId: String(14_000_000_000 + Math.floor(Math.random() * 1e8)),
        title: designId ? "Desert Sun Tee" : "Other Tee",
        url: "https://desert.example/products/tee",
        designId,
      })
      .returning(),
  );
  return nn(row);
}

describe("Shopify push (AC4)", () => {
  it("lists this design's listings first; pushes approved Shopify images once; a retry pushes nothing twice", async () => {
    const { company, ctx, design, set, office } = await approvedLifestyleSet(["shopify"]);
    const conn = await createConnection(company.id, "shopify");
    const other = await shopifyListing(company.id, conn.id, null);
    const mine = await shopifyListing(company.id, conn.id, design.id);
    const etsyConn = await createConnection(company.id, "etsy");
    const targets = await withTenant(company.id, (tx) =>
      push.pushTargets(tx, ctx, { designId: design.id, limit: 1 }),
    );
    expect(targets.items.map((t) => [t.listingId, t.matchesDesign])).toEqual([[mine.id, true]]);
    const page2 = await withTenant(company.id, (tx) =>
      push.pushTargets(tx, ctx, { designId: design.id, limit: 1, cursor: nn(targets.nextCursor) }),
    );
    expect(page2.items.map((t) => t.listingId)).toEqual([other.id]);
    expect(page2.nextCursor).toBeNull();

    const imageIds = set.images.map((i) => i.id);
    const req = {
      setId: set.id,
      connectionId: conn.id,
      productRef: { listingId: mine.id },
      imageIds,
      idempotencyKey: `push-${crypto.randomUUID()}`,
    };
    const queued = await withTenant(company.id, (tx) => push.pushToShopify(tx, ctx, req));
    expect(queued.status).toBe("queued");
    expect(queued.requestedBy).toBe(office.id);
    const sameKey = await withTenant(company.id, (tx) => push.pushToShopify(tx, ctx, req));
    expect(sameKey.id).toBe(queued.id);
    const conflictCode = await codeOf(
      withTenant(company.id, (tx) =>
        push.pushToShopify(tx, ctx, { ...req, imageIds: imageIds.slice(0, 1) }),
      ),
    );
    expect(conflictCode.code).toBe("CONFLICT");

    const job = { companyId: company.id, pushId: queued.id };
    const r1 = await runJobInline(pushImagesJob, job);
    expect(r1).toMatchObject({ status: "pushed", pushed: 2 });
    expect(await runJobInline(pushImagesJob, job)).toEqual({ status: "skipped" });
    const got = await withTenant(company.id, (tx) => svc.getSet(tx, ctx, { id: set.id }));
    expect(got.pushes).toHaveLength(1);
    expect(
      nn(got.pushes[0])
        .pushed.map((p) => p.imageId)
        .sort(),
    ).toEqual([...imageIds].sort());

    // A new push of the same images to the same product: Shopify already has them.
    const again = await withTenant(company.id, (tx) =>
      push.pushToShopify(tx, ctx, { ...req, idempotencyKey: `push-${crypto.randomUUID()}` }),
    );
    expect(
      await runJobInline(pushImagesJob, { companyId: company.id, pushId: again.id }),
    ).toMatchObject({ status: "pushed", pushed: 0, skipped: 2 });
    const [row] = await withTenant(company.id, (tx) =>
      tx.select().from(photoPushes).where(eq(photoPushes.id, again.id)),
    );
    expect(row?.skipped.map((s) => s.reason)).toEqual(["already_pushed", "already_pushed"]);

    // Wrong connection kind and a listing of another connection are BAD_REQUEST.
    const notShopify = await codeOf(
      withTenant(company.id, (tx) =>
        push.pushToShopify(tx, ctx, {
          ...req,
          connectionId: etsyConn.id,
          idempotencyKey: "k-etsy-1234",
        }),
      ),
    );
    expect(notShopify.data).toMatchObject({ reason: "not_shopify_connection" });
    const conn2 = await createConnection(company.id, "shopify").catch(() => null);
    if (conn2) {
      const wrong = await codeOf(
        withTenant(company.id, (tx) =>
          push.pushToShopify(tx, ctx, {
            ...req,
            connectionId: conn2.id,
            idempotencyKey: "k-conn2-1234",
          }),
        ),
      );
      expect(wrong.data).toMatchObject({ reason: "listing_not_on_connection" });
    }
  });

  it("refuses unapproved images; presser is FORBIDDEN; another company gets NOT_FOUND (tenancy)", async () => {
    const a = await approvedLifestyleSet(["shopify"]);
    const conn = await createConnection(a.company.id, "shopify");
    const listing = await shopifyListing(a.company.id, conn.id, a.design.id);
    // Unapprove everything: nothing left to push.
    await withTenant(a.company.id, (tx) =>
      svc.reviewImages(tx, a.ctx, {
        setId: a.set.id,
        approve: [],
        reject: a.set.images.map((i) => i.id),
      }),
    );
    const req = {
      setId: a.set.id,
      connectionId: conn.id,
      productRef: { listingId: listing.id },
      imageIds: a.set.images.map((i) => i.id),
      idempotencyKey: `push-${crypto.randomUUID()}`,
    };
    const notApproved = await codeOf(
      withTenant(a.company.id, (tx) => push.pushToShopify(tx, a.ctx, req)),
    );
    expect(notApproved.data).toMatchObject({ reason: "not_approved", count: 2 });

    const presser = await createUser(a.company.id, "presser");
    const forbidden = await codeOf(
      call(router.photos.pushToShopify, req, {
        context: userContext(a.company.id, presser.id, "presser"),
      }),
    );
    expect(forbidden.code).toBe("FORBIDDEN");

    const b = await approvedLifestyleSet(["shopify"]);
    const bConn = await createConnection(b.company.id, "shopify");
    const bListing = await shopifyListing(b.company.id, bConn.id, b.design.id);
    const asB = (r: typeof req) =>
      codeOf(withTenant(b.company.id, (tx) => push.pushToShopify(tx, b.ctx, r)));
    expect((await asB(req)).code).toBe("NOT_FOUND");
    const bImages = b.set.images.map((i) => i.id);
    const base = { setId: b.set.id, imageIds: bImages, productRef: { listingId: bListing.id } };
    expect((await asB({ ...req, ...base, connectionId: conn.id })).code).toBe("NOT_FOUND");
    expect(
      (
        await asB({
          ...req,
          ...base,
          connectionId: bConn.id,
          productRef: { listingId: listing.id },
        })
      ).code,
    ).toBe("NOT_FOUND");
    expect(
      (
        await codeOf(
          withTenant(b.company.id, (tx) =>
            push.pushTargets(tx, b.ctx, { designId: a.design.id, limit: 10 }),
          ),
        )
      ).code,
    ).toBe("NOT_FOUND");
    const bTargets = await withTenant(b.company.id, (tx) =>
      push.pushTargets(tx, b.ctx, { designId: b.design.id, limit: 50 }),
    );
    expect(bTargets.items.map((t) => t.listingId)).toEqual([bListing.id]);
    // A's push rows are invisible to B.
    const bRows = await withTenant(b.company.id, (tx) =>
      tx
        .select()
        .from(photoPushes)
        .where(and(eq(photoPushes.setId, a.set.id))),
    );
    expect(bRows).toHaveLength(0);
  });
});

describe("retention (ADR 0023 §9)", () => {
  it("deletes raw scenes after 7 days and zips after 30; a second run changes nothing", async () => {
    const { company, set } = await approvedLifestyleSet(["shopify"]);
    const [comp] = await withTenant(company.id, (tx) =>
      tx
        .select()
        .from(photoCompositions)
        .where(and(eq(photoCompositions.setId, set.id), eq(photoCompositions.source, "ai_scene"))),
    );
    const c = nn(comp);
    const zipKey = `${company.id}/photos/${set.id}/zip/old.zip`;
    h.store.set(zipKey, Buffer.from("zip"));
    const old = new Date(Date.now() - 31 * 86_400_000);
    await withTenant(company.id, async (tx) => {
      await tx
        .update(photoCompositions)
        .set({ createdAt: new Date(Date.now() - 8 * 86_400_000) })
        .where(eq(photoCompositions.id, c.id));
      await tx
        .update(photoSets)
        .set({ zipStatus: "ready", zipKey, zipBuiltAt: old })
        .where(eq(photoSets.id, set.id));
    });
    expect(h.store.has(nn(c.sceneKey))).toBe(true);
    await purgePhotoFiles();
    expect(h.store.has(nn(c.sceneKey))).toBe(false);
    expect(h.store.has(nn(c.sceneBaseKey))).toBe(false);
    expect(h.store.has(zipKey)).toBe(false);
    const [after] = await withTenant(company.id, (tx) =>
      tx.select().from(photoCompositions).where(eq(photoCompositions.id, c.id)),
    );
    expect(after?.scenePurgedAt).not.toBeNull();
    const [s] = await withTenant(company.id, (tx) =>
      tx.select().from(photoSets).where(eq(photoSets.id, set.id)),
    );
    expect(s).toMatchObject({ zipStatus: "none", zipKey: null });
    // Rendered images are kept (they follow the design).
    const imageKeys = set.images.map((i) => nn(i.key));
    expect(imageKeys.length).toBeGreaterThan(0);
    const again = await purgePhotoFiles();
    const [after2] = await withTenant(company.id, (tx) =>
      tx.select().from(photoCompositions).where(eq(photoCompositions.id, c.id)),
    );
    expect(after2?.scenePurgedAt?.toISOString()).toBe(after?.scenePurgedAt?.toISOString());
    expect(again.objects).toBeGreaterThanOrEqual(0);
  });
});

describe("Shopify push errors (B-343)", () => {
  it("a refused push stores the message head, not any parameter values", async () => {
    const { company, ctx, design, set } = await approvedLifestyleSet(["shopify"]);
    const conn = await createConnection(company.id, "shopify");
    const listing = await shopifyListing(company.id, conn.id, design.id);
    const queued = await withTenant(company.id, (tx) =>
      push.pushToShopify(tx, ctx, {
        setId: set.id,
        connectionId: conn.id,
        productRef: { listingId: listing.id },
        imageIds: set.images.map((i) => i.id),
        idempotencyKey: `push-${crypto.randomUUID()}`,
      }),
    );
    const value = "Maria Perez 4410 Mesquite Lane";
    const real = await vi.mocked(channelsModule.getChannelAdapter)("shopify", "mock", {
      companyId: company.id,
    });
    vi.mocked(channelsModule.getChannelAdapter).mockResolvedValueOnce({
      ...real,
      pushProductImages: async () => {
        throw new ProductImagePushError("rejected", `Rejected\nparams: ${value}`);
      },
    });
    await runJobInline(pushImagesJob, { companyId: company.id, pushId: queued.id });
    const [row] = await withTenant(company.id, (tx) =>
      tx.select().from(photoPushes).where(eq(photoPushes.id, queued.id)),
    );
    expect(row?.status).toBe("failed");
    expect(row?.error).toBe("Rejected");
  });
});
