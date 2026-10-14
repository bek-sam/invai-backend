import { ORPCError } from "@orpc/server";
import { desc, eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mockProvider } from "../../ai/providers/mock";
import { AiRefusalError } from "../../ai/providers/types";
import { storedErrorText } from "../../ai/stored-error";
import { withSystem, withTenant } from "../../db/client";
import { aiJobs, designs, listingDrafts, outboxEvents } from "../../db/schema";
import { upstream } from "../../lib/errors";
import { createCompany, createUser, tenantContext } from "../../test/fixtures";
import * as svc from "./service";

const EMAIL = "jane.doe@example.com";
const STREET = "123 Main Street";
const LEAKY = `400 invalid_request: prompt for ${EMAIL} shipping to ${STREET}, Phoenix AZ`;

function expectClean(text: string | null | undefined) {
  expect(text).toBeTruthy();
  expect(text).not.toContain(EMAIL);
  expect(text).not.toContain("jane.doe");
  expect(text).not.toContain("Main Street");
}

describe("AI stored error text (T-35-4, B-353)", () => {
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
        .values({ companyId, code: "D-ERR", name: "Error Cactus", tags: ["cactus"] })
        .returning(),
    );
    designId = d?.id as string;
  });

  afterEach(() => vi.restoreAllMocks());

  async function failedDraft(error: unknown) {
    vi.spyOn(mockProvider, "structured").mockRejectedValue(error);
    const ids: string[] = [];
    svc.setGenerationEnqueuer(async (input) => {
      ids.push(...input.draftIds);
    });
    const { jobId, drafts } = await withTenant(companyId, (tx) =>
      svc.createDrafts(tx, ctx, { designId, channels: ["shopify"] }),
    );
    await svc.runGenerationJob({ companyId, jobId, draftIds: ids, userId: ctx.userId });
    const draftId = drafts[0]?.id as string;
    return withTenant(companyId, async (tx) => {
      const [draft] = await tx.select().from(listingDrafts).where(eq(listingDrafts.id, draftId));
      const [job] = await tx.select().from(aiJobs).orderBy(desc(aiJobs.createdAt)).limit(1);
      const events = await tx.select().from(outboxEvents);
      const failed = events.filter(
        (e) =>
          e.name === "listing_draft.failed" &&
          (e.payload as { draftId?: string }).draftId === draftId,
      );
      return { draft, job, failed };
    });
  }

  it("a provider failure with an email and a street stores neither (draft row, event, ai job)", async () => {
    const { draft, job, failed } = await failedDraft(new Error(LEAKY));
    expect(draft?.status).toBe("failed");
    expectClean(draft?.error);
    expect(draft?.error).toMatch(/Try again/);
    expect(job?.status).toBe("failed");
    expectClean(job?.error);
    expect(failed).toHaveLength(1);
    expectClean(String(failed[0]?.payload.error));
    expect(JSON.stringify(failed[0]?.payload)).not.toContain(EMAIL);
  });

  it("a refusal whose detail echoes buyer text stores the fixed upstream sentence", async () => {
    const { draft, job } = await failedDraft(new AiRefusalError(LEAKY));
    expectClean(draft?.error);
    expect(draft?.error).toContain("(UPSTREAM_FAILED)");
    expectClean(job?.error);
  });

  it("storedErrorText keeps a typed error's own fixed message and falls back to 'failed'", () => {
    expect(storedErrorText(upstream("Claude", LEAKY))).not.toContain(EMAIL);
    expect(storedErrorText(upstream("Claude", LEAKY))).toBe(
      "Claude could not finish this request. Try again in a minute. (UPSTREAM_FAILED)",
    );
    expect(storedErrorText(new Error(LEAKY))).not.toContain("Main Street");
    expect(storedErrorText(new Error(LEAKY))).toMatch(/\(INTERNAL\)$/);
  });
});

describe("storedErrorText cut (T-51-4)", () => {
  it("never ends in half an emoji", () => {
    const err = new ORPCError("BAD_REQUEST", { message: `${"a".repeat(299)}\u{1F600}` });
    expect(storedErrorText(err)).toBe("a".repeat(299));
  });
  it("cuts after the PII strip, so a cut never leaves half an address", () => {
    const err = new ORPCError("BAD_REQUEST", { message: `${"a".repeat(285)} buyer@example.com` });
    expect(storedErrorText(err)).not.toContain("buyer@");
  });
});
