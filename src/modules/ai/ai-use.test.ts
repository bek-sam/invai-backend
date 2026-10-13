import type { DesignAiUse } from "@invai/contracts";
import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { listingCopyPrompt } from "../../ai/prompts";
import { mockProvider } from "../../ai/providers/mock";
import { AI_DISCLOSURE, PARTNER_DISCLOSURE, withDisclosures } from "../../ai/validators/listing";
import { anonymousContext, type Context, permissionsFor } from "../../api/context";
import { router } from "../../api/router";
import { withSystem, withTenant } from "../../db/client";
import {
  aiJobs,
  blankVariants,
  channelConnections,
  companies,
  designs,
  listingDrafts,
  products,
} from "../../db/schema";
import { parseCsvObjects } from "../../lib/csv";
import { getObject } from "../../lib/s3";
import { createCompany, createUser, tenantContext } from "../../test/fixtures";
import * as svc from "./service";

/*
 * T-48-4 (B-274): the AI-use line on listing drafts follows the design's `aiUse`. Spec
 * `listing-ai-disclosure.md` AC1-AC8, AC15. Drafts are generated through the real
 * createDrafts + runGenerationJob path with the mock provider; get, list, approve and the CSV
 * export go through the oRPC router. `vi.spyOn(mockProvider, "structured")` is the seam for the
 * retry, repeated-sentence and failure cases (the mock itself is always valid).
 */

const EN =
  "This design was created with the use of AI, then produced by us as a made-to-order DTF print.";
const ES =
  "Este diseño se creó con el uso de IA, y luego lo producimos como una transferencia DTF por encargo.";
const OLD_EN =
  "This design was created with the use of AI, based on our own prompts, then produced by us as a made-to-order DTF print.";
const OLD_ES =
  "Este diseño se creó con el uso de IA, a partir de nuestras propias indicaciones, y luego lo producimos como una transferencia DTF por encargo.";
const OLD_COMBINED = `${OLD_EN} / ${OLD_ES}`;
const ALL_FORMS = [EN, ES, OLD_EN, OLD_ES, OLD_COMBINED, AI_DISCLOSURE];

/** Does any AI-use sentence (new or old, en or es) appear in the text? */
const hasAi = (text: string) => ALL_FORMS.some((f) => text.includes(f));
const countAi = (text: string) => (text.match(/created with the use of AI/g) ?? []).length;

