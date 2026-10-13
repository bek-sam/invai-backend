import { eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mockProvider } from "../../ai/providers/mock";
import { withSystem, withTenant } from "../../db/client";
import { listings, photoAnalyses, photoImages, photoSets } from "../../db/schema";
import * as channelsModule from "../../integrations/channels";
import type { ProductImage } from "../../integrations/channels/types";
import { imaging } from "../../integrations/imaging/client";
import { runJobInline } from "../../lib/queues";
import { createCompany, createConnection, createUser, tenantContext } from "../../test/fixtures";
import { createDesign } from "../catalog/service";
import { pushImagesJob } from "./jobs";
import * as push from "./push";
import * as svc from "./service";

/*
 * T-49-1 (S-86, AC4): alt text and analysis text are cut on a whole character. The real service
 * (createSet slots, runAnalysis write) and the real push job run on invai_test; the Shopify mock
 * adapter is wrapped to capture the images it is given. The imaging client is a double.
 */

vi.mock("../../integrations/channels", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../integrations/channels")>();
  return { ...actual, getChannelAdapter: vi.fn(actual.getChannelAdapter) };
});

const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const nn = <T>(v: T | null | undefined): T => {
  if (v === null || v === undefined) throw new Error("missing test value");
  return v;
};

beforeAll(() => {
  svc.setPhotoEnqueuers({ analysis: async () => {}, zip: async () => {}, push: async () => {} });
});
afterEach(() => vi.restoreAllMocks());

