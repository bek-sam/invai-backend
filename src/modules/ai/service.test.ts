import { ORPCError } from "@orpc/server";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { assertCredits } from "../../ai/credits";
import { aiProvider } from "../../ai/gateway";
import { withSystem, withTenant } from "../../db/client";
import {
  blankVariants,
  channelConnections,
  companies,
  designs,
  listingDrafts,
  products,
  usage,
} from "../../db/schema";
import { env } from "../../env";
import { parseCsvObjects } from "../../lib/csv";
import { getObject } from "../../lib/s3";
import { createCompany, createUser, tenantContext } from "../../test/fixtures";
import { periodOf } from "../billing/service";
import { clearSampleWorkspaceCache } from "../tenancy/demo-flag";
import * as svc from "./service";
import { combineRisk, matchRisk } from "./trademark";

// Trademark marks (and the plan catalog) are no longer seeded per test file: the global test
// setup runs `runMigrations`, which calls `ensureReferenceData` (src/db/reference), so
// `trademark_marks` is already populated before this file's tests run. See
// src/db/reference/index.test.ts for the migration-time guarantee itself.

describe("trademark scoring", () => {
  it("combines match risks", () => {
    const slogan = matchRisk({
      kind: "slogan",
      exact: true,
      similarity: 1,
      multiWord: true,
      judgement: null,
    });
    const word = matchRisk({
      kind: "word",
      exact: true,
      similarity: 1,
      multiWord: false,
      judgement: null,
    });
    expect(combineRisk([slogan, word])).toEqual({ riskScore: 97, riskLevel: "high" });
    expect(combineRisk([]).riskLevel).toBe("low");
    const fuzzy = matchRisk({
      kind: "word",
      exact: false,
      similarity: 0.8,
      multiWord: false,
      judgement: null,
    });
    expect(combineRisk([fuzzy]).riskLevel).toBe("medium");
    expect(
      matchRisk({
        kind: "word",
        exact: true,
        similarity: 1,
        multiWord: false,
        judgement: "unrelated",
      }),
    ).toBeLessThan(0.1);
  });
});

