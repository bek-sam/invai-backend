import { and, eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { withSystem, withTenant } from "../../db/client";
import { aiCreditLedger, aiJobs, auditLog, designs, listingDrafts } from "../../db/schema";
import { createCompany, createUser, tenantContext } from "../../test/fixtures";
import { analyzeDesignForPhotos, setPreviewLoader } from "./photo-analysis";
import { attachPhotosToDraft } from "./photo-attach";
import * as svc from "./service";

/*
 * T-26-3 against invai_test: the analysis through the real gateway (mock provider: no key in
 * tests), its credit charge, the preview handling, attaching photos to a draft (append, dedupe,
 * disclosures, refusals, tenancy) and the ledger's one-charge-per-photo index.
 */

const PALETTE = {
  colors: [
    { hex: "#ffffff", share: 0.6 },
    { hex: "#f3ecd9", share: 0.3 },
    { hex: "#b3202a", share: 0.1 },
  ],
  lightShare: 0.85,
  darkShare: 0.05,
  transparentShare: 0.45,
};
const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(64)]);

let companyId: string;
let otherCompanyId: string;
let ctx: ReturnType<typeof tenantContext>;
let otherCtx: ReturnType<typeof tenantContext>;
let designId: string;

async function draft(channel: "etsy" | "amazon" | "ebay", status = "needs_review") {
  const [row] = await withSystem((tx) =>
    tx
      .insert(listingDrafts)
      .values({ companyId, designId, channel, status: status as "needs_review" })
      .returning(),
  );
  return row?.id as string;
}
const key = (n: number, cid = companyId) => `${cid}/photos/${n}.jpg`;

beforeAll(async () => {
  companyId = (await createCompany()).id;
  otherCompanyId = (await createCompany()).id;
  ctx = tenantContext(companyId, (await createUser(companyId, "owner")).id, "owner");
  otherCtx = tenantContext(otherCompanyId, (await createUser(otherCompanyId, "owner")).id, "owner");
  const [d] = await withSystem((tx) =>
    tx
      .insert(designs)
      .values({ companyId, code: "D-PHOTO", name: "Stay Wild Desert", tags: ["desert", "retro"] })
      .returning(),
  );
  designId = d?.id as string;
});

afterEach(() => setPreviewLoader(null));

