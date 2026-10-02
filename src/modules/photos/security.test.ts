import { call, ORPCError } from "@orpc/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { chargeCredits, creditBalance } from "../../ai/credits";
import { anonymousContext, type Context, permissionsFor } from "../../api/context";
import { router } from "../../api/router";
import { withTenant } from "../../db/client";
import { photoImages } from "../../db/schema";
import { imaging } from "../../integrations/imaging/client";
import { runJobInline } from "../../lib/queues";
import { createCompany, createUser, tenantContext } from "../../test/fixtures";
import { createDesign } from "../catalog/service";
import { renderCompositionJob } from "./jobs";
import * as svc from "./service";

/*
 * Security suite for listing photos (T-26-4 security co-review). Imaging is a test double; the
 * database is invai_test with RLS on.
 */

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
