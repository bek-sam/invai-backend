import type {
  AssistantEvent,
  Channel,
  CreditEntry,
  ListingContent,
  ListingDraft,
  PublishStatus as PublishStatusSchema,
  TrademarkCheck,
  ValidationResult,
} from "@invai/contracts";
import { CHANNEL_RULES, RecommendationRef } from "@invai/contracts";
import { ORPCError } from "@orpc/server";
import { and, asc, desc, eq, gte, ilike, inArray, lte, or, type SQL, sql } from "drizzle-orm";
import type { z } from "zod";
import { assertCredits, creditBalance } from "../../ai/credits";
import { runAssistant, runStructured, sanitizeDeep, sanitizeText } from "../../ai/gateway";
import { ASSISTANT_PROMPT, type ListingCopy, listingCopyPrompt } from "../../ai/prompts";
import {
  describeIssues,
  normalizeListing,
  validateListing,
  withDisclosures,
} from "../../ai/validators/listing";
import type { TenantContext } from "../../api/context";
import { afterCommit, type Tx, withTenant } from "../../db/client";
import {
  aiCreditLedger,
  assistantConversations,
  assistantMessages,
  blankVariants,
  channelConnections,
  companies,
  designs,
  jobs,
  listingDrafts,
  products,
} from "../../db/schema";
import { audit } from "../../lib/audit";
import { toCsv } from "../../lib/csv";
import { badRequest, conflict, invalidTransition, notFound } from "../../lib/errors";
import { logger } from "../../lib/log";
import { emit } from "../../lib/outbox";
import { keyset, type PageInput } from "../../lib/pagination";
import { publish } from "../../lib/realtime";
import { objectKey, presignGet, putObject } from "../../lib/s3";
import { recordRecommendationsShown } from "../market/service";
import { assistantTools } from "./assistant-tools";
import { assertTrademarkGate, checkTrademarks, type TmInput } from "./trademark";

const log = logger("ai");

type PublishStatus = z.infer<typeof PublishStatusSchema>;
type AssistantToolName = Extract<AssistantEvent, { type: "tool_call" }>["name"];

/*
 * AI module: listing drafts (generate → review → approve → publish/export), deterministic
 * validation, trademark risk, the streaming business assistant and the credit ledger.
 * Model calls go through src/ai/gateway.ts; nothing is published without human approval.
 */

type DraftRow = typeof listingDrafts.$inferSelect;
type Ctx = TenantContext;

const EXPORT_PREFIX = "s3:";

/* ---------------------------------- mapping ---------------------------------- */