describe("analyzeDesignForPhotos (mock provider)", () => {
  it("returns a sample analysis, charges photo_image credits and records the image size only", async () => {
    let read: string | null = null;
    setPreviewLoader(async (k) => {
      read = k;
      return PNG;
    });
    const input = {
      designId,
      previewKey: `${companyId}/designs/preview.png`,
      palette: PALETTE,
      designName: "Stay Wild Desert",
      tags: ["desert", "retro"],
    };
    const a = await analyzeDesignForPhotos(companyId, ctx.userId, input);
    const b = await analyzeDesignForPhotos(companyId, ctx.userId, input);
    expect(read).toBe(input.previewKey);
    expect(a.source).toBe("mock");
    expect(a.model).toBeNull();
    expect(a.recommendedColors.map((c) => c.hex)).not.toContain("#ffffff");
    expect(a.contrastWarnings).toEqual([]);
    expect(Object.keys(a.altText).sort()).toEqual([
      "amazon",
      "etsy",
      "shopify",
      "tiktok",
      "walmart",
    ]);
    expect(a.creditsUsed).toBeGreaterThan(0);
    const { analyzedAt: _x, ...restA } = a;
    const { analyzedAt: _y, ...restB } = b;
    expect(restA).toEqual(restB);

    const ledger = await withTenant(companyId, (tx) =>
      tx.select().from(aiCreditLedger).where(eq(aiCreditLedger.refId, designId)),
    );
    expect(ledger).toHaveLength(2);
    expect(ledger[0]).toMatchObject({
      kind: "photo_image",
      refType: "design",
      credits: -a.creditsUsed,
    });
    const jobs = await withTenant(companyId, (tx) =>
      tx
        .select()
        .from(aiJobs)
        .where(and(eq(aiJobs.kind, "photo_analysis"), eq(aiJobs.entityId, designId))),
    );
    expect(jobs).toHaveLength(2);
    const stored = jobs[0]?.input as { images?: unknown; prompt: string };
    expect(stored.prompt).toBe("photo_analysis@1");
    expect(stored.images).toEqual([{ mediaType: "image/png", bytes: expect.any(Number) }]);
    expect(JSON.stringify(stored)).not.toContain(PNG.toString("base64"));
  });

  it("never reads a preview outside the company prefix or an unknown format", async () => {
    const reads: string[] = [];
    setPreviewLoader(async (k) => {
      reads.push(k);
      return Buffer.from("not an image");
    });
    const base = { designId, palette: PALETTE, designName: "x", tags: [] };
    await analyzeDesignForPhotos(companyId, null, {
      ...base,
      previewKey: `${otherCompanyId}/d.png`,
    });
    expect(reads).toEqual([]);
    const r = await analyzeDesignForPhotos(companyId, null, {
      ...base,
      previewKey: `${companyId}/d.txt`,
    });
    expect(reads).toEqual([`${companyId}/d.txt`]);
    expect(r.source).toBe("mock");
    const [job] = await withTenant(companyId, (tx) =>
      tx.select().from(aiJobs).where(eq(aiJobs.kind, "photo_analysis")).orderBy(aiJobs.createdAt),
    ).then((rows) => rows.slice(-1));
    const stored = (job?.input ?? {}) as { images?: unknown; vars?: { hasImage: boolean } };
    expect(stored.images).toBeUndefined();
    expect(stored.vars?.hasImage).toBe(false);
  });
});

