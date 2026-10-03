import { call, ORPCError } from "@orpc/server";
import { and, eq, gt } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { chargeCredits, creditBalance } from "../../ai/credits";
import { IMAGE_JOB_KIND, type ImageProvider } from "../../ai/images";
import { anonymousContext, type Context, permissionsFor } from "../../api/context";
import { router } from "../../api/router";
import { withTenant } from "../../db/client";
import { aiJobs, photoImages } from "../../db/schema";
import { imaging } from "../../integrations/imaging/client";
import { runJobInline } from "../../lib/queues";
import { createCompany, createUser, tenantContext } from "../../test/fixtures";
import { createDesign } from "../catalog/service";
import { renderCompositionJob, renderSceneJob } from "./jobs";
import * as svc from "./service";

/*
 * Security suite for listing photos (T-26-4 security co-review). Imaging is a test double; the
 * database is invai_test with RLS on.
 */

// S-55 doubles: off unless a test turns them on, so the other tests use the real modules.
const h = vi.hoisted(() => ({
  on: false,
  provider: null as unknown,
  store: new Map<string, Buffer>(),
  failPut: [] as string[],
}));

vi.mock("../../ai/images", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../ai/images")>();
  return {
    ...real,
    getImageProvider: vi.fn(async (companyId: string) =>
      h.provider ? (h.provider as ImageProvider) : real.getImageProvider(companyId),
    ),
  };
});

vi.mock("../../lib/s3", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../lib/s3")>();
  return {
    ...real,
    getObject: vi.fn(async (key: string) => {
      if (!h.on) return real.getObject(key);
      const b = h.store.get(key);
      if (!b) throw new Error(`no object ${key}`);
      return b;
    }),
    putObject: vi.fn(async (key: string, body: Buffer, type?: string) => {
      if (!h.on) return real.putObject(key, body, type as never);
      if (h.failPut.some((k) => key.endsWith(k))) {
        h.failPut = h.failPut.filter((k) => !key.endsWith(k));
        throw new Error("S3 503 SlowDown");
      }
      h.store.set(key, Buffer.from(body));
      return key;
    }),
    headObject: vi.fn(async (key: string) => {
      if (!h.on) return real.headObject(key);
      return h.store.has(key)
        ? { exists: true as const, size: 1, contentType: null }
        : { exists: false as const };
    }),
  };
});

type Role = "office" | "presser" | "packer" | "receiver";

function ctxFor(companyId: string, userId: string, role: Role): Context {
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

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ORPCError) return e.code;
    throw e;
  }
  return "OK";
}

async function shop() {
  const company = await createCompany();
  const office = await createUser(company.id, "office");
  const ctx = ctxFor(company.id, office.id, "office");
  const design = await withTenant(company.id, (tx) =>
    createDesign(tx, tenantContext(company.id, office.id, "office"), {
      code: `D${Math.floor(Math.random() * 1e6)}`,
      name: "Desert Sun",
      tags: ["desert"],
      personalizationTemplateId: null,
      placements: [
        { placement: "front", fileKey: `${company.id}/designs/f.png`, widthIn: 10, heightIn: 12 },
        { placement: "back", fileKey: `${company.id}/designs/b.png`, widthIn: 11, heightIn: 14 },
      ],
    }),
  );
  return { company, office, ctx, design };
}

const spec = (designId: string) => ({
  designId,
  garments: ["tee", "hoodie"] as ("tee" | "hoodie")[],
  colors: [
    { name: "Black", hex: "#000000" },
    { name: "Sand", hex: "#e6d3b3" },
  ],
  views: ["front_flat", "back"] as ("front_flat" | "back")[],
  channels: ["amazon", "etsy"] as ("amazon" | "etsy")[],
  underbasePreview: true,
  idempotencyKey: `key-${crypto.randomUUID()}`,
});

async function renderAll(companyId: string, setId: string) {
  for (const compositionId of await svc.openCompositions(companyId, setId))
    await runJobInline(renderCompositionJob, { companyId, compositionId });
}

beforeAll(() => {
  svc.setPhotoEnqueuers({ analysis: async () => {}, zip: async () => {} });
});

beforeEach(() => {
  vi.spyOn(imaging, "photoRender").mockImplementation(async (i) => ({
    key: i.out_key,
    width_px: 2000,
    height_px: 2000,
    format: "jpeg",
    print_box_px: [0, 0, 10, 10],
    checks: {
      passes: true,
      failures: [],
      background_pure_white: true,
      fill_ratio: 0.8,
      longest_side_px: 2000,
    },
  }));
});

afterEach(() => {
  h.on = false;
  h.provider = null;
  h.store.clear();
  h.failPut = [];
  vi.restoreAllMocks();
});