async function shop() {
  const company = await createCompany();
  const office = await createUser(company.id, "office");
  const ctx = tenantContext(company.id, office.id, "office");
  const design = await withTenant(company.id, (tx) =>
    createDesign(tx, ctx, {
      code: `W${Math.floor(Math.random() * 1e6)}`,
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

const spec = (designId: string, colors: { name: string; hex: string }[]) => ({
  designId,
  garments: ["tee"] as "tee"[],
  colors,
  views: ["front_flat"] as "front_flat"[],
  channels: ["shopify"] as "shopify"[],
  underbasePreview: true,
  idempotencyKey: `key-${crypto.randomUUID()}`,
});

const across = (n: number) => `${"a".repeat(n - 1)}😀 and more words after it`;

describe("photo service: slot alt text from the analysis (AC4)", () => {
  it("an emoji across unit 250 in analysis.altText is dropped whole", async () => {
    const { company, ctx, design } = await shop();
    await withSystem(
      (tx) =>
        tx.insert(photoAnalyses).values({
          companyId: company.id,
          designId: design.id,
          status: "ready",
          jobId: crypto.randomUUID(),
          analysis: {
            designId: design.id,
            source: "mock",
            model: null,
            palette: [],
            lightShare: 0,
            darkShare: 0,
            transparentShare: 0,
            style: "bold",
            audience: "hikers",
            detectedText: null,
            colorDescription: "dark",
            recommendedColors: [],
            contrastWarnings: [],
            sceneSuggestions: [],
            altText: { shopify: across(250) },
            imageOrder: { shopify: ["front_flat"] },
            creditsUsed: 0,
            analyzedAt: new Date().toISOString(),
          },
        }),
      company.id,
    );
    const set = await withTenant(company.id, (tx) =>
      svc.createSet(tx, ctx, spec(design.id, [{ name: "Black", hex: "#000000" }])),
    );
    const rows = await withTenant(company.id, (tx) =>
      tx.select().from(photoImages).where(eq(photoImages.setId, set.id)),
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      const alt = nn(r.altText);
      expect(alt.length).toBeLessThanOrEqual(250);
      expect(LONE.test(alt)).toBe(false);
      expect(alt).not.toContain("�");
      expect(alt).toBe("a".repeat(249));
    }
  });
});

describe("photo push: alt text of the image list (AC4)", () => {
  it("cuts a stored alt text and the designName/colorName fallback on a whole character", async () => {
    const { company, ctx, design } = await shop();
    const set = await withTenant(company.id, (tx) =>
      svc.createSet(
        tx,
        ctx,
        spec(design.id, [
          { name: "Black", hex: "#000000" },
          { name: "Sand", hex: "#e6d3b3" },
        ]),
      ),
    );
    // Design name long enough that `<name> tee in <color>` has the emoji across unit 250.
    await withSystem(
      (tx) =>
        tx
          .update(photoSets)
          .set({ designName: `${"d".repeat(249)}😀` })
          .where(eq(photoSets.id, set.id)),
      company.id,
    );
    const imgs = await withTenant(company.id, (tx) =>
      tx.select().from(photoImages).where(eq(photoImages.setId, set.id)).orderBy(photoImages.slot),
    );
    expect(imgs).toHaveLength(2);
    const [withAlt, noAlt] = [nn(imgs[0]), nn(imgs[1])];
    await withTenant(company.id, async (tx) => {
      for (const [i, alt] of [
        [withAlt, across(250)],
        [noAlt, null],
      ] as const)
        await tx
          .update(photoImages)
          .set({
            status: "approved",
            key: `${company.id}/photos/${i.id}.jpg`,
            altText: alt,
          })
          .where(eq(photoImages.id, i.id));
    });
    const conn = await createConnection(company.id, "shopify");
    const [listing] = await withSystem(
      (tx) =>
        tx
          .insert(listings)
          .values({
            companyId: company.id,
            connectionId: conn.id,
            channel: "shopify",
            channelListingId: String(14_000_000_000 + Math.floor(Math.random() * 1e8)),
            title: "Desert Sun Tee",
            url: "https://desert.example/products/tee",
            designId: design.id,
          })
          .returning(),
      company.id,
    );
    const queued = await withTenant(company.id, (tx) =>
      push.pushToShopify(tx, ctx, {
        setId: set.id,
        connectionId: conn.id,
        productRef: { listingId: nn(listing).id },
        imageIds: [withAlt.id, noAlt.id],
        idempotencyKey: `push-${crypto.randomUUID()}`,
      }),
    );

    const captured: ProductImage[] = [];
    const real = await vi.mocked(channelsModule.getChannelAdapter)("shopify", "mock", {
      companyId: company.id,
    });
    vi.mocked(channelsModule.getChannelAdapter).mockResolvedValueOnce({
      ...real,
      pushProductImages: async (_conn, input) => {
        captured.push(...input.images);
        return {
          pushed: input.images.map((i) => ({ filename: i.filename, mediaId: `m-${i.filename}` })),
          skipped: [],
        };
      },
    });
    const r = await runJobInline(pushImagesJob, { companyId: company.id, pushId: queued.id });
    expect(r).toMatchObject({ status: "pushed", pushed: 2 });
    expect(captured).toHaveLength(2);
    for (const img of captured) {
      expect(img.alt.length).toBeLessThanOrEqual(250);
      expect(LONE.test(img.alt)).toBe(false);
      expect(img.alt).not.toContain("�");
    }
    expect(captured.find((i) => i.filename === `${withAlt.id}.jpg`)?.alt).toBe("a".repeat(249));
    expect(captured.find((i) => i.filename === `${noAlt.id}.jpg`)?.alt).toBe("d".repeat(249));
  });
});

describe("photo analysis write: clip output reaches jsonb (AC4, amendment 2)", () => {
  it("an emoji at the clip cut is written whole or dropped, never a lone surrogate (no 22P02)", async () => {
    const { company, ctx, design } = await shop();
    const jobId = crypto.randomUUID();
    await withSystem(
      (tx) =>
        tx
          .insert(photoAnalyses)
          .values({ companyId: company.id, designId: design.id, status: "pending", jobId }),
      company.id,
    );
    vi.spyOn(imaging, "photoPalette").mockResolvedValue({
      colors: [{ hex: "#101010", share: 0.9 }],
      light_share: 0.05,
      dark_share: 0.9,
      transparent_share: 0.5,
    });
    const realStructured = mockProvider.structured.bind(mockProvider);
    vi.spyOn(mockProvider, "structured").mockImplementation(async (prompt, vars, images) => {
      const res = await realStructured(prompt, vars, images);
      const o = res.output as Record<string, unknown>;
      return {
        ...res,
        output: {
          ...o,
          style: `${"s".repeat(298)}😀 trailing`,
          detectedText: `${"t".repeat(498)}😀 trailing`,
          colorDescription: `${"c".repeat(298)}😀 trailing`,
        } as typeof res.output,
      };
    });
    const out = await svc.runAnalysis(
      { companyId: company.id, designId: design.id, jobId, userId: null },
      true,
    );
    expect(out).toEqual({ status: "ready" });
    const [row] = await withTenant(company.id, (tx) =>
      tx.select().from(photoAnalyses).where(eq(photoAnalyses.designId, design.id)),
    );
    expect(row?.status).toBe("ready");
    const a = nn(row?.analysis);
    for (const v of [a.style, a.detectedText, a.colorDescription]) {
      expect(LONE.test(nn(v))).toBe(false);
      expect(nn(v)).not.toContain("�");
    }
    expect(nn(a.detectedText).length).toBeLessThanOrEqual(500);
    void ctx;
  });
});