describe("ai module", () => {
  let companyId: string;
  let ctx: ReturnType<typeof tenantContext>;
  let designId: string;

  beforeAll(async () => {
    companyId = (await createCompany()).id;
    const owner = await createUser(companyId, "owner");
    ctx = tenantContext(companyId, owner.id, "owner");
    // Etsy's validator requires a production partner (production_partner_required, T-8-1 AC2); a
    // real shop configures one from Settings before it can generate/approve an Etsy listing.
    await withSystem((tx) =>
      tx
        .update(companies)
        .set({ settings: { productionPartner: { name: "Cactus Print Co", etsyPartnerId: null } } })
        .where(eq(companies.id, companyId)),
    );
    const [d] = await withSystem((tx) =>
      tx
        .insert(designs)
        .values({
          companyId,
          code: "D-CACTUS",
          name: "Desert Sunset Cactus",
          tags: ["cactus", "desert", "boho"],
        })
        .returning(),
    );
    designId = d?.id as string;
  });

  it("scores 'Just Do It Nike shirt' as high risk and a plain design as low", async () => {
    const high = await withTenant(companyId, (tx) =>
      svc.trademarkCheck(tx, ctx, { text: "Just Do It Nike shirt" }),
    );
    expect(high.riskLevel).toBe("high");
    expect(high.riskScore).toBeGreaterThanOrEqual(90);
    expect(high.matches.map((m) => m.mark)).toEqual(expect.arrayContaining(["JUST DO IT", "NIKE"]));
    expect(high.explanation).toMatch(/not legal advice/);

    const low = await withTenant(companyId, (tx) => svc.trademarkCheck(tx, ctx, { designId }));
    expect(low.riskLevel).toBe("low");
  });

  it("generates a draft with the mock provider, validates it and gates approval", async () => {
    const generated: string[] = [];
    svc.setGenerationEnqueuer(async (input) => {
      generated.push(...input.draftIds);
    });
    const { jobId, drafts } = await withTenant(companyId, (tx) =>
      svc.createDrafts(tx, ctx, { designId, channels: ["etsy", "amazon"] }),
    );
    expect(jobId).toBeTruthy();
    expect(drafts.map((d) => d.status)).toEqual(["generating", "generating"]);
    expect(generated).toHaveLength(2);
    await svc.runGenerationJob({ companyId, jobId, draftIds: generated, userId: ctx.userId });

    const etsy = await withTenant(companyId, (tx) =>
      svc.getDraft(tx, ctx, drafts[0]?.id as string),
    );
    expect(etsy.status).toBe("needs_review");
    expect(etsy.validation?.ok).toBe(true);
    expect(etsy.content.tags.length).toBe(13);
    expect(etsy.content.disclosures).toHaveLength(2);
    expect(etsy.trademark?.riskLevel).toBe("low");
    expect(etsy.creditsUsed).toBeGreaterThan(0);

    // An edit that breaks the rules blocks approval with VALIDATION_FAILED.
    await withTenant(companyId, (tx) =>
      svc.updateDraft(tx, ctx, etsy.id, { title: "x".repeat(150) }),
    );
    await expect(
      withTenant(companyId, (tx) => svc.approveDraft(tx, ctx, etsy.id)),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    // A trademark in the title blocks approval unconditionally (T-8-4 AC1): no acknowledgeRisk
    // override exists any more.
    await withTenant(companyId, (tx) =>
      svc.updateDraft(tx, ctx, etsy.id, { title: "Just Do It Nike Cactus Shirt" }),
    );
    await expect(
      withTenant(companyId, (tx) => svc.approveDraft(tx, ctx, etsy.id)),
    ).rejects.toMatchObject({
      code: "HIGH_TRADEMARK_RISK",
    });
    await expect(
      withTenant(companyId, (tx) => svc.approveDraft(tx, ctx, etsy.id)),
    ).rejects.toMatchObject({
      code: "HIGH_TRADEMARK_RISK",
    });
    // Only editing the trademarked text away clears the gate.
    await withTenant(companyId, (tx) =>
      svc.updateDraft(tx, ctx, etsy.id, { title: "Desert Sunset Cactus Tee" }),
    );
    const approved = await withTenant(companyId, (tx) => svc.approveDraft(tx, ctx, etsy.id));
    expect(approved.status).toBe("approved");

    const credits = await withTenant(companyId, (tx) => svc.balance(tx, ctx));
    expect(credits.used).toBeGreaterThan(0);
    const ledger = await withTenant(companyId, (tx) => svc.ledger(tx, ctx, { limit: 50 }));
    expect(ledger.items.every((e) => e.kind === "listing_draft" && e.credits < 0)).toBe(true);
  });

  it("blocks with CREDITS_EXHAUSTED when the allowance is used up", async () => {
    const other = (await createCompany()).id;
    await withSystem((tx) =>
      tx.insert(usage).values({ companyId: other, period: periodOf().key, aiCredits: 100_000 }),
    );
    const err = await withTenant(other, (tx) => assertCredits(tx, other)).catch((e) => e);
    expect(err).toBeInstanceOf(ORPCError);
    expect(err.code).toBe("CREDITS_EXHAUSTED");
    expect(err.status).toBe(402);
    const owner = await createUser(other, "owner");
    const octx = tenantContext(other, owner.id, "owner");
    const [d] = await withSystem((tx) =>
      tx.insert(designs).values({ companyId: other, code: "X", name: "X" }).returning(),
    );
    await expect(
      withTenant(other, (tx) =>
        svc.createDrafts(tx, octx, { designId: d?.id as string, channels: ["etsy"] }),
      ),
    ).rejects.toMatchObject({ code: "CREDITS_EXHAUSTED" });
    const rows = await withSystem((tx) =>
      tx.select().from(listingDrafts).where(eq(listingDrafts.companyId, other)),
    );
    expect(rows).toHaveLength(0);
  });

  it("streams a tool-backed assistant answer", async () => {
    const events = [];
    for await (const e of svc.ask(ctx, { message: "what was my TikTok margin this week?" }))
      events.push(e);
    expect(events[0]?.type).toBe("start");
    expect(events.some((e) => e.type === "tool_call" && e.name === "get_profit")).toBe(true);
    expect(events.some((e) => e.type === "text_delta")).toBe(true);
    expect(events.at(-1)?.type).toBe("done");
    const convId = events[0]?.type === "start" ? events[0].conversationId : "";
    const conv = await withTenant(companyId, (tx) => svc.getConversation(tx, ctx, convId));
    expect(conv.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(conv.messages[1]?.text).toMatch(/TikTok/);
  });

  it("stores a chat message containing NUL without a 500 (T-8-2 r2)", async () => {
    const events = [];
    const message = "what was my TikTok\u0000 margin this week?\u0000";
    for await (const e of svc.ask(ctx, { message })) events.push(e);
    expect(events.at(-1)?.type).toBe("done");
    const convId = events[0]?.type === "start" ? events[0].conversationId : "";
    const conv = await withTenant(companyId, (tx) => svc.getConversation(tx, ctx, convId));
    expect(conv.messages[0]?.text).toBe("what was my TikTok margin this week?");
  });

  describe("exportCsv (T-6-4 AC2): one row per variant, real SKUs", () => {
    let productId: string;
    const skus = ["SKU-BLK-S", "SKU-BLK-M", "SKU-WHT-S", "SKU-WHT-M"];

    beforeAll(async () => {
      await withSystem(async (tx) => {
        const [p] = await tx
          .insert(products)
          .values({
            companyId,
            designId,
            brand: "Gildan",
            styleCode: "G64000",
            name: "Cactus Tee",
            allowedColorCodes: ["BLK", "WHT"],
            allowedSizeCodes: ["S", "M"],
          })
          .returning();
        productId = p?.id as string;
        await tx.insert(blankVariants).values([
          {
            companyId,
            brand: "Gildan",
            style: "64000",
            styleCode: "G64000",
            color: "Black",
            colorCode: "BLK",
            size: "Small",
            sizeCode: "S",
            sku: skus[0] as string,
          },
          {
            companyId,
            brand: "Gildan",
            style: "64000",
            styleCode: "G64000",
            color: "Black",
            colorCode: "BLK",
            size: "Medium",
            sizeCode: "M",
            sku: skus[1] as string,
          },
          {
            companyId,
            brand: "Gildan",
            style: "64000",
            styleCode: "G64000",
            color: "White",
            colorCode: "WHT",
            size: "Small",
            sizeCode: "S",
            sku: skus[2] as string,
          },
          {
            companyId,
            brand: "Gildan",
            style: "64000",
            styleCode: "G64000",
            color: "White",
            colorCode: "WHT",
            size: "Medium",
            sizeCode: "M",
            sku: skus[3] as string,
          },
          // Not in the product's allowed colors/sizes: must not show up in an export.
          {
            companyId,
            brand: "Gildan",
            style: "64000",
            styleCode: "G64000",
            color: "Black",
            colorCode: "BLK",
            size: "XL",
            sizeCode: "XL",
            sku: "SKU-BLK-XL",
          },
        ]);
      });
    });

    async function approvedDraft(channel: "etsy" | "shopify") {
      const enq: string[] = [];
      svc.setGenerationEnqueuer(async (input) => {
        enq.push(...input.draftIds);
      });
      const { jobId, drafts } = await withTenant(companyId, (tx) =>
        svc.createDrafts(tx, ctx, { designId, productId, channels: [channel] }),
      );
      await svc.runGenerationJob({ companyId, jobId, draftIds: enq, userId: ctx.userId });
      const draft = await withTenant(companyId, (tx) =>
        svc.getDraft(tx, ctx, drafts[0]?.id as string),
      );
      return withTenant(companyId, (tx) => svc.approveDraft(tx, ctx, draft.id));
    }

    it("exports one CSV row per variant with real SKUs (Etsy)", async () => {
      const draft = await approvedDraft("etsy");
      const { key } = await withTenant(companyId, (tx) =>
        svc.exportListingsCsv(tx, ctx, { draftIds: [draft.id], channel: "etsy" }),
      );
      const csv = (await getObject(key)).toString("utf8");
      const { rows } = parseCsvObjects(csv);
      expect(rows).toHaveLength(4);
      expect(rows.map((r) => r.sku).sort()).toEqual([...skus].sort());
      expect(rows.every((r) => !(r.sku ?? "").startsWith("DRAFT-"))).toBe(true);
      // production_partner_ids (T-8-1 AC2): name from the company setting, id blank until the
      // Etsy adapter is authorized.
      expect(rows.every((r) => r.production_partner === "Cactus Print Co")).toBe(true);
      expect(rows.every((r) => r.production_partner_ids === "")).toBe(true);
    });

    it("exports a Shopify product CSV: one Handle per draft, one row per variant, real option values", async () => {
      const draft = await approvedDraft("shopify");
      const { key } = await withTenant(companyId, (tx) =>
        svc.exportListingsCsv(tx, ctx, { draftIds: [draft.id], channel: "shopify" }),
      );
      const csv = (await getObject(key)).toString("utf8");
      const { rows } = parseCsvObjects(csv);
      expect(rows).toHaveLength(4);
      expect(new Set(rows.map((r) => r.Handle)).size).toBe(1);
      expect(rows.map((r) => r["Variant SKU"]).sort()).toEqual([...skus].sort());
      // Only the first row of the handle carries the shared listing fields.
      expect(rows[0]?.Title).toBeTruthy();
      expect(rows[1]?.Title).toBe("");
      // Every row names its options, and carries this variant's own color/size — not blank, and
      // not the same value repeated for every variant (the bug the r1 review caught).
      const bySku: Record<string, { color: string; size: string }> = {
        "SKU-BLK-S": { color: "Black", size: "Small" },
        "SKU-BLK-M": { color: "Black", size: "Medium" },
        "SKU-WHT-S": { color: "White", size: "Small" },
        "SKU-WHT-M": { color: "White", size: "Medium" },
      };
      for (const r of rows) {
        expect(r["Option1 Name"]).toBe("Color");
        expect(r["Option2 Name"]).toBe("Size");
        const expected = bySku[r["Variant SKU"] as string];
        expect(r["Option1 Value"]).toBe(expected?.color);
        expect(r["Option2 Value"]).toBe(expected?.size);
      }
      // Each Handle + option-value combination is unique (no two rows collide in Shopify's own
      // importer).
      const combos = new Set(
        rows.map((r) => `${r.Handle}|${r["Option1 Value"]}|${r["Option2 Value"]}`),
      );
      expect(combos.size).toBe(rows.length);
    });

    it("rejects a channel that doesn't match the draft's own channel", async () => {
      const draft = await approvedDraft("etsy");
      await expect(
        withTenant(companyId, (tx) =>
          svc.exportListingsCsv(tx, ctx, { draftIds: [draft.id], channel: "shopify" }),
        ),
      ).rejects.toMatchObject({ code: "CHANNEL_MISMATCH" });
    });

    it("publishDraft's CSV fallback (B-101) uses real SKUs, not a DRAFT- placeholder", async () => {
      const draft = await approvedDraft("etsy");
      const [conn] = await withSystem((tx) =>
        tx
          .insert(channelConnections)
          .values({ companyId, channel: "etsy", name: "Etsy CSV", mode: "csv", provider: "mock" })
          .returning(),
      );
      const status = await withTenant(companyId, (tx) =>
        svc.publishDraft(tx, ctx, draft.id, conn?.id as string),
      );
      expect(status.status).toBe("approved");
      expect(status.pendingApproval).toBe(true);
      const [row] = await withSystem((tx) =>
        tx.select().from(listingDrafts).where(eq(listingDrafts.id, draft.id)),
      );
      const key = ((row?.publishedUrl as string) ?? "").replace(/^s3:/, "");
      const csv = (await getObject(key)).toString("utf8");
      const { rows } = parseCsvObjects(csv);
      expect(rows).toHaveLength(4);
      expect(rows.every((r) => !(r.sku ?? "").includes("DRAFT-"))).toBe(true);
      expect(rows.map((r) => r.sku).sort()).toEqual([...skus].sort());
    });

    it("production_partner_ids carries the Etsy partner id once one is set (T-8-1 AC2)", async () => {
      await withSystem((tx) =>
        tx
          .update(companies)
          .set({
            settings: { productionPartner: { name: "Cactus Print Co", etsyPartnerId: "12345" } },
          })
          .where(eq(companies.id, companyId)),
      );
      try {
        const draft = await approvedDraft("etsy");
        const { key } = await withTenant(companyId, (tx) =>
          svc.exportListingsCsv(tx, ctx, { draftIds: [draft.id], channel: "etsy" }),
        );
        const csv = (await getObject(key)).toString("utf8");
        const { rows } = parseCsvObjects(csv);
        expect(rows.every((r) => r.production_partner_ids === "12345")).toBe(true);
      } finally {
        await withSystem((tx) =>
          tx
            .update(companies)
            .set({
              settings: { productionPartner: { name: "Cactus Print Co", etsyPartnerId: null } },
            })
            .where(eq(companies.id, companyId)),
        );
      }
    });
  });

  describe("trademark gate (T-8-4, AC1/AC2/AC3/AC4)", () => {
    /** A needs_review draft with its `trademark` field forced to an exact score/level, so the
     * gate itself is under test rather than the trigram scoring (already covered above). */
    async function draftAt(riskScore: number, riskLevel: "low" | "medium" | "high") {
      const enq: string[] = [];
      svc.setGenerationEnqueuer(async (input) => {
        enq.push(...input.draftIds);
      });
      const { jobId, drafts } = await withTenant(companyId, (tx) =>
        svc.createDrafts(tx, ctx, { designId, channels: ["etsy"] }),
      );
      await svc.runGenerationJob({ companyId, jobId, draftIds: enq, userId: ctx.userId });
      const id = drafts[0]?.id as string;
      await withSystem((tx) =>
        tx
          .update(listingDrafts)
          .set({
            trademark: {
              riskScore,
              riskLevel,
              matches: [],
              explanation: "forced for the gate test",
              ocrText: null,
              checkedAt: new Date().toISOString(),
            },
          })
          .where(eq(listingDrafts.id, id)),
      );
      return id;
    }

    it("< 25 publishes clean", async () => {
      const id = await draftAt(10, "low");
      const approved = await withTenant(companyId, (tx) => svc.approveDraft(tx, ctx, id));
      expect(approved.status).toBe("approved");
    });

    it("25-59 blocks until recordTrademarkReview, then publishes", async () => {
      const id = await draftAt(40, "medium");
      await expect(
        withTenant(companyId, (tx) => svc.approveDraft(tx, ctx, id)),
      ).rejects.toMatchObject({ code: "TRADEMARK_REVIEW_REQUIRED", data: { riskScore: 40 } });
      // Recording a review only applies to a medium-risk draft.
      const other = await draftAt(10, "low");
      await expect(
        withTenant(companyId, (tx) => svc.recordTrademarkReview(tx, ctx, other, "not medium")),
      ).rejects.toMatchObject({ code: "TRADEMARK_REVIEW_NOT_APPLICABLE" });
      const reviewed = await withTenant(companyId, (tx) =>
        svc.recordTrademarkReview(
          tx,
          ctx,
          id,
          "Reviewed against the class-25 index; not a conflict",
        ),
      );
      expect(reviewed.trademarkReview?.reviewedBy).toBe(ctx.userId);
      expect(reviewed.trademarkReview?.note).toMatch(/not a conflict/);
      const approved = await withTenant(companyId, (tx) => svc.approveDraft(tx, ctx, id));
      expect(approved.status).toBe("approved");
    });

    it(">= 60 blocks even after a review is recorded", async () => {
      const id = await draftAt(80, "high");
      await expect(
        withTenant(companyId, (tx) => svc.recordTrademarkReview(tx, ctx, id, "trying anyway")),
      ).rejects.toMatchObject({ code: "TRADEMARK_REVIEW_NOT_APPLICABLE" });
      // Even a review recorded directly (e.g. stale from before the risk moved) never overrides.
      await withSystem((tx) =>
        tx
          .update(listingDrafts)
          .set({
            trademarkReviewedBy: ctx.userId,
            trademarkReviewedAt: new Date(),
            trademarkReviewNote: "stale review",
          })
          .where(eq(listingDrafts.id, id)),
      );
      await expect(
        withTenant(companyId, (tx) => svc.approveDraft(tx, ctx, id)),
      ).rejects.toMatchObject({ code: "HIGH_TRADEMARK_RISK" });
    });

    it("re-checks the current trademark field live at publish/export, not the value cached at approval", async () => {
      const id = await draftAt(10, "low");
      const approved = await withTenant(companyId, (tx) => svc.approveDraft(tx, ctx, id));
      expect(approved.status).toBe("approved");
      // The risk moves after approval (e.g. a mark added to the index since); publish/export must
      // re-read the draft's current field rather than trust what approve saw.
      await withSystem((tx) =>
        tx
          .update(listingDrafts)
          .set({
            trademark: {
              riskScore: 90,
              riskLevel: "high",
              matches: [],
              explanation: "risk moved after approval",
              ocrText: null,
              checkedAt: new Date().toISOString(),
            },
          })
          .where(eq(listingDrafts.id, id)),
      );
      const [conn] = await withSystem((tx) =>
        tx
          .insert(channelConnections)
          .values({
            companyId,
            channel: "etsy",
            name: "Etsy CSV (gate test)",
            mode: "csv",
            provider: "mock",
          })
          .returning(),
      );
      await expect(
        withTenant(companyId, (tx) => svc.publishDraft(tx, ctx, id, conn?.id as string)),
      ).rejects.toMatchObject({ code: "HIGH_TRADEMARK_RISK" });
      await expect(
        withTenant(companyId, (tx) =>
          svc.exportListingsCsv(tx, ctx, { draftIds: [id], channel: "etsy" }),
        ),
      ).rejects.toMatchObject({ code: "HIGH_TRADEMARK_RISK" });
    });
  });

  describe("AC7: a sample workspace never reaches the real model", () => {
    it("forces the mock provider even when a real ANTHROPIC_API_KEY is configured", async () => {
      const flags = env.mocks as unknown as { ai: boolean };
      const saved = flags.ai;
      flags.ai = false; // simulate ANTHROPIC_API_KEY being set
      try {
        const sampleCo = await createCompany();
        const owner = await createUser(sampleCo.id, "owner");
        await withSystem((tx) =>
          tx
            .update(companies)
            .set({ demoOwnerUserId: owner.id })
            .where(eq(companies.id, sampleCo.id)),
        );
        clearSampleWorkspaceCache();
        expect((await aiProvider(sampleCo.id)).name).toBe("mock");
        expect((await aiProvider(companyId)).name).toBe("anthropic");
      } finally {
        flags.ai = saved;
        clearSampleWorkspaceCache();
      }
    });
  });
});