describe("photos: credits", () => {
  // S-51 (Medium): createSet asserts the balance but reserves nothing, and the render charge
  // never re-checks it, so N sets each passing the same assert render and charge N times the
  // balance. Flip `it.fails` to `it` with the fix.
  it("two sets created against a balance that covers one never take credits below zero", async () => {
    const { company, ctx, design } = await shop();
    await withTenant(company.id, async (tx) => {
      const b = await creditBalance(tx, company.id);
      await chargeCredits(tx, {
        companyId: company.id,
        kind: "listing_draft",
        credits: b.remaining - 8, // exactly one 8-composition set left
        model: null,
        usage: null,
      });
    });
    const a = await call(router.photos.createSet, spec(design.id), { context: ctx });
    const second = await codeOf(call(router.photos.createSet, spec(design.id), { context: ctx }));
    const sets = [a.id];
    if (second === "OK") {
      const [b] = await withTenant(company.id, (tx) =>
        tx.query.photoSets.findMany({ columns: { id: true } }),
      ).then((rows) => rows.filter((r) => r.id !== a.id));
      if (b) sets.push(b.id);
    }
    for (const id of sets) await renderAll(company.id, id);
    const after = await withTenant(company.id, (tx) => creditBalance(tx, company.id));
    expect(after.remaining).toBeGreaterThanOrEqual(0);
  });

  // S-51 r2: two createSets racing past the open-commitments check (neither sees the other's
  // rows yet) and rendering in parallel still never go negative, and failed images cost nothing.
  it("concurrent createSets on one set's worth of credits charge at most that and never go negative", async () => {
    const { company, ctx, design } = await shop();
    await withTenant(company.id, async (tx) => {
      const b = await creditBalance(tx, company.id);
      await chargeCredits(tx, {
        companyId: company.id,
        kind: "listing_draft",
        credits: b.remaining - 8,
        model: null,
        usage: null,
      });
    });
    const results = await Promise.allSettled([
      call(router.photos.createSet, spec(design.id), { context: ctx }),
      call(router.photos.createSet, spec(design.id), { context: ctx }),
    ]);
    const ids = results.flatMap((r) => (r.status === "fulfilled" ? [r.value.id] : []));
    expect(ids.length).toBeGreaterThanOrEqual(1);
    await Promise.all(ids.map((id) => renderAll(company.id, id)));
    const after = await withTenant(company.id, (tx) => creditBalance(tx, company.id));
    expect(after.remaining).toBeGreaterThanOrEqual(0);
    const imgs = await withTenant(company.id, (tx) => tx.select().from(photoImages));
    for (const i of imgs.filter((x) => x.status === "failed")) expect(i.key).toBeNull();
  });
});

describe("photos: tenancy", () => {
  it("another company's design, set, image and draft ids answer NOT_FOUND or a count, never data", async () => {
    const A = await shop();
    const B = await shop();
    const set = await call(router.photos.createSet, spec(A.design.id), { context: A.ctx });
    await renderAll(A.company.id, set.id);
    const imgs = await withTenant(A.company.id, (tx) => tx.select().from(photoImages));
    const imageIds = imgs.map((i) => i.id).slice(0, 2);
    const bCtx = B.ctx;
    expect(
      await codeOf(call(router.photos.analyzeDesign, { designId: A.design.id }, { context: bCtx })),
    ).toBe("NOT_FOUND");
    expect(
      await codeOf(
        call(router.photos.estimate, { ...spec(A.design.id) } as never, { context: bCtx }),
      ),
    ).toBe("NOT_FOUND");
    expect(await codeOf(call(router.photos.getSet, { id: set.id }, { context: bCtx }))).toBe(
      "NOT_FOUND",
    );
    expect(
      await codeOf(
        call(
          router.photos.reviewImages,
          { setId: set.id, approve: imageIds, reject: [] },
          { context: bCtx },
        ),
      ),
    ).toBe("NOT_FOUND");
    expect(await codeOf(call(router.photos.exportZip, { setId: set.id }, { context: bCtx }))).toBe(
      "NOT_FOUND",
    );
    expect(
      await codeOf(
        call(
          router.photos.attachToDraft,
          { setId: set.id, draftId: crypto.randomUUID(), imageIds: imageIds },
          { context: bCtx },
        ),
      ),
    ).toBe("NOT_FOUND");
    // B's own set with A's image ids: refused, A's rows untouched.
    const bSet = await call(router.photos.createSet, spec(B.design.id), { context: bCtx });
    expect(
      await codeOf(
        call(
          router.photos.reviewImages,
          { setId: bSet.id, approve: imageIds, reject: [] },
          { context: bCtx },
        ),
      ),
    ).toBe("BAD_REQUEST");
    const list = await call(router.photos.listSets, {} as never, { context: bCtx });
    expect(list.items.map((s: { id: string }) => s.id)).not.toContain(set.id);
    const stillRendered = await withTenant(A.company.id, (tx) => tx.select().from(photoImages));
    expect(stillRendered.every((i) => i.status === "rendered")).toBe(true);
  });
});