describe("AI-use notice follows the design (T-48-4)", () => {
  let companyId: string;
  let ctx: ReturnType<typeof tenantContext>;
  let rctx: Context;
  let seq = 0;
  const real = mockProvider.structured.bind(mockProvider);

  beforeAll(async () => {
    companyId = (await createCompany()).id;
    const owner = await createUser(companyId, "owner");
    ctx = tenantContext(companyId, owner.id, "owner");
    rctx = {
      ...anonymousContext(new Headers(), null),
      sessionKind: "user",
      user: { id: owner.id, name: "Owner", email: "owner@test.local" },
      companyId,
      orgType: "shop",
      role: "owner",
      permissions: permissionsFor("owner"),
    };
    await withSystem(async (tx) => {
      await tx
        .update(companies)
        .set({ settings: { productionPartner: { name: "Cactus Print Co", etsyPartnerId: null } } })
        .where(eq(companies.id, companyId));
      await tx.insert(blankVariants).values({
        companyId,
        brand: "Gildan",
        style: "64000",
        styleCode: "G64000",
        color: "Black",
        colorCode: "BLK",
        size: "Small",
        sizeCode: "S",
        sku: `AIU-SKU-${companyId.slice(0, 8)}`,
      });
    });
    svc.setGenerationEnqueuer(async () => {});
  });

  afterEach(() => vi.restoreAllMocks());

  async function mkDesign(aiUse: DesignAiUse, name = "Desert Sunset Cactus") {
    seq += 1;
    const [d] = await withSystem((tx) =>
      tx
        .insert(designs)
        .values({ companyId, code: `AIU-${seq}`, name, tags: ["cactus", "desert", "boho"], aiUse })
        .returning(),
    );
    const id = d?.id as string;
    await withSystem((tx) =>
      tx.insert(products).values({
        companyId,
        designId: id,
        brand: "Gildan",
        styleCode: "G64000",
        name: `Tee ${seq}`,
        allowedColorCodes: ["BLK"],
        allowedSizeCodes: ["S"],
      }),
    );
    return id;
  }

  const setAiUse = (designId: string, aiUse: DesignAiUse) =>
    call(router.designs.update, { id: designId, aiUse }, { context: rctx });

  /** Make a draft through the real queue path; `status` after the job is `needs_review`. */
  async function generate(designId: string, channel: "etsy" | "shopify" = "etsy") {
    const ids: string[] = [];
    svc.setGenerationEnqueuer(async (i) => {
      ids.push(...i.draftIds);
    });
    const { jobId, drafts } = await withTenant(companyId, (tx) =>
      svc.createDrafts(tx, ctx, { designId, channels: [channel] }),
    );
    await svc.runGenerationJob({ companyId, jobId, draftIds: ids, userId: ctx.userId });
    return drafts[0]?.id as string;
  }

  const getDraft = (id: string) => call(router.ai.listings.get, { id }, { context: rctx });
  const listDrafts = (designId: string) =>
    call(router.ai.listings.list, { designId, limit: 50 }, { context: rctx });
  const storedRow = async (id: string) =>
    (await withSystem((tx) => tx.select().from(listingDrafts).where(eq(listingDrafts.id, id))))[0];
  const setStatus = (
    id: string,
    status: "approved" | "publishing" | "published" | "needs_review",
  ) => withSystem((tx) => tx.update(listingDrafts).set({ status }).where(eq(listingDrafts.id, id)));

  /** The Etsy CSV description cell(s) for a draft, through `ai.exportCsv`. */
  async function csvDescription(id: string): Promise<string> {
    const { key } = await call(
      router.ai.exportCsv,
      { draftIds: [id], channel: "etsy" },
      { context: rctx },
    );
    const { rows } = parseCsvObjects((await getObject(key)).toString("utf8"));
    expect(rows.length).toBeGreaterThan(0);
    return rows[0]?.description ?? "";
  }

  /** Force the model output of the next calls; the call index starts at 0. */
  function forceOutput(
    mutate: (out: Record<string, unknown>, call: number) => Record<string, unknown>,
  ) {
    let n = 0;
    return vi.spyOn(mockProvider, "structured").mockImplementation(async (prompt, vars) => {
      const r = await real(prompt, vars);
      const i = n++;
      return prompt.id === listingCopyPrompt.id
        ? { ...r, output: mutate({ ...(r.output as Record<string, unknown>) }, i) as never }
        : r;
    });
  }

  const sentencesIn = (c: { description: string; disclosures: string[] }) =>
    [c.description, ...c.disclosures].join("\n");

  /* ------------------------------ generation: AC1, AC2 ------------------------------ */

  it("AC1: a 'none' design gets a draft with the partner line and no AI sentence (en or es, new or old)", async () => {
    const id = await generate(await mkDesign("none"));
    const d = await getDraft(id);
    expect(d.status).toBe("needs_review");
    expect(d.content.disclosures).toContain(PARTNER_DISCLOSURE);
    expect(hasAi(sentencesIn(d.content))).toBe(false);
    expect(countAi(sentencesIn(d.content))).toBe(0);
    expect(d.designAiUse).toBe("none");
    const stored = await storedRow(id);
    expect(hasAi(sentencesIn(stored?.content as never))).toBe(false);
  });

  it.each(["ai", "unknown"] as const)("AC2: a '%s' design gets both lines", async (aiUse) => {
    const id = await generate(await mkDesign(aiUse));
    const d = await getDraft(id);
    expect(d.content.disclosures).toContain(AI_DISCLOSURE);
    expect(d.content.disclosures).toContain(PARTNER_DISCLOSURE);
    expect(countAi(sentencesIn(d.content))).toBe(1);
    expect(d.designAiUse).toBe(aiUse);
    // The new wording only: no "based on our own prompts" clause.
    expect(sentencesIn(d.content)).not.toMatch(/our own prompts|nuestras propias indicaciones/);
  });

  it.each(["ai", "unknown", "none"] as const)(
    "AC2-retry: the validation-retry path honours '%s'",
    async (aiUse) => {
      const designId = await mkDesign(aiUse);
      // First model output breaks the Etsy title limit, the second is valid.
      const spy = forceOutput((out, i) => (i === 0 ? { ...out, title: "x".repeat(150) } : out));
      const id = await generate(designId);
      expect(spy).toHaveBeenCalledTimes(2);
      const d = await getDraft(id);
      expect(d.status).toBe("needs_review");
      expect(d.content.title.length).toBeLessThanOrEqual(140);
      expect(d.content.disclosures).toContain(PARTNER_DISCLOSURE);
      expect(countAi(sentencesIn(d.content))).toBe(aiUse === "none" ? 0 : 1);
      // Stored row too (the retry's content is what was saved).
      const stored = await storedRow(id);
      expect(countAi(sentencesIn(stored?.content as never))).toBe(aiUse === "none" ? 0 : 1);
    },
  );

  /* ------------------------------ AC5, AC5b ------------------------------ */

  it("AC5: for 'none' the sentence is cut from the description (mid and last, old and new, en and es), nothing else changes", async () => {
    const designId = await mkDesign("none");
    const baseId = await generate(designId);
    const base = await storedRow(baseId);
    const baseContent = base?.content as NonNullable<typeof base>["content"];
    const cases: [string, string, string][] = [
      ["mid, new en", `Soft tee.\n${EN} Great fit.`, "Soft tee.\n\nGreat fit."],
      ["mid, old es", `Soft tee. ${OLD_ES}\n\n\nGreat fit.`, "Soft tee.\n\nGreat fit."],
      ["last, new es", `Soft tee.\n\n${ES}`, "Soft tee."],
      ["last, old combined", `Soft tee.\n\n${OLD_COMBINED}\n`, "Soft tee."],
    ];
    for (const [label, description, expected] of cases) {
      forceOutput((out) => ({ ...out, description }));
      const id = await generate(designId);
      vi.restoreAllMocks();
      const stored = (await storedRow(id))?.content as typeof baseContent;
      expect(stored.description, label).toBe(expected);
      expect(stored.title, label).toBe(baseContent.title);
      expect(stored.tags, label).toEqual(baseContent.tags);
      expect(stored.bullets, label).toEqual(baseContent.bullets);
      expect(stored.disclosures, label).toEqual(baseContent.disclosures);
      expect(stored.disclosures, label).toContain(PARTNER_DISCLOSURE);
      expect(hasAi(sentencesIn(stored)), label).toBe(false);
    }
  });

  it.each(["ai", "unknown"] as const)(
    "AC5b: for '%s' a repeated sentence in the description appears exactly once (stored, read, CSV cell)",
    async (aiUse) => {
      const designId = await mkDesign(aiUse);
      forceOutput((out) => ({
        ...out,
        description: `Soft tee.\n\n${EN}\n\n${OLD_ES}\n\nGreat fit.`,
      }));
      const id = await generate(designId);
      vi.restoreAllMocks();
      const stored = (await storedRow(id))?.content as {
        description: string;
        disclosures: string[];
      };
      expect(countAi(sentencesIn(stored))).toBe(1);
      expect(stored.description).toBe("Soft tee.\n\nGreat fit.");
      expect(stored.disclosures.filter((d) => d === AI_DISCLOSURE)).toHaveLength(1);
      const read = await getDraft(id);
      expect(countAi(sentencesIn(read.content))).toBe(1);
      expect(countAi(await csvDescription(id))).toBe(1);
    },
  );

  /* ------------------------------ AC6: read-time recompute ------------------------------ */

  it("AC6: an open draft follows a later design change on get, list and both CSV paths; the stored row and credits do not move", async () => {
    const designId = await mkDesign("unknown");
    const id = await generate(designId);
    const row0 = await storedRow(id);
    const jobsBefore = (
      await withSystem((tx) => tx.select().from(aiJobs).where(eq(aiJobs.companyId, companyId)))
    ).length;
    expect(countAi(sentencesIn(row0?.content as never))).toBe(1);

    await setAiUse(designId, "none");
    const viaGet = await getDraft(id);
    const viaList = (await listDrafts(designId)).items.find((x) => x.id === id);
    expect(hasAi(sentencesIn(viaGet.content))).toBe(false);
    expect(hasAi(sentencesIn(viaList?.content as never))).toBe(false);
    expect(viaGet.designAiUse).toBe("none");
    expect(viaList?.designAiUse).toBe("none");
    // Both CSV paths: `ai.exportCsv` (batch) and `ai.listings.publish` (single).
    expect(hasAi(await csvDescription(id))).toBe(false);
    const row1 = await storedRow(id);
    expect(row1?.content).toEqual(row0?.content);
    expect(row1?.creditsUsed).toBe(row0?.creditsUsed);
    const jobsAfter = (
      await withSystem((tx) => tx.select().from(aiJobs).where(eq(aiJobs.companyId, companyId)))
    ).length;
    expect(jobsAfter).toBe(jobsBefore);

    await setAiUse(designId, "unknown");
    expect(countAi(sentencesIn((await getDraft(id)).content))).toBe(1);
    expect(
      countAi(
        sentencesIn((await listDrafts(designId)).items.find((x) => x.id === id)?.content as never),
      ),
    ).toBe(1);
    expect(countAi(await csvDescription(id))).toBe(1);
  });

  it("AC6: the boundary statuses: approved is recomputed, publishing and published are not", async () => {
    for (const status of ["approved", "publishing", "published"] as const) {
      const designId = await mkDesign("unknown");
      const id = await generate(designId);
      await setStatus(id, status);
      await setAiUse(designId, "none");
      const d = await getDraft(id);
      const recomputed = status === "approved";
      expect(hasAi(sentencesIn(d.content)), status).toBe(!recomputed);
      expect(d.designAiUse, status).toBe(recomputed ? "none" : "ai");
      expect(countAi(sentencesIn((await storedRow(id))?.content as never)), status).toBe(1);
    }
  });

  it("AC6b: an old-wording stored line reads as nothing for 'none' and as the new wording for ai/unknown; approve validates the recomputed content", async () => {
    for (const aiUse of ["none", "unknown", "ai"] as const) {
      const designId = await mkDesign(aiUse);
      const id = await generate(designId);
      const row = await storedRow(id);
      const old = {
        ...(row?.content as object),
        disclosures: [OLD_COMBINED],
      };
      await withSystem((tx) =>
        tx
          .update(listingDrafts)
          .set({ content: old as never })
          .where(eq(listingDrafts.id, id)),
      );
      const d = await getDraft(id);
      if (aiUse === "none") expect(hasAi(sentencesIn(d.content))).toBe(false);
      else {
        expect(d.content.disclosures).toContain(AI_DISCLOSURE);
        expect(d.content.disclosures).not.toContain(OLD_COMBINED);
        expect(sentencesIn(d.content)).not.toMatch(/our own prompts|nuestras propias indicaciones/);
      }
      // The stored disclosures have no partner line; the recomputed content does, so approval is
      // judged on what a reader sees.
      const approved = await call(router.ai.listings.approve, { id }, { context: rctx });
      expect(approved.status).toBe("approved");
      expect(approved.content.disclosures).toContain(PARTNER_DISCLOSURE);
    }
  });

  it("AC6b-approve: approval judges the recomputed content (a stored draft with no disclosures still approves)", async () => {
    const designId = await mkDesign("none");
    const id = await generate(designId);
    const row = await storedRow(id);
    await withSystem((tx) =>
      tx
        .update(listingDrafts)
        .set({ content: { ...(row?.content as object), disclosures: [] } as never })
        .where(eq(listingDrafts.id, id)),
    );
    const approved = await call(router.ai.listings.approve, { id }, { context: rctx });
    expect(approved.status).toBe("approved");
    expect(approved.content.disclosures).toEqual([PARTNER_DISCLOSURE]);
  });

  /* ------------------------------ AC7: what went out stays ------------------------------ */

  it("AC7: publishing a draft persists the recomputed content; a later design change leaves a published draft as sent", async () => {
    const designId = await mkDesign("unknown");
    const id = await generate(designId);
    await call(router.ai.listings.approve, { id }, { context: rctx });
    await setAiUse(designId, "none");
    const [conn] = await withSystem((tx) =>
      tx
        .insert(channelConnections)
        .values({
          companyId,
          channel: "csv",
          name: "CSV",
          status: "connected",
          externalShopId: `csv-${companyId}`,
        })
        .returning(),
    );
    await call(
      router.ai.listings.publish,
      { id, connectionId: conn?.id as string },
      { context: rctx },
    );
    // The stored row now holds what went out: no AI line.
    expect(hasAi(sentencesIn((await storedRow(id))?.content as never))).toBe(false);
    // Frozen as sent: a later switch back to 'ai' does not rewrite it.
    await setStatus(id, "published");
    await setAiUse(designId, "ai");
    const d = await getDraft(id);
    expect(hasAi(sentencesIn(d.content))).toBe(false);
    expect(d.designAiUse).toBe("none");
  });

  /* ------------------------------ AC8 ------------------------------ */

  it("AC8a: an archived design keeps its stored value ('none' stays off)", async () => {
    const designId = await mkDesign("none");
    const id = await generate(designId);
    await call(router.designs.archive, { id: designId }, { context: rctx });
    const d = await getDraft(id);
    expect(hasAi(sentencesIn(d.content))).toBe(false);
    expect(d.designAiUse).toBe("none");
  });

  it("AC8b: a deleted design row reads as 'unknown' (notice on) on get, list, approve and CSV, with no error", async () => {
    const designId = await mkDesign("none");
    const id = await generate(designId);
    expect(hasAi(sentencesIn((await getDraft(id)).content))).toBe(false);
    // The CSV needs a product: point the draft at another design's product, then delete the design.
    const otherDesign = await mkDesign("unknown");
    const [otherProduct] = await withSystem((tx) =>
      tx.select().from(products).where(eq(products.designId, otherDesign)),
    );
    await withSystem(async (tx) => {
      await tx
        .update(listingDrafts)
        .set({ productId: otherProduct?.id as string })
        .where(eq(listingDrafts.id, id));
      await tx.delete(products).where(eq(products.designId, designId));
      await tx.delete(designs).where(eq(designs.id, designId));
    });
    const d = await getDraft(id);
    expect(d.designAiUse).toBe("unknown");
    expect(countAi(sentencesIn(d.content))).toBe(1);
    const listed = (await listDrafts(designId)).items.find((x) => x.id === id);
    expect(listed?.designAiUse).toBe("unknown");
    expect(countAi(sentencesIn(listed?.content as never))).toBe(1);
    expect((await call(router.ai.listings.approve, { id }, { context: rctx })).status).toBe(
      "approved",
    );
    expect(countAi(await csvDescription(id))).toBe(1);
  });

  /* ------------------------------ AC15 ------------------------------ */

  it("AC15: a provider failure leaves a failed draft with no content, never needs_review; a missing design fails with NOT_FOUND", async () => {
    const designId = await mkDesign("none");
    vi.spyOn(mockProvider, "structured").mockRejectedValue(new Error("provider down"));
    const id = await generate(designId);
    vi.restoreAllMocks();
    const row = await storedRow(id);
    expect(row?.status).toBe("failed");
    const failedContent = row?.content as { title: string; disclosures: string[] };
    expect(failedContent.title).toBe("");
    expect(failedContent.disclosures).toEqual([]);
    const d = await getDraft(id);
    expect(d.status).toBe("failed");
    expect(d.content.disclosures).toEqual([]);

    // Design row gone before the worker runs: the existing not-found error, draft never ready.
    const gone = await mkDesign("unknown");
    const ids: string[] = [];
    svc.setGenerationEnqueuer(async (i) => {
      ids.push(...i.draftIds);
    });
    await withTenant(companyId, (tx) =>
      svc.createDrafts(tx, ctx, { designId: gone, channels: ["etsy"] }),
    );
    await withSystem(async (tx) => {
      await tx.delete(products).where(eq(products.designId, gone));
      await tx.delete(designs).where(eq(designs.id, gone));
    });
    await expect(svc.generateDraft(companyId, ids[0] as string, ctx.userId)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect((await storedRow(ids[0] as string))?.status).toBe("generating");
  });

  /* ------------------------------ the pure rule ------------------------------ */

  it("withDisclosures is idempotent and keeps other disclosures and their order", () => {
    const base = {
      title: "t",
      description: `Intro.\n\n${EN}\n\nOutro.`,
      tags: [],
      bullets: [],
      attributes: {},
      price: null,
      disclosures: ["Custom note", OLD_COMBINED, "Another note"],
      productionPartner: null,
    };
    for (const aiUse of ["ai", "unknown", "none"] as const) {
      const once = withDisclosures(base, { aiUse });
      expect(withDisclosures(once, { aiUse })).toEqual(once);
      expect(once.disclosures).toContain("Custom note");
      expect(once.disclosures).toContain("Another note");
      expect(once.description).toBe("Intro.\n\nOutro.");
    }
    expect(withDisclosures(base, { aiUse: "ai" }).disclosures).toEqual([
      "Custom note",
      AI_DISCLOSURE,
      "Another note",
      PARTNER_DISCLOSURE,
    ]);
  });
});