async function toDraft(row: DraftRow, designName: string): Promise<ListingDraft> {
  let publishedUrl: string | null = row.publishedUrl;
  if (publishedUrl?.startsWith(EXPORT_PREFIX)) {
    publishedUrl = await presignGet(
      publishedUrl.slice(EXPORT_PREFIX.length),
      3600,
      `${row.channel}-listing-${row.id.slice(0, 8)}.csv`,
    );
  }
  return {
    id: row.id,
    designId: row.designId,
    designName,
    channel: row.channel,
    connectionId: row.connectionId,
    productId: row.productId,
    status: row.status,
    content: row.content,
    validation: (row.validation as ValidationResult | null) ?? null,
    trademark: (row.trademark as TrademarkCheck | null) ?? null,
    trademarkReview: row.trademarkReviewedBy
      ? {
          reviewedBy: row.trademarkReviewedBy,
          reviewedAt: (row.trademarkReviewedAt as Date).toISOString(),
          note: row.trademarkReviewNote ?? "",
        }
      : null,
    mockupKeys: row.mockupKeys,
    model: row.model,
    creditsUsed: row.creditsUsed,
    approvedBy: row.approvedBy,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    rejectedReason: row.rejectedReason,
    publishedListingId: row.publishedListingId,
    publishedUrl,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function designNames(tx: Tx, ids: string[]) {
  if (!ids.length) return new Map<string, string>();
  const rows = await tx
    .select({ id: designs.id, name: designs.name })
    .from(designs)
    .where(inArray(designs.id, [...new Set(ids)]));
  return new Map(rows.map((r) => [r.id, r.name]));
}

async function mapDrafts(tx: Tx, rows: DraftRow[]) {
  const names = await designNames(
    tx,
    rows.map((r) => r.designId),
  );
  return Promise.all(rows.map((r) => toDraft(r, names.get(r.designId) ?? "")));
}

async function loadDraft(tx: Tx, ctx: Pick<Ctx, "companyId">, id: string, lock = false) {
  const q = tx
    .select()
    .from(listingDrafts)
    .where(and(eq(listingDrafts.companyId, ctx.companyId), eq(listingDrafts.id, id)));
  const [row] = lock ? await q.for("update") : await q;
  if (!row) throw notFound("listing draft", id);
  return row;
}

export async function getDraft(tx: Tx, ctx: Ctx, id: string): Promise<ListingDraft> {
  const row = await loadDraft(tx, ctx, id);
  const [d] = await mapDrafts(tx, [row]);
  return d as ListingDraft;
}

export type DraftListInput = PageInput & {
  status?: DraftRow["status"][];
  channel?: Channel;
  designId?: string;
  search?: string;
};

export async function listDrafts(tx: Tx, ctx: Ctx, input: DraftListInput) {
  const filters: (SQL | undefined)[] = [eq(listingDrafts.companyId, ctx.companyId)];
  if (input.channel) filters.push(eq(listingDrafts.channel, input.channel));
  if (input.designId) filters.push(eq(listingDrafts.designId, input.designId));
  if (input.search) {
    const q = `%${input.search.trim()}%`;
    filters.push(
      or(
        sql`${listingDrafts.content}->>'title' ilike ${q}`,
        inArray(
          listingDrafts.designId,
          tx.select({ id: designs.id }).from(designs).where(ilike(designs.name, q)),
        ),
      ),
    );
  }
  const countRows = await tx
    .select({ status: listingDrafts.status, n: sql<number>`count(*)::int` })
    .from(listingDrafts)
    .where(and(...filters))
    .groupBy(listingDrafts.status);
  if (input.status?.length) filters.push(inArray(listingDrafts.status, input.status));
  const page = keyset(listingDrafts.createdAt, listingDrafts.id, input);
  const rows = await tx
    .select()
    .from(listingDrafts)
    .where(and(...filters, page.where))
    .orderBy(...page.orderBy)
    .limit(page.limit + 1);
  const trimmed = page.result(rows, (r) => r);
  const counts = Object.fromEntries(
    (
      [
        "generating",
        "needs_review",
        "approved",
        "rejected",
        "publishing",
        "published",
        "failed",
      ] as const
    ).map((s) => [s, countRows.find((c) => c.status === s)?.n ?? 0]),
  ) as Record<DraftRow["status"], number>;
  return { items: await mapDrafts(tx, trimmed.items), nextCursor: trimmed.nextCursor, counts };
}

/* ---------------------------------- creation ---------------------------------- */

async function createJobRow(tx: Tx, ctx: Ctx, input: Record<string, unknown>) {
  const [job] = await tx
    .insert(jobs)
    .values({
      companyId: ctx.companyId,
      kind: "listing_drafts",
      status: "queued",
      input,
      createdBy: ctx.userId,
    })
    .returning({ id: jobs.id });
  if (!job) throw new Error("jobs insert failed");
  return job.id;
}

/** Hook the jobs module sets so this file does not import jobs.ts (cycle). */
let enqueueGeneration: (input: {
  companyId: string;
  jobId: string;
  draftIds: string[];
  userId: string | null;
}) => Promise<void> = async () => {
  throw new Error("listing generation job not registered");
};
export function setGenerationEnqueuer(fn: typeof enqueueGeneration) {
  enqueueGeneration = fn;
}

export async function createDrafts(
  tx: Tx,
  ctx: Ctx,
  input: {
    designId: string;
    channels: Channel[];
    productId?: string;
    brief?: string;
    batch?: boolean;
  },
) {
  const [design] = await tx
    .select({ id: designs.id })
    .from(designs)
    .where(and(eq(designs.companyId, ctx.companyId), eq(designs.id, input.designId)));
  if (!design) throw notFound("design", input.designId);
  if (input.productId) {
    const [p] = await tx
      .select({ id: products.id })
      .from(products)
      .where(and(eq(products.id, input.productId), eq(products.designId, input.designId)));
    if (!p) throw badRequest("Product does not belong to this design");
  }
  const channels = [...new Set(input.channels)];
  await assertCredits(tx, ctx.companyId, channels.length);
  const jobId = await createJobRow(tx, ctx, { designId: input.designId, channels });
  const rows = await tx
    .insert(listingDrafts)
    .values(
      channels.map((channel) => ({
        companyId: ctx.companyId,
        designId: input.designId,
        channel,
        productId: input.productId ?? null,
        status: "generating" as const,
        brief: input.brief ?? null,
      })),
    )
    .returning();
  await audit(tx, {
    companyId: ctx.companyId,
    actor: ctx.actor,
    action: "listing_draft.create",
    entityType: "design",
    entityId: input.designId,
    summary: `AI drafts for ${channels.join(", ")}`,
    data: { draftIds: rows.map((r) => r.id), jobId },
  });
  const draftIds = rows.map((r) => r.id);
  afterCommit(tx, () =>
    enqueueGeneration({ companyId: ctx.companyId, jobId, draftIds, userId: ctx.userId }),
  );
  return { jobId, drafts: await mapDrafts(tx, rows) };
}

export async function regenerateDraft(tx: Tx, ctx: Ctx, id: string, brief?: string) {
  const row = await loadDraft(tx, ctx, id, true);
  if (row.status === "publishing" || row.status === "published" || row.status === "generating")
    throw invalidTransition("listing_draft", id, row.status, "generating");
  await assertCredits(tx, ctx.companyId, 1);
  const jobId = await createJobRow(tx, ctx, { draftIds: [id], regenerate: true });
  await tx
    .update(listingDrafts)
    .set({
      status: "generating",
      brief: brief ?? row.brief,
      error: null,
      approvedAt: null,
      approvedBy: null,
      rejectedReason: null,
    })
    .where(eq(listingDrafts.id, id));
  afterCommit(tx, () =>
    enqueueGeneration({ companyId: ctx.companyId, jobId, draftIds: [id], userId: ctx.userId }),
  );
  return { jobId };
}

async function generationContext(tx: Tx, row: DraftRow) {
  const [design] = await tx.select().from(designs).where(eq(designs.id, row.designId));
  if (!design) throw notFound("design", row.designId);
  const [product] = row.productId
    ? await tx.select().from(products).where(eq(products.id, row.productId))
    : await tx
        .select()
        .from(products)
        .where(and(eq(products.designId, row.designId), eq(products.status, "active")))
        .orderBy(asc(products.createdAt))
        .limit(1);
  let blank: { brand: string; style: string; styleName: string | null; colors: string[] } | null =
    null;
  if (product) {
    const variants = await tx
      .select({
        brand: blankVariants.brand,
        style: blankVariants.style,
        styleName: blankVariants.styleName,
        color: blankVariants.color,
        colorCode: blankVariants.colorCode,
      })
      .from(blankVariants)
      .where(
        and(
          eq(blankVariants.companyId, row.companyId),
          eq(blankVariants.styleCode, product.styleCode),
        ),
      );
    const allowed = new Set(product.allowedColorCodes);
    const colors = [
      ...new Set(
        variants.filter((v) => !allowed.size || allowed.has(v.colorCode)).map((v) => v.color),
      ),
    ];
    blank = {
      brand: product.brand,
      style: product.styleCode,
      styleName: variants[0]?.styleName ?? variants[0]?.style ?? null,
      colors,
    };
  }
  const price =
    product?.prices.find((p) => p.channel === row.channel)?.price ??
    product?.prices[0]?.price ??
    null;
  return {
    design,
    product: product ?? null,
    blank,
    price,
    productionPartner: await productionPartner(tx, row.companyId),
  };
}

/** `companies.settings.productionPartner`, or null. Never model-generated (wave.md Contract stubs / C). */
async function productionPartner(tx: Tx, companyId: string) {
  const [row] = await tx
    .select({ settings: companies.settings })
    .from(companies)
    .where(eq(companies.id, companyId));
  return row?.settings?.productionPartner ?? null;
}

function toContent(
  copy: ListingCopy,
  price: number | null,
  productionPartner: { name: string; etsyPartnerId: string | null } | null,
): ListingContent {
  return {
    title: copy.title,
    description: copy.description,
    tags: copy.tags,
    bullets: copy.bullets,
    attributes: Object.fromEntries(copy.attributes.map((a) => [a.key, a.value])),
    price,
    disclosures: [],
    productionPartner: productionPartner?.name ?? null,
  };
}

function trademarkSources(content: Partial<ListingContent>, designText: string | null): TmInput {
  const out: TmInput = [];
  if (content.title) out.push({ source: "title", text: content.title });
  if (content.tags?.length) out.push({ source: "tags", text: content.tags.join(" | ") });
  if (content.description) out.push({ source: "description", text: content.description });
  if (designText) out.push({ source: "design_text", text: designText });
  return out;
}

async function setJobProgress(
  companyId: string,
  jobId: string,
  patch: {
    status: "running" | "done" | "failed";
    progress: number;
    message?: string | null;
    resultIds?: string[];
    error?: string | null;
  },
) {
  await withTenant(companyId, (tx) =>
    tx
      .update(jobs)
      .set({
        status: patch.status,
        progress: patch.progress,
        message: patch.message ?? null,
        resultIds: patch.resultIds,
        error: patch.error ?? null,
        finishedAt: patch.status === "running" ? null : new Date(),
      })
      .where(eq(jobs.id, jobId)),
  );
  await publish(companyId, {
    type: "job.progress",
    data: {
      jobId,
      kind: "listing_drafts",
      status: patch.status,
      progress: patch.progress,
      message: patch.message ?? null,
      resultIds: patch.resultIds ?? [],
    },
  });
}

/**
 * Generate one draft (worker). One structured call, deterministic fixes, channel validation and,
 * when rules are broken, exactly one retry with the errors attached. Then disclosures and the
 * trademark check. Ends in `needs_review` (or `failed`).
 */
export async function generateDraft(companyId: string, draftId: string, userId: string | null) {
  const ctx = { companyId, userId };
  const { row, gen } = await withTenant(companyId, async (tx) => {
    const row = await loadDraft(tx, ctx, draftId);
    return { row, gen: await generationContext(tx, row) };
  });
  if (row.status !== "generating") return { skipped: true };
  const meta = {
    companyId,
    userId,
    kind: "listing_draft" as const,
    creditKind: "listing_draft" as const,
    entity: { type: "listing_draft", id: draftId },
  };
  try {
    const vars = {
      channel: row.channel,
      designName: gen.design.name,
      designTags: gen.design.tags,
      designText: gen.design.ocrText,
      blank: gen.blank,
      brief: row.brief,
      fixErrors: null as string | null,
    };
    let first = await runStructured(meta, listingCopyPrompt, vars);
    let credits = first.credits;
    let content = withDisclosures(
      normalizeListing(row.channel, toContent(first.output, gen.price, gen.productionPartner)),
    );
    let validation = validateListing(row.channel, content);
    if (!validation.ok) {
      const retry = await runStructured(meta, listingCopyPrompt, {
        ...vars,
        fixErrors: describeIssues(validation),
      });
      credits += retry.credits;
      first = retry;
      content = withDisclosures(
        normalizeListing(row.channel, toContent(retry.output, gen.price, gen.productionPartner)),
      );
      validation = validateListing(row.channel, content);
    }
    const trademark = await withTenant(companyId, (tx) =>
      checkTrademarks(tx, ctx, trademarkSources(content, gen.design.ocrText), {
        ocrText: gen.design.ocrText,
        entity: { type: "listing_draft", id: draftId },
      }),
    );
    await withTenant(companyId, async (tx) => {
      await tx
        .update(listingDrafts)
        .set({
          status: "needs_review",
          content,
          validation,
          trademark,
          model: first.model,
          aiJobId: first.aiJobId,
          creditsUsed: sql`${listingDrafts.creditsUsed} + ${credits}`,
          error: null,
        })
        .where(eq(listingDrafts.id, draftId));
      await emit(tx, companyId, "listing_draft.ready", {
        draftId,
        designId: row.designId,
        channel: row.channel,
      });
    });
    await publish(companyId, {
      type: "listing_draft.updated",
      data: { draftId, status: "needs_review" },
    });
    return { ok: validation.ok, credits };
  } catch (err) {
    const message = err instanceof ORPCError ? err.message : (err as Error).message;
    await withTenant(companyId, async (tx) => {
      await tx
        .update(listingDrafts)
        .set({ status: "failed", error: message })
        .where(eq(listingDrafts.id, draftId));
      await emit(tx, companyId, "listing_draft.failed", { draftId, error: message });
    });
    await publish(companyId, {
      type: "listing_draft.updated",
      data: { draftId, status: "failed" },
    });
    log.warn("draft generation failed", { draftId, error: message });
    return { ok: false, error: message };
  }
}

/** Worker body for one `listing_drafts` job. */
export async function runGenerationJob(input: {
  companyId: string;
  jobId: string;
  draftIds: string[];
  userId: string | null;
}) {
  const { companyId, jobId, draftIds } = input;
  await setJobProgress(companyId, jobId, {
    status: "running",
    progress: 0,
    message: "Writing drafts",
  });
  let failed = 0;
  for (const [i, draftId] of draftIds.entries()) {
    const r = await generateDraft(companyId, draftId, input.userId);
    if ("error" in r) failed++;
    await setJobProgress(companyId, jobId, {
      status: "running",
      progress: (i + 1) / draftIds.length,
      message: `${i + 1} of ${draftIds.length} drafts`,
    });
  }
  await setJobProgress(companyId, jobId, {
    status: failed === draftIds.length ? "failed" : "done",
    progress: 1,
    message: failed ? `${failed} of ${draftIds.length} drafts failed` : "Drafts ready for review",
    resultIds: draftIds,
    error: failed === draftIds.length ? "All drafts failed" : null,
  });
  return { drafts: draftIds.length, failed };
}

/* ------------------------------- review actions ------------------------------- */

export async function updateDraft(
  tx: Tx,
  ctx: Ctx,
  id: string,
  patch: Partial<ListingContent>,
): Promise<ListingDraft> {
  const row = await loadDraft(tx, ctx, id, true);
  if (row.status === "generating" || row.status === "publishing" || row.status === "published")
    throw conflict(`Draft is ${row.status} and cannot be edited`);
  const content: ListingContent = { ...row.content, ...patch };
  const validation = validateListing(row.channel, content);
  const textChanged =
    (patch.title !== undefined && patch.title !== row.content.title) ||
    (patch.tags !== undefined && JSON.stringify(patch.tags) !== JSON.stringify(row.content.tags)) ||
    (patch.description !== undefined && patch.description !== row.content.description);
  let trademark = row.trademark;
  if (textChanged) {
    const [design] = await tx
      .select({ ocrText: designs.ocrText })
      .from(designs)
      .where(eq(designs.id, row.designId));
    trademark = await checkTrademarks(tx, ctx, trademarkSources(content, design?.ocrText ?? null), {
      ocrText: design?.ocrText ?? null,
      entity: { type: "listing_draft", id },
    });
  }
  const [updated] = await tx
    .update(listingDrafts)
    .set({
      content,
      validation,
      trademark,
      // An edit after approval needs a fresh approval.
      status: row.status === "approved" || row.status === "failed" ? "needs_review" : row.status,
      approvedAt: row.status === "approved" ? null : row.approvedAt,
      approvedBy: row.status === "approved" ? null : row.approvedBy,
    })
    .where(eq(listingDrafts.id, id))
    .returning();
  await audit(tx, {
    companyId: ctx.companyId,
    actor: ctx.actor,
    action: "listing_draft.update",
    entityType: "listing_draft",
    entityId: id,
    summary: `Edited ${Object.keys(patch).join(", ")}`,
  });
  return getDraftFromRow(tx, updated as DraftRow);
}

async function getDraftFromRow(tx: Tx, row: DraftRow) {
  const [d] = await mapDrafts(tx, [row]);
  return d as ListingDraft;
}

export async function approveDraft(tx: Tx, ctx: Ctx, id: string) {
  const row = await loadDraft(tx, ctx, id, true);
  if (row.status !== "needs_review")
    throw invalidTransition("listing_draft", id, row.status, "approved");
  const validation = validateListing(row.channel, row.content);
  if (!validation.ok)
    throw new ORPCError("VALIDATION_FAILED", {
      status: 422,
      message: "Draft violates channel rules",
      data: validation,
    });
  // T-8-4: re-checks the draft's *current* trademark field live, every call. No override — the
  // former `acknowledgeRisk` bypass is gone.
  const tm = row.trademark as TrademarkCheck | null;
  assertTrademarkGate(tm, !!row.trademarkReviewedBy);
  const [updated] = await tx
    .update(listingDrafts)
    .set({ status: "approved", approvedBy: ctx.userId, approvedAt: new Date(), validation })
    .where(eq(listingDrafts.id, id))
    .returning();
  await audit(tx, {
    companyId: ctx.companyId,
    actor: ctx.actor,
    action: "listing_draft.approve",
    entityType: "listing_draft",
    entityId: id,
    summary: `Approved ${row.channel} listing`,
    data: { riskScore: tm?.riskScore ?? null },
  });
  if (ctx.userId)
    await emit(tx, ctx.companyId, "listing_draft.approved", { draftId: id, userId: ctx.userId });
  afterCommit(tx, async () => {
    await publish(ctx.companyId, {
      type: "listing_draft.updated",
      data: { draftId: id, status: "approved" },
    });
  });
  return getDraftFromRow(tx, updated as DraftRow);
}

export async function rejectDraft(tx: Tx, ctx: Ctx, id: string, reason?: string) {
  const row = await loadDraft(tx, ctx, id, true);
  if (!["needs_review", "approved", "failed"].includes(row.status))
    throw invalidTransition("listing_draft", id, row.status, "rejected");
  const [updated] = await tx
    .update(listingDrafts)
    .set({ status: "rejected", rejectedReason: reason ?? null, approvedAt: null, approvedBy: null })
    .where(eq(listingDrafts.id, id))
    .returning();
  await audit(tx, {
    companyId: ctx.companyId,
    actor: ctx.actor,
    action: "listing_draft.reject",
    entityType: "listing_draft",
    entityId: id,
    summary: reason ? `Rejected: ${reason}` : "Rejected",
  });
  return getDraftFromRow(tx, updated as DraftRow);
}

/**
 * `ai.listings.recordTrademarkReview`: a compliance sign-off on a medium-risk draft
 * (25 <= riskScore < 60), required by `assertTrademarkGate` before approve/publish/export.
 * 409s outside that band — including once the risk score has moved (edited content, or a mark
 * added since) rather than trusting a stale review.
 */
export async function recordTrademarkReview(tx: Tx, ctx: Ctx, id: string, note: string) {
  const row = await loadDraft(tx, ctx, id, true);
  const tm = row.trademark as TrademarkCheck | null;
  if (tm?.riskLevel !== "medium")
    throw new ORPCError("TRADEMARK_REVIEW_NOT_APPLICABLE", {
      status: 409,
      message: "Trademark review only applies to medium-risk drafts (25 <= riskScore < 60)",
      data:
        tm ??
        ({
          riskScore: 0,
          riskLevel: "low",
          matches: [],
          explanation: "No trademark check has run on this draft yet.",
          ocrText: null,
          checkedAt: new Date().toISOString(),
        } satisfies TrademarkCheck),
    });
  const [updated] = await tx
    .update(listingDrafts)
    .set({
      trademarkReviewedBy: ctx.userId,
      trademarkReviewedAt: new Date(),
      trademarkReviewNote: note,
    })
    .where(eq(listingDrafts.id, id))
    .returning();
  await audit(tx, {
    companyId: ctx.companyId,
    actor: ctx.actor,
    action: "listing_draft.trademark_review",
    entityType: "listing_draft",
    entityId: id,
    summary: `Trademark review recorded (risk ${tm.riskScore})`,
    data: { riskScore: tm.riskScore, note },
  });
  return getDraftFromRow(tx, updated as DraftRow);
}

/* ---------------------------------- publish ---------------------------------- */

/** Slug for a Shopify `Handle` column: lowercase, ascii, hyphenated, never empty. */
function slugify(s: string): string {
  const slug = s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "listing";
}

/**
 * Bulk-upload CSV rows: one row per **variant** (not per draft), each with a real blank-variant
 * SKU. Rows that share the same `content` object (by reference — every variant row for one draft
 * is built from the same draft) are one listing on multi-row channels (Etsy/Amazon: one row IS one
 * listing, so no grouping is needed there; Shopify: many rows share one `Handle`).
 */
/**
 * `etsyPartnerId` is the company's `settings.productionPartner.etsyPartnerId` (from
 * `getShopProductionPartners`; blank until the Etsy adapter is authorized — no live ids yet).
 * Same value for every row of one export; carried per-row (not per-content) so `exportCsv` stays
 * a pure function of its rows.
 */
export type ExportRow = {
  content: ListingContent;
  sku: string;
  color: string;
  size: string;
  etsyPartnerId?: string | null;
};

export function exportCsv(channel: Channel, rows: ExportRow[]): string {
  const price = (c: ListingContent) => (c.price != null ? (c.price / 100).toFixed(2) : "");
  const description = (c: ListingContent) => [c.description, ...c.disclosures].join("\n\n");

  if (channel === "etsy") {
    return toCsv(
      rows.map(({ content: c, sku, etsyPartnerId }) => ({
        title: c.title,
        description: description(c),
        price: price(c),
        quantity: 999,
        sku,
        tags: c.tags.join(","),
        materials: c.attributes.material ?? "cotton",
        who_made: "i_did",
        is_made_to_order: "true",
        when_made: "made_to_order",
        // Etsy's structured field is production_partner_ids (getShopProductionPartners); a
        // sentence in the description does not replace it (wave.md Contract stubs / C).
        production_partner: c.productionPartner ?? "",
        production_partner_ids: etsyPartnerId ?? "",
      })),
    );
  }
  if (channel === "amazon") {
    return toCsv(
      rows.map(({ content: c, sku }) => {
        const bullets = Object.fromEntries(
          Array.from({ length: 5 }, (_, i) => [`bullet_point${i + 1}`, c.bullets[i] ?? ""]),
        );
        return {
          feed_product_type: "SHIRT",
          item_sku: sku,
          item_name: c.title,
          product_description: description(c),
          ...bullets,
          generic_keywords: c.tags.join(" "),
          standard_price: price(c),
          quantity: 999,
        };
      }),
    );
  }
  if (channel === "shopify") {
    // Shopify's product CSV: one `Handle` per draft (product), one row per variant under it.
    // Every row repeats "Option1/2 Name" and carries that row's own "Option1/2 Value" (Shopify's
    // importer keys a variant off Handle + its option values, not off the SKU); only the first
    // row of each handle also carries the shared listing fields (title, body, tags, ...) — later
    // rows leave those blank (toCsv fills missing columns as "") the way Shopify's own exports do.
    const out: Record<string, string | number>[] = [];
    let prevContent: ListingContent | null = null;
    let handle = "";
    let n = 0;
    let seen = new Set<string>();
    for (const { content: c, sku, color, size } of rows) {
      if (c !== prevContent) {
        prevContent = c;
        n += 1;
        handle = `${slugify(c.title)}-${n}`;
        seen = new Set();
      }
      // Defensive: two rows with the same Handle + option values would collide in Shopify's own
      // importer (it can't tell the variants apart); this should never happen given the unique
      // (company, style, color, size) index on blank_variants, but skip rather than export it.
      const optionKey = `${color}\u0000${size}`;
      if (seen.has(optionKey)) continue;
      seen.add(optionKey);
      const isFirstOfHandle = seen.size === 1;
      if (isFirstOfHandle) {
        out.push({
          Handle: handle,
          Title: c.title,
          "Body (HTML)": description(c),
          Vendor: "",
          Tags: c.tags.join(", "),
          Published: "TRUE",
          "Option1 Name": "Color",
          "Option1 Value": color,
          "Option2 Name": "Size",
          "Option2 Value": size,
          "Variant SKU": sku,
          "Variant Price": price(c),
          "Variant Inventory Qty": 999,
          "Variant Inventory Policy": "deny",
          "Variant Fulfillment Service": "manual",
          "Image Src": "",
        });
      } else {
        out.push({
          Handle: handle,
          "Option1 Name": "Color",
          "Option1 Value": color,
          "Option2 Name": "Size",
          "Option2 Value": size,
          "Variant SKU": sku,
          "Variant Price": price(c),
          "Variant Inventory Qty": 999,
        });
      }
    }
    return toCsv(out);
  }
  return toCsv(
    rows.map(({ content: c, sku }) => ({
      title: c.title,
      description: description(c),
      price: price(c),
      sku,
      tags: c.tags.join(","),
      bullets: c.bullets.join(" | "),
    })),
  );
}

/** The product a draft's SKUs come from: the draft's own `productId`, or the design's active one. */
async function resolveProduct(tx: Tx, companyId: string, row: DraftRow) {
  if (row.productId) {
    const [p] = await tx
      .select()
      .from(products)
      .where(and(eq(products.companyId, companyId), eq(products.id, row.productId)));
    return p ?? null;
  }
  const [p] = await tx
    .select()
    .from(products)
    .where(
      and(
        eq(products.companyId, companyId),
        eq(products.designId, row.designId),
        eq(products.status, "active"),
      ),
    )
    .orderBy(asc(products.createdAt))
    .limit(1);
  return p ?? null;
}

/** One export/CSV row per real blank-variant SKU that this draft's product covers. */
async function variantRowsForDraft(
  tx: Tx,
  ctx: Pick<Ctx, "companyId">,
  row: DraftRow,
  etsyPartnerId: string | null = null,
): Promise<ExportRow[]> {
  const product = await resolveProduct(tx, ctx.companyId, row);
  if (!product) throw badRequest(`Draft ${row.id} has no product to resolve blank SKUs from`);
  const variants = await tx
    .select({
      colorCode: blankVariants.colorCode,
      sizeCode: blankVariants.sizeCode,
      // Display names (e.g. "Black", "Small"), not the internal codes: these become the
      // Shopify Option1/2 Value a buyer sees, and the column the Etsy/Amazon/generic branches
      // ignore.
      color: blankVariants.color,
      size: blankVariants.size,
      sku: blankVariants.sku,
    })
    .from(blankVariants)
    .where(
      and(
        eq(blankVariants.companyId, ctx.companyId),
        eq(blankVariants.styleCode, product.styleCode),
      ),
    );
  const allowedColor = new Set(product.allowedColorCodes);
  const allowedSize = new Set(product.allowedSizeCodes);
  const matched = variants.filter(
    (v) =>
      (!allowedColor.size || allowedColor.has(v.colorCode)) &&
      (!allowedSize.size || allowedSize.has(v.sizeCode)),
  );
  if (!matched.length)
    throw badRequest(`No blank variants match ${product.name} for draft ${row.id}`);
  return matched.map((v) => ({
    content: row.content,
    sku: v.sku,
    color: v.color,
    size: v.size,
    etsyPartnerId,
  }));
}

/** `ai.listings.exportCsv`: one CSV row per variant across every draft, all for one channel. */
export async function exportListingsCsv(
  tx: Tx,
  ctx: Ctx,
  input: { draftIds: string[]; channel: Channel },
): Promise<{ key: string }> {
  const found = await tx
    .select()
    .from(listingDrafts)
    .where(
      and(eq(listingDrafts.companyId, ctx.companyId), inArray(listingDrafts.id, input.draftIds)),
    );
  const byId = new Map(found.map((r) => [r.id, r]));
  const ordered: DraftRow[] = [];
  for (const id of input.draftIds) {
    const row = byId.get(id);
    if (!row) throw notFound("listing draft", id);
    if (row.channel !== input.channel)
      throw new ORPCError("CHANNEL_MISMATCH", {
        status: 400,
        message: "A draft's channel does not match the export channel",
      });
    // T-8-4: re-checked live per draft, against its current trademark field.
    assertTrademarkGate(row.trademark as TrademarkCheck | null, !!row.trademarkReviewedBy);
    ordered.push(row);
  }
  const etsyPartnerId =
    input.channel === "etsy"
      ? ((await productionPartner(tx, ctx.companyId))?.etsyPartnerId ?? null)
      : null;
  const rows: ExportRow[] = [];
  for (const row of ordered) rows.push(...(await variantRowsForDraft(tx, ctx, row, etsyPartnerId)));
  const key = objectKey(ctx.companyId, "listing-export", "csv");
  await putObject(key, exportCsv(input.channel, rows), "text/csv");
  await audit(tx, {
    companyId: ctx.companyId,
    actor: ctx.actor,
    action: "listing_draft.export_csv",
    entityType: "listing_draft",
    entityId: ordered[0]?.id ?? "",
    summary: `Exported ${input.channel} CSV for ${ordered.length} draft${ordered.length === 1 ? "" : "s"} (${rows.length} SKU rows)`,
    data: { draftIds: input.draftIds },
  });
  return { key };
}

export async function publishDraft(
  tx: Tx,
  ctx: Ctx,
  id: string,
  connectionId: string,
): Promise<PublishStatus> {
  const row = await loadDraft(tx, ctx, id, true);
  if (row.status !== "approved" && row.status !== "failed")
    throw invalidTransition("listing_draft", id, row.status, "publishing");
  if (row.status === "failed" && !row.approvedAt)
    throw conflict("Draft must be approved by a person before publishing");
  // T-8-4: re-checked live against the current trademark field, not the value cached at approval.
  assertTrademarkGate(row.trademark as TrademarkCheck | null, !!row.trademarkReviewedBy);
  const [conn] = await tx
    .select()
    .from(channelConnections)
    .where(
      and(eq(channelConnections.companyId, ctx.companyId), eq(channelConnections.id, connectionId)),
    );
  if (!conn) throw notFound("connection", connectionId);
  if (conn.channel !== row.channel && conn.channel !== "csv")
    throw badRequest(`Connection is ${conn.channel}; this draft is for ${row.channel}`);

  // No channel has a live listing-publish API today (see wave 6 plan review): every channel
  // produces a bulk-upload CSV instead, and the draft stays approved so it can be exported again.
  const key = objectKey(
    ctx.companyId,
    "listing-export",
    "csv",
    id as ReturnType<typeof crypto.randomUUID>,
  );
  const etsyPartnerId =
    row.channel === "etsy"
      ? ((await productionPartner(tx, ctx.companyId))?.etsyPartnerId ?? null)
      : null;
  await putObject(
    key,
    exportCsv(row.channel, await variantRowsForDraft(tx, ctx, row, etsyPartnerId)),
    "text/csv",
  );
  await tx
    .update(listingDrafts)
    .set({ status: "approved", connectionId, publishedUrl: `${EXPORT_PREFIX}${key}`, error: null })
    .where(eq(listingDrafts.id, id));
  await audit(tx, {
    companyId: ctx.companyId,
    actor: ctx.actor,
    action: "listing_draft.export",
    entityType: "listing_draft",
    entityId: id,
    summary: `Exported ${row.channel} bulk-upload CSV (channel API pending approval)`,
  });
  return publishStatus(tx, ctx, id);
}

export async function publishStatus(
  tx: Tx,
  ctx: Pick<Ctx, "companyId">,
  id: string,
): Promise<PublishStatus> {
  const row = await loadDraft(tx, ctx, id);
  const d = await toDraft(row, "");
  return {
    draftId: id,
    status: row.status,
    publishedListingId: row.publishedListingId,
    publishedUrl: d.publishedUrl,
    error: row.error,
    pendingApproval:
      row.status === "approved" &&
      !!row.publishedUrl?.startsWith(EXPORT_PREFIX) &&
      !row.publishedListingId,
  };
}

/* --------------------------------- validation --------------------------------- */

export function validate(channel: Channel, content: Partial<ListingContent>): ValidationResult {
  return validateListing(channel, content);
}

export async function trademarkCheck(
  tx: Tx,
  ctx: Ctx,
  input: { text?: string; designId?: string; channel?: Channel },
): Promise<TrademarkCheck> {
  const sources: TmInput = [];
  let ocr: string | null = null;
  if (input.text) sources.push({ source: "input_text", text: input.text });
  if (input.designId) {
    const [d] = await tx
      .select()
      .from(designs)
      .where(and(eq(designs.companyId, ctx.companyId), eq(designs.id, input.designId)));
    if (!d) throw notFound("design", input.designId);
    ocr = d.ocrText;
    sources.push({ source: "title", text: d.name });
    if (d.tags.length) sources.push({ source: "tags", text: d.tags.join(" | ") });
    if (d.ocrText) sources.push({ source: "design_text", text: d.ocrText });
  }
  return checkTrademarks(tx, ctx, sources, { ocrText: ocr });
}

/* --------------------------------- assistant --------------------------------- */

/** Most characters an earlier turn's tool line may take in the history sent to the model. */
export const TOOL_LINE_MAX = 600;
const TOOL_LINE_HEAD = "[Tools used earlier: ";

/**
 * T-17-3 tool memory: one compact line for an earlier assistant turn, naming the tools it called
 * and their one-line summaries (from `assistant_messages.toolCalls`), so follow-ups build on
 * them. Brackets, angle brackets and newlines are removed so no summary can end the line early or
 * open a fake tag; the gateway scrubs PII from history (this line included) before the model.
 */
export function toolMemoryLine(toolCalls: unknown): string | null {
  const calls = (toolCalls as { calls?: unknown } | null)?.calls;
  if (!Array.isArray(calls)) return null;
  const parts = calls
    .filter((c): c is { name: string; summary?: unknown } => typeof c?.name === "string")
    .map((c) => (typeof c.summary === "string" && c.summary ? `${c.name} (${c.summary})` : c.name));
  if (!parts.length) return null;
  const body = parts
    .join("; ")
    .replace(/[\r\n]+/g, " ")
    .replace(/[<>[\]]/g, "");
  const room = TOOL_LINE_MAX - TOOL_LINE_HEAD.length - 1;
  return `${TOOL_LINE_HEAD}${body.length > room ? `${body.slice(0, room - 1)}…` : body}]`;
}

/** Channels the assistant treats as connected (the same set as the cross-listing check). */
const CONTEXT_CONNECTION_STATUSES = ["connected", "csv_only", "error"] as const;

/**
 * T-17-3 shop context: time zone, "today" there, connected channels and currency. Sent as a second
 * system block after the cached prefix (never inside it), so the prefix stays byte-identical
 * across shops. Channel labels only: no connection names, which are shop-entered text.
 */
export async function shopContext(tx: Tx, companyId: string, now: Date): Promise<string> {
  const [c] = await tx
    .select({ tz: companies.timezone })
    .from(companies)
    .where(eq(companies.id, companyId));
  let tz = c?.tz ?? "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    tz = "UTC";
  }
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" }).format(now);
  const conns = await tx
    .selectDistinct({ channel: channelConnections.channel, status: channelConnections.status })
    .from(channelConnections)
    .where(
      and(
        eq(channelConnections.companyId, companyId),
        inArray(channelConnections.status, [...CONTEXT_CONNECTION_STATUSES]),
      ),
    );
  const channels = [...new Set(conns.map((r) => r.channel))].sort().map((ch) => {
    const label = CHANNEL_RULES[ch as Channel]?.label ?? ch;
    const csvOnly = conns.every((r) => r.channel !== ch || r.status === "csv_only");
    return csvOnly ? `${label} (CSV import)` : label;
  });
  return `Shop context (set by InvAI, not by the user): time zone ${tz}; today is ${weekday} ${day} in that time zone (now ${now.toISOString()}); connected channels: ${channels.length ? channels.join(", ") : "none"}; currency USD.`;
}

export async function* ask(
  ctx: Ctx,
  input: { message: string; conversationId?: string },
): AsyncGenerator<AssistantEvent> {
  if (!ctx.userId) throw badRequest("The assistant needs a signed-in user");
  const userId = ctx.userId;
  // Postgres text rejects NUL (22021): sanitize before the conversation rows are written.
  const message = sanitizeText(input.message);
  const now = new Date();
  const setup = await withTenant(ctx.companyId, async (tx) => {
    await assertCredits(tx, ctx.companyId, 1);
    let conversationId = input.conversationId;
    if (conversationId) {
      const [c] = await tx
        .select({ id: assistantConversations.id })
        .from(assistantConversations)
        .where(
          and(
            eq(assistantConversations.id, conversationId),
            eq(assistantConversations.userId, userId),
          ),
        );
      if (!c) throw notFound("conversation", conversationId);
    } else {
      const [c] = await tx
        .insert(assistantConversations)
        .values({ companyId: ctx.companyId, userId, title: message.slice(0, 80) })
        .returning({ id: assistantConversations.id });
      conversationId = c?.id as string;
    }
    const history = await tx
      .select({
        role: assistantMessages.role,
        text: assistantMessages.text,
        toolCalls: assistantMessages.toolCalls,
      })
      .from(assistantMessages)
      .where(eq(assistantMessages.conversationId, conversationId))
      .orderBy(desc(assistantMessages.createdAt))
      .limit(20);
    await tx.insert(assistantMessages).values({
      companyId: ctx.companyId,
      conversationId,
      role: "user",
      text: message,
    });
    const [assistantMsg] = await tx
      .insert(assistantMessages)
      .values({ companyId: ctx.companyId, conversationId, role: "assistant", text: "" })
      .returning({ id: assistantMessages.id });
    return {
      conversationId,
      history: history.reverse().map((h) => {
        const line = h.role === "assistant" ? toolMemoryLine(h.toolCalls) : null;
        return { role: h.role, text: line ? `${line}\n${h.text}` : h.text };
      }),
      context: await shopContext(tx, ctx.companyId, now),
      messageId: assistantMsg?.id as string,
    };
  });

  const { conversationId, messageId } = setup;
  // Counts and tool names only: never message text (it can hold anything the user typed).
  log.debug("assistant history", {
    companyId: ctx.companyId,
    historyTurns: setup.history.length,
    toolLines: setup.history
      .filter((h) => h.text.startsWith(TOOL_LINE_HEAD))
      .map((h) =>
        [...(h.text.split("\n")[0] ?? "").matchAll(/(?:: |; )([a-z]+_[a-z_]+)/g)].map((m) => m[1]),
      ),
  });
  yield { type: "start", conversationId, messageId };
  let text = "";
  const toolCalls: { name: string; input: Record<string, unknown>; summary?: string }[] = [];
  // Wave 18: recommendations shown in this turn's tool results (vote cards) and the mock flag.
  const shown = new Map<string, RecommendationRef>();
  let turnMock = false;
  let credits = 0;
  let failed = false;
  // `settled` mirrors gateway.ts's `runAssistant`: false only means this generator itself was torn
  // down mid-stream (the HTTP client disconnected) rather than finishing or erroring normally. The
  // consumption loop below is manual (`.next()`), so closing `gen` on that path is on us — it is
  // what lets runAssistant's own `finally` run and actually charge for tokens Anthropic already
  // billed instead of leaving them free and the ai_jobs row stuck "running".
  let settled = false;
  const gen = runAssistant(
    {
      companyId: ctx.companyId,
      userId,
      kind: "assistant",
      creditKind: "assistant",
      entity: { type: "assistant_message", id: messageId },
    },
    {
      system: ASSISTANT_PROMPT.system,
      context: setup.context,
      history: setup.history,
      message,
      tools: assistantTools(ctx),
      now,
    },
    // Fires with the real charged credits however runAssistant ends, including the disconnect
    // path below (see the comment on runAssistant itself for why this isn't read off its return
    // value instead).
    (result) => {
      credits = result.credits;
    },
  );
  try {
    let step = await gen.next();
    while (!step.done) {
      const e = step.value;
      if (e.type === "text") {
        text += e.text;
        yield { type: "text_delta", text: e.text };
      } else if (e.type === "tool_call") {
        toolCalls.push({ name: e.name, input: e.input });
        // Every assistant tool name is in the contract's tool_call enum (T-17-1; service.test.ts
        // checks each one parses).
        yield { type: "tool_call", name: e.name as AssistantToolName, input: e.input };
      } else {
        const call = [...toolCalls].reverse().find((c) => c.name === e.name && !c.summary);
        if (call) call.summary = e.summary;
        const recs = (e.meta?.recommendations ?? []).slice(0, 3);
        for (const r of recs) shown.set(r.id, r);
        if (e.meta?.mock) turnMock = true;
        yield {
          type: "tool_result",
          name: e.name,
          summary: e.summary,
          ...(e.meta?.mock !== undefined ? { mock: e.meta.mock } : {}),
          ...(e.meta?.sources ? { sources: e.meta.sources } : {}),
          ...(e.meta ? { recommendations: recs } : {}),
        };
      }
      step = await gen.next();
    }
    settled = true;
  } catch (err) {
    settled = true;
    failed = true;
    const code =
      err instanceof ORPCError && err.code === "CREDITS_EXHAUSTED"
        ? "credits_exhausted"
        : err instanceof ORPCError && err.code === "AI_SPEND_CAP_REACHED"
          ? "spend_cap"
          : (err as Error).message.includes("declined")
            ? "refusal"
            : "internal";
    log.warn("assistant failed", { error: (err as Error).message });
    yield { type: "error", message: (err as Error).message, code };
  } finally {
    if (!settled) {
      // Close the inner generator so its own `finally` runs: that's what actually finishes the
      // ai_jobs row and charges credits, and calls the `onSettle` callback above with the real
      // number before this `await` resolves.
      await gen.return({ credits: 0, model: "", aiJobId: "" }).catch(() => undefined);
    }
    await withTenant(ctx.companyId, async (tx) => {
      if (failed && !text && !toolCalls.length) {
        // Nothing came of this turn: don't leave a blank assistant message in the transcript.
        await tx.delete(assistantMessages).where(eq(assistantMessages.id, messageId));
      } else {
        await tx
          .update(assistantMessages)
          .set({
            text: sanitizeText(text),
            toolCalls: sanitizeDeep({
              calls: toolCalls,
              ...(shown.size ? { recommendations: [...shown.values()] } : {}),
              ...(turnMock ? { mock: true } : {}),
            }),
            creditsUsed: credits,
          })
          .where(eq(assistantMessages.id, messageId));
      }
      await tx
        .update(assistantConversations)
        .set({ updatedAt: new Date() })
        .where(eq(assistantConversations.id, conversationId));
    });
    if (shown.size && !(failed && !text && !toolCalls.length)) {
      // Once per turn (spec AC33): the market module stores where and when they were shown. Its
      // own transaction, so a failure here never loses the answer that was already saved.
      await withTenant(ctx.companyId, (tx) =>
        recordRecommendationsShown(tx, ctx, {
          ids: [...shown.keys()],
          shownIn: "assistant",
          refId: messageId,
        }),
      ).catch((err) =>
        log.warn("could not record shown recommendations", {
          companyId: ctx.companyId,
          error: (err as Error).message,
        }),
      );
    }
  }
  yield { type: "done", conversationId, messageId, creditsUsed: credits };
}

export async function listConversations(tx: Tx, ctx: Ctx, input: PageInput) {
  const page = keyset(assistantConversations.updatedAt, assistantConversations.id, input);
  const rows = await tx
    .select()
    .from(assistantConversations)
    .where(
      and(
        eq(assistantConversations.companyId, ctx.companyId),
        eq(assistantConversations.userId, ctx.userId ?? "00000000-0000-0000-0000-000000000000"),
        page.where,
      ),
    )
    .orderBy(...page.orderBy)
    .limit(page.limit + 1);
  return page.result(
    rows.map((r) => ({ ...r, createdAtOrig: r.createdAt, createdAt: r.updatedAt })),
    (r) => ({
      id: r.id,
      title: r.title,
      createdAt: r.createdAtOrig.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }),
  );
}

/**
 * Wave 18 (spec AC33): the recommendations an assistant message showed and its mock flag, read
 * back from `assistant_messages.toolCalls`, so the vote cards survive a reload. Entries that don't
 * parse are skipped; messages from before wave 18 get neither field.
 */
export function storedRecommendations(toolCalls: unknown): {
  recommendations?: RecommendationRef[];
  mock?: boolean;
} {
  const t = toolCalls as { recommendations?: unknown; mock?: unknown } | null;
  const recs = Array.isArray(t?.recommendations)
    ? t.recommendations.flatMap((r) => {
        const p = RecommendationRef.safeParse(r);
        return p.success ? [p.data] : [];
      })
    : [];
  return {
    ...(recs.length ? { recommendations: recs } : {}),
    ...(t?.mock === true ? { mock: true } : {}),
  };
}

export async function getConversation(tx: Tx, ctx: Ctx, id: string) {
  const [c] = await tx
    .select()
    .from(assistantConversations)
    .where(
      and(
        eq(assistantConversations.id, id),
        eq(assistantConversations.userId, ctx.userId ?? "00000000-0000-0000-0000-000000000000"),
      ),
    );
  if (!c) throw notFound("conversation", id);
  const msgs = await tx
    .select()
    .from(assistantMessages)
    .where(eq(assistantMessages.conversationId, id))
    .orderBy(asc(assistantMessages.createdAt));
  return {
    id: c.id,
    title: c.title,
    messages: msgs.map((m) => ({
      id: m.id,
      role: m.role,
      text: m.text,
      createdAt: m.createdAt.toISOString(),
      ...storedRecommendations(m.toolCalls),
    })),
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

/* ---------------------------------- credits ---------------------------------- */

export function balance(tx: Tx, ctx: Ctx) {
  return creditBalance(tx, ctx.companyId);
}

export async function ledger(
  tx: Tx,
  ctx: Ctx,
  input: PageInput & { kind?: CreditEntry["kind"][]; from?: string; to?: string },
) {
  const page = keyset(aiCreditLedger.createdAt, aiCreditLedger.id, input);
  const rows = await tx
    .select()
    .from(aiCreditLedger)
    .where(
      and(
        eq(aiCreditLedger.companyId, ctx.companyId),
        input.kind?.length ? inArray(aiCreditLedger.kind, input.kind) : undefined,
        input.from ? gte(aiCreditLedger.createdAt, new Date(input.from)) : undefined,
        input.to ? lte(aiCreditLedger.createdAt, new Date(input.to)) : undefined,
        page.where,
      ),
    )
    .orderBy(...page.orderBy)
    .limit(page.limit + 1);
  return page.result(
    rows,
    (r): CreditEntry => ({
      id: r.id,
      at: r.createdAt.toISOString(),
      kind: r.kind,
      credits: r.credits,
      model: r.model,
      tokensIn: r.tokensIn,
      tokensOut: r.tokensOut,
      cacheReadTokens: r.cacheReadTokens,
      ref: r.refType && r.refId ? { type: r.refType, id: r.refId } : null,
      userId: r.userId,
    }),
  );
}