describe("photos: roles", () => {
  it.each(["presser", "packer", "receiver"] as const)(
    "%s is refused on every photos procedure",
    async (role) => {
      const { company, design } = await shop();
      const u = await createUser(company.id, role);
      const ctx = ctxFor(company.id, u.id, role);
      const id = crypto.randomUUID();
      const calls = [
        call(router.photos.analyzeDesign, { designId: design.id }, { context: ctx }),
        call(router.photos.estimate, spec(design.id) as never, { context: ctx }),
        call(router.photos.createSet, spec(design.id), { context: ctx }),
        call(router.photos.listSets, {} as never, { context: ctx }),
        call(router.photos.getSet, { id }, { context: ctx }),
        call(
          router.photos.reviewImages,
          { setId: id, approve: [id], reject: [] },
          { context: ctx },
        ),
        call(router.photos.exportZip, { setId: id }, { context: ctx }),
        call(
          router.photos.attachToDraft,
          { setId: id, draftId: id, imageIds: [id] },
          { context: ctx },
        ),
      ];
      for (const c of calls) expect(await codeOf(c)).toBe("FORBIDDEN");
    },
  );
});

describe("photos: AI scene spend (T-27-3 security co-review)", () => {
  // S-55 (Medium): renderScene stores the provider's scene (putObject) before recordImageGen. A
  // transient S3 failure after a paid scene call throws RetryLater with no ai_jobs row, so that
  // call's cost never reaches the spend counters or the daily shop cap, and the retry pays the
  // provider again. Every billed call must be recorded. Flip `it.fails` to `it` with the fix.
  it("a scene call whose upload fails is still recorded as spend before the retry pays again", async () => {
    const { company, office, design } = await shop();
    const ctx = tenantContext(company.id, office.id, "office");
    h.on = true;
    let calls = 0;
    h.provider = {
      name: "openai",
      model: "fake-image",
      estimateCents: () => 4,
      async generateScene() {
        calls++;
        return {
          image: Buffer.from(`scene-${calls}`),
          widthPx: 1024,
          heightPx: 1024,
          provider: "openai",
          model: "fake-image",
          costCents: 4,
          containsPerson: false,
        };
      },
    } satisfies ImageProvider;
    vi.spyOn(imaging, "photoSceneBase").mockImplementation(async (i) => {
      h.store.set(i.out_key, Buffer.from("base"));
      h.store.set(i.mask_out_key, Buffer.from("mask"));
      return { key: i.out_key, mask_key: i.mask_out_key, print_box_px: [400, 300, 224, 300] };
    });
    vi.spyOn(imaging, "photoSceneComposite").mockImplementation(async (i) => ({
      key: i.out_key,
      checks: { passes: true, failures: [], region_unchanged_score: 0.97, design_lock_score: 0.96 },
      width_px: 2048,
      height_px: 2048,
      format: "jpeg",
    }));
    const set = await withTenant(company.id, (tx) =>
      svc.createSet(tx, ctx, {
        designId: design.id,
        garments: ["tee"],
        colors: [{ name: "Black", hex: "#000000" }],
        views: ["front_flat"],
        channels: ["shopify"],
        underbasePreview: true,
        idempotencyKey: `key-${crypto.randomUUID()}`,
        lifestyle: { count: 1 },
      }),
    );
    const sceneIds = (await svc.openCompositionsBySource(company.id, set.id))
      .filter((c) => c.source === "ai_scene")
      .map((c) => c.id);
    expect(sceneIds).toHaveLength(1);
    const input = { companyId: company.id, compositionId: sceneIds[0] as string };
    h.failPut = ["-a1.png"];
    await expect(
      runJobInline(renderSceneJob, input, { attempt: 1, attempts: 3 }),
    ).rejects.toThrow();
    await runJobInline(renderSceneJob, input, { attempt: 2, attempts: 3 });
    const billed = await withTenant(company.id, (tx) =>
      tx
        .select()
        .from(aiJobs)
        .where(
          and(
            eq(aiJobs.companyId, company.id),
            eq(aiJobs.kind, IMAGE_JOB_KIND),
            gt(aiJobs.costCents, 0),
          ),
        ),
    );
    expect(calls).toBe(2);
    expect(billed).toHaveLength(calls);
  });
});