describe("attachPhotosToDraft", () => {
  it("appends without duplicates, keeps order, is idempotent and audits once per change", async () => {
    const id = await draft("etsy");
    const first = await withTenant(companyId, (tx) =>
      attachPhotosToDraft(tx, ctx, {
        draftId: id,
        imageKeys: [key(1), key(2)],
        aiGenerated: false,
        syntheticPerformer: false,
      }),
    );
    expect(first.mockupKeys).toEqual([key(1), key(2)]);
    expect(first.imageDisclosures).toEqual({ aiGenerated: false, syntheticPerformer: false });
    const again = await withTenant(companyId, (tx) =>
      attachPhotosToDraft(tx, ctx, {
        draftId: id,
        imageKeys: [key(2), key(1), key(3)],
        aiGenerated: false,
        syntheticPerformer: false,
      }),
    );
    expect(again.mockupKeys).toEqual([key(1), key(2), key(3)]);
    await withTenant(companyId, (tx) =>
      attachPhotosToDraft(tx, ctx, {
        draftId: id,
        imageKeys: [key(3)],
        aiGenerated: false,
        syntheticPerformer: false,
      }),
    );
    const audits = await withTenant(companyId, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.entityId, id), eq(auditLog.action, "listing_draft.attach_photos"))),
    );
    expect(audits).toHaveLength(2);
  });

  it("sets disclosures from AI images and never clears them on a later template attach", async () => {
    const id = await draft("etsy");
    const ai = await withTenant(companyId, (tx) =>
      attachPhotosToDraft(tx, ctx, {
        draftId: id,
        imageKeys: [key(10)],
        aiGenerated: true,
        syntheticPerformer: true,
      }),
    );
    expect(ai.imageDisclosures).toEqual({ aiGenerated: true, syntheticPerformer: true });
    const later = await withTenant(companyId, (tx) =>
      attachPhotosToDraft(tx, ctx, {
        draftId: id,
        imageKeys: [key(11)],
        aiGenerated: false,
        syntheticPerformer: false,
      }),
    );
    expect(later.imageDisclosures).toEqual({ aiGenerated: true, syntheticPerformer: true });
    // Stored in its own column; the copy (rebuilt on regeneration) is untouched.
    expect(later.content.disclosures).toEqual([]);
  });

  it("refuses another company's draft with NOT_FOUND", async () => {
    const id = await draft("etsy");
    await expect(
      withTenant(otherCompanyId, (tx) =>
        attachPhotosToDraft(tx, otherCtx, {
          draftId: id,
          imageKeys: [key(1, otherCompanyId)],
          aiGenerated: false,
          syntheticPerformer: false,
        }),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses a publishing draft (CONFLICT), a channel mismatch, foreign keys and too many photos", async () => {
    const base = { imageKeys: [key(1)], aiGenerated: false, syntheticPerformer: false };
    const publishing = await draft("etsy", "publishing");
    await expect(
      withTenant(companyId, (tx) => attachPhotosToDraft(tx, ctx, { ...base, draftId: publishing })),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const amazon = await draft("amazon");
    await expect(
      withTenant(companyId, (tx) =>
        attachPhotosToDraft(tx, ctx, { ...base, draftId: amazon, channel: "etsy" }),
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const ebay = await draft("ebay");
    await expect(
      withTenant(companyId, (tx) => attachPhotosToDraft(tx, ctx, { ...base, draftId: ebay })),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      withTenant(companyId, (tx) =>
        attachPhotosToDraft(tx, ctx, {
          ...base,
          draftId: amazon,
          imageKeys: [key(1, otherCompanyId)],
        }),
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      withTenant(companyId, (tx) =>
        attachPhotosToDraft(tx, ctx, {
          ...base,
          draftId: amazon,
          imageKeys: Array.from({ length: 21 }, (_, i) => key(100 + i)),
        }),
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("Etsy export with AI-generated photos", () => {
  const content = {
    title: "Desert Tee",
    description: "A tee.",
    tags: ["desert"],
    bullets: [],
    attributes: {},
    price: 2500,
    disclosures: [],
    productionPartner: null,
  };
  it("adds the separate image disclosure only when an AI photo is attached", () => {
    const withAi = svc.exportCsv("etsy", [
      { content, sku: "S1", color: "Black", size: "M", imageAiGenerated: true },
    ]);
    const without = svc.exportCsv("etsy", [{ content, sku: "S1", color: "Black", size: "M" }]);
    expect(withAi).toMatch(/Some product photos are AI-generated scenes; the design is our own\./);
    expect(withAi).toMatch(/escenas generadas con IA/);
    expect(without).not.toMatch(/AI-generated scenes/);
    // Other channels are untouched in wave 26.
    expect(
      svc.exportCsv("amazon", [
        { content, sku: "S1", color: "Black", size: "M", imageAiGenerated: true },
      ]),
    ).not.toMatch(/AI-generated scenes/);
  });
});

describe("ai_credit_ledger photo index", () => {
  it("allows one charge per photo ref, and any number for other refs", async () => {
    const ref = crypto.randomUUID();
    const row = (refType: string) => ({
      companyId,
      kind: "photo_image" as const,
      credits: -1,
      refType,
      refId: ref,
      period: "2026-10",
    });
    await withTenant(companyId, (tx) => tx.insert(aiCreditLedger).values(row("photo_image")));
    await expect(
      withTenant(companyId, (tx) => tx.insert(aiCreditLedger).values(row("photo_image"))),
    ).rejects.toThrow();
    await withTenant(companyId, (tx) => tx.insert(aiCreditLedger).values(row("design")));
    await withTenant(companyId, (tx) => tx.insert(aiCreditLedger).values(row("design")));
    // Another company's charge for the same ref id is its own.
    await withTenant(otherCompanyId, (tx) =>
      tx.insert(aiCreditLedger).values({ ...row("photo_image"), companyId: otherCompanyId }),
    );
  });
});
