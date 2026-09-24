import { ORPCError } from "@orpc/server";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { assertCredits } from "../../ai/credits";
import { withSystem, withTenant } from "../../db/client";
import { designs, listingDrafts, usage } from "../../db/schema";
import { createCompany, createUser, tenantContext } from "../../test/fixtures";
import { periodOf } from "../billing/service";
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
      withTenant(companyId, (tx) => svc.approveDraft(tx, ctx, etsy.id, false)),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    // A trademark in the title requires acknowledging the risk.
    await withTenant(companyId, (tx) =>
      svc.updateDraft(tx, ctx, etsy.id, { title: "Just Do It Nike Cactus Shirt" }),
    );
    await expect(
      withTenant(companyId, (tx) => svc.approveDraft(tx, ctx, etsy.id, false)),
    ).rejects.toMatchObject({
      code: "HIGH_TRADEMARK_RISK",
    });
    const approved = await withTenant(companyId, (tx) => svc.approveDraft(tx, ctx, etsy.id, true));
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
});
