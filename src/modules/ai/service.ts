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
import { ORPCError } from "@orpc/server";
import { and, asc, desc, eq, gte, ilike, inArray, lte, or, type SQL, sql } from "drizzle-orm";
import type { z } from "zod";
import { assertCredits, creditBalance } from "../../ai/credits";
import { runAssistant, runStructured } from "../../ai/gateway";
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
  designs,
  jobs,
  listingDrafts,
  products,
} from "../../db/schema";
import { getChannelAdapter } from "../../integrations/channels";
import { audit } from "../../lib/audit";
import { toCsv } from "../../lib/csv";
import { badRequest, conflict, invalidTransition, notFound } from "../../lib/errors";
import { logger } from "../../lib/log";
import { emit } from "../../lib/outbox";
import { keyset, type PageInput } from "../../lib/pagination";
import { publish } from "../../lib/realtime";
import { objectKey, presignGet, putObject } from "../../lib/s3";
import { assistantTools } from "./assistant-tools";
import { checkTrademarks, type TmInput } from "./trademark";

const log = logger("ai");

type PublishStatus = z.infer<typeof PublishStatusSchema>;

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
  return { design, product: product ?? null, blank, price };
}

function toContent(copy: ListingCopy, price: number | null): ListingContent {
  return {
    title: copy.title,
    description: copy.description,
    tags: copy.tags,
    bullets: copy.bullets,
    attributes: Object.fromEntries(copy.attributes.map((a) => [a.key, a.value])),
    price,
    disclosures: [],
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
      normalizeListing(row.channel, toContent(first.output, gen.price)),
    );
    let validation = validateListing(row.channel, content);
    if (!validation.ok) {
      const retry = await runStructured(meta, listingCopyPrompt, {
        ...vars,
        fixErrors: describeIssues(validation),
      });
      credits += retry.credits;
      first = retry;
      content = withDisclosures(normalizeListing(row.channel, toContent(retry.output, gen.price)));
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

export async function approveDraft(tx: Tx, ctx: Ctx, id: string, acknowledgeRisk: boolean) {
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
  const tm = row.trademark as TrademarkCheck | null;
  if (tm?.riskLevel === "high" && !acknowledgeRisk)
    throw new ORPCError("HIGH_TRADEMARK_RISK", {
      status: 409,
      message: "High trademark risk; pass acknowledgeRisk to approve anyway",
      data: tm,
    });
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
    summary: `Approved ${row.channel} listing${tm?.riskLevel === "high" ? " (trademark risk acknowledged)" : ""}`,
    data: { riskScore: tm?.riskScore ?? null, acknowledgeRisk },
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

/* ---------------------------------- publish ---------------------------------- */

/** Bulk-upload CSV rows (Etsy / Amazon flat-file style columns; generic for the rest). */
export function exportCsv(channel: Channel, c: ListingContent, sku: string): string {
  const price = c.price != null ? (c.price / 100).toFixed(2) : "";
  const description = [c.description, ...c.disclosures].join("\n\n");
  if (channel === "etsy") {
    return toCsv([
      {
        title: c.title,
        description,
        price,
        quantity: 999,
        sku,
        tags: c.tags.join(","),
        materials: c.attributes.material ?? "cotton",
        who_made: "i_did",
        is_made_to_order: "true",
        when_made: "made_to_order",
        production_partner: "DTF transfer printer",
      },
    ]);
  }
  if (channel === "amazon") {
    const bullets = Object.fromEntries(
      Array.from({ length: 5 }, (_, i) => [`bullet_point${i + 1}`, c.bullets[i] ?? ""]),
    );
    return toCsv([
      {
        feed_product_type: "SHIRT",
        item_sku: sku,
        item_name: c.title,
        product_description: description,
        ...bullets,
        generic_keywords: c.tags.join(" "),
        standard_price: price,
        quantity: 999,
      },
    ]);
  }
  return toCsv([
    {
      title: c.title,
      description,
      price,
      sku,
      tags: c.tags.join(","),
      bullets: c.bullets.join(" | "),
    },
  ]);
}

type MaybeUpsert = {
  upsertListing?: (
    conn: unknown,
    listing: {
      draftId: string;
      content: ListingContent;
      designId: string;
      productId: string | null;
    },
  ) => Promise<{ listingId: string; url?: string | null }>;
};

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
  const [conn] = await tx
    .select()
    .from(channelConnections)
    .where(
      and(eq(channelConnections.companyId, ctx.companyId), eq(channelConnections.id, connectionId)),
    );
  if (!conn) throw notFound("connection", connectionId);
  if (conn.channel !== row.channel && conn.channel !== "csv")
    throw badRequest(`Connection is ${conn.channel}; this draft is for ${row.channel}`);

  const adapter = getChannelAdapter(conn.channel, conn.provider) as unknown as MaybeUpsert & {
    pendingApproval?: boolean;
  };
  if (typeof adapter.upsertListing === "function" && conn.mode === "api") {
    try {
      const res = await adapter.upsertListing(
        {
          id: conn.id,
          companyId: conn.companyId,
          channel: conn.channel,
          name: conn.name,
          mode: conn.mode,
          provider: conn.provider,
          externalShopId: conn.externalShopId,
          cursor: conn.cursor,
          credentials: conn.credentials ? JSON.parse(conn.credentials) : null,
        },
        { draftId: id, content: row.content, designId: row.designId, productId: row.productId },
      );
      await tx
        .update(listingDrafts)
        .set({
          status: "published",
          connectionId,
          publishedListingId: res.listingId,
          publishedUrl: res.url ?? null,
          error: null,
        })
        .where(eq(listingDrafts.id, id));
      await emit(tx, ctx.companyId, "listing_draft.published", {
        draftId: id,
        listingId: res.listingId,
      });
      await audit(tx, {
        companyId: ctx.companyId,
        actor: ctx.actor,
        action: "listing_draft.publish",
        entityType: "listing_draft",
        entityId: id,
        summary: `Published to ${conn.name}`,
      });
      return publishStatus(tx, ctx, id);
    } catch (err) {
      const message = (err as Error).message;
      await tx
        .update(listingDrafts)
        .set({ status: "failed", connectionId, error: message })
        .where(eq(listingDrafts.id, id));
      await emit(tx, ctx.companyId, "listing_draft.failed", { draftId: id, error: message });
      return publishStatus(tx, ctx, id);
    }
  }

  // No listing API for this channel yet: produce a bulk-upload CSV; the draft stays approved.
  const key = objectKey(
    ctx.companyId,
    "listing-export",
    "csv",
    id as ReturnType<typeof crypto.randomUUID>,
  );
  await putObject(key, exportCsv(row.channel, row.content, `DRAFT-${id.slice(0, 8)}`), "text/csv");
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

export async function* ask(
  ctx: Ctx,
  input: { message: string; conversationId?: string },
): AsyncGenerator<AssistantEvent> {
  if (!ctx.userId) throw badRequest("The assistant needs a signed-in user");
  const userId = ctx.userId;
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
        .values({ companyId: ctx.companyId, userId, title: input.message.slice(0, 80) })
        .returning({ id: assistantConversations.id });
      conversationId = c?.id as string;
    }
    const history = await tx
      .select({ role: assistantMessages.role, text: assistantMessages.text })
      .from(assistantMessages)
      .where(eq(assistantMessages.conversationId, conversationId))
      .orderBy(desc(assistantMessages.createdAt))
      .limit(20);
    await tx.insert(assistantMessages).values({
      companyId: ctx.companyId,
      conversationId,
      role: "user",
      text: input.message,
    });
    const [assistantMsg] = await tx
      .insert(assistantMessages)
      .values({ companyId: ctx.companyId, conversationId, role: "assistant", text: "" })
      .returning({ id: assistantMessages.id });
    return { conversationId, history: history.reverse(), messageId: assistantMsg?.id as string };
  });

  const { conversationId, messageId } = setup;
  yield { type: "start", conversationId, messageId };
  let text = "";
  const toolCalls: { name: string; input: Record<string, unknown>; summary?: string }[] = [];
  let credits = 0;
  try {
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
        history: setup.history,
        message: input.message,
        tools: assistantTools(ctx),
        now: new Date(),
      },
    );
    let step = await gen.next();
    while (!step.done) {
      const e = step.value;
      if (e.type === "text") {
        text += e.text;
        yield { type: "text_delta", text: e.text };
      } else if (e.type === "tool_call") {
        toolCalls.push({ name: e.name, input: e.input });
        // get_production_status is not in the contract's tool_call enum; its result still streams.
        if (e.name !== "get_production_status")
          yield {
            type: "tool_call",
            name: e.name as "get_profit",
            input: e.input,
          };
      } else {
        const call = [...toolCalls].reverse().find((c) => c.name === e.name && !c.summary);
        if (call) call.summary = e.summary;
        yield { type: "tool_result", name: e.name, summary: e.summary };
      }
      step = await gen.next();
    }
    credits = step.value.credits;
  } catch (err) {
    const code =
      err instanceof ORPCError && err.code === "CREDITS_EXHAUSTED"
        ? "credits_exhausted"
        : (err as Error).message.includes("declined")
          ? "refusal"
          : "internal";
    log.warn("assistant failed", { error: (err as Error).message });
    yield { type: "error", message: (err as Error).message, code };
  }
  await withTenant(ctx.companyId, async (tx) => {
    await tx
      .update(assistantMessages)
      .set({ text, toolCalls: { calls: toolCalls }, creditsUsed: credits })
      .where(eq(assistantMessages.id, messageId));
    await tx
      .update(assistantConversations)
      .set({ updatedAt: new Date() })
      .where(eq(assistantConversations.id, conversationId));
  });
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
