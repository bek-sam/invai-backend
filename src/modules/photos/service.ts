import {
  type BlankColor,
  canTransitionPhotoImage,
  type DesignPhotoAnalysis,
  type DesignPhotoAnalysisResult,
  type ListingDraft,
  MAX_PHOTO_COMPOSITIONS,
  PHOTO_CHECK_CODES,
  type PhotoBadRequestReason,
  type PhotoCheckFailure,
  type PhotoChecks,
  type PhotoComposition,
  type PhotoEstimate,
  type PhotoImage,
  type PhotoSet,
  type PhotoSetCreateInput,
  type PhotoSetSpec,
  type PhotoSetStatus,
  type PhotoSetSummary,
  presetFor,
  TEMPLATE_VIEWS,
} from "@invai/contracts";
import { and, asc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { assertCredits, chargeCredits, creditBalance, creditsExhausted } from "../../ai/credits";
import { PHOTO_TEMPLATE_CREDITS } from "../../ai/models";
import type { TenantContext } from "../../api/context";
import { systemContext } from "../../api/context";
import { afterCommit, type Tx, withTenant } from "../../db/client";
import { photoAnalyses, photoCompositions, photoImages, photoSets } from "../../db/schema";
import { ImagingError, imaging, type PhotoRenderResult } from "../../integrations/imaging/client";
import { audit } from "../../lib/audit";
import { sha256Hex } from "../../lib/crypto";
import { badRequest, conflict, isORPCError, notFound } from "../../lib/errors";
import { logger } from "../../lib/log";
import { emit } from "../../lib/outbox";
import { keyset, type PageInput } from "../../lib/pagination";
import { isPermanentHttpStatus } from "../../lib/queues";
import { publish } from "../../lib/realtime";
import { isCompanyKey, presignGet } from "../../lib/s3";
import { analyzeDesignForPhotos } from "../ai/photo-analysis";
import { attachPhotosToDraft } from "../ai/photo-attach";
import { getDraft } from "../ai/service";
import { blankFacets, getDesign } from "../catalog/service";
import { contrastWarnings } from "./contrast";

const log = logger("photos");

type SetRow = typeof photoSets.$inferSelect;
type CompositionRow = typeof photoCompositions.$inferSelect;
type ImageRow = typeof photoImages.$inferSelect;
type TemplateView = (typeof TEMPLATE_VIEWS)[number];

/** An analysis still `pending` after this long is treated as lost and re-enqueued. */
const ANALYSIS_STALE_MS = 15 * 60_000;
const DONE_IMAGE: ImageRow["status"][] = ["rendered", "approved", "rejected"];
const OPEN_IMAGE: ImageRow["status"][] = ["queued", "rendering"];
const CREDITS_USED_UP = "AI credits are used up.";

/**
 * Credits promised to open sets (S-51): compositions with an image still to render and no charge
 * yet. createSet counts them against the balance so two sets can't both spend the same credits.
 */
async function openCommitments(tx: Tx): Promise<number> {
  const [r] = await tx
    .select({ n: sql<number>`count(distinct ${photoImages.compositionId})::int` })
    .from(photoImages)
    .innerJoin(photoCompositions, eq(photoCompositions.id, photoImages.compositionId))
    .where(and(inArray(photoImages.status, OPEN_IMAGE), isNull(photoCompositions.chargedAt)));
  return (r?.n ?? 0) * PHOTO_TEMPLATE_CREDITS;
}

/** Serializes photo charges per company, so two sets' render jobs can't both spend the last credits. */
async function lockCompanyCharges(tx: Tx, companyId: string) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`photos.charge:${companyId}`}, 0))`,
  );
}

/* ---- Enqueuers (set by jobs.ts; avoids a service <-> jobs import cycle) ------------------ */

type AnalysisJobInput = {
  companyId: string;
  designId: string;
  jobId: string;
  userId: string | null;
};
type ZipJobInput = { companyId: string; setId: string; zipJobId: string };
let enqueueAnalysis: (i: AnalysisJobInput) => Promise<void> = async () => {
  throw new Error("photos jobs not registered");
};
let enqueueZip: (i: ZipJobInput) => Promise<void> = async () => {
  throw new Error("photos jobs not registered");
};
export function setPhotoEnqueuers(fns: {
  analysis: typeof enqueueAnalysis;
  zip: typeof enqueueZip;
}) {
  enqueueAnalysis = fns.analysis;
  enqueueZip = fns.zip;
}

function photoBadRequest(reason: PhotoBadRequestReason, count: number | null, message: string) {
  return badRequest(message, { reason, count });
}

/* ---- Mappers ------------------------------------------------------------------------------ */

const color = (c: CompositionRow): BlankColor => ({ name: c.colorName, hex: c.colorHex });

function toComposition(c: CompositionRow): PhotoComposition {
  return {
    id: c.id,
    setId: c.setId,
    source: c.source,
    garment: c.garment,
    view: c.view,
    color: color(c),
    placement: c.placement,
    sceneKind: c.sceneKind ?? null,
    creditsCharged: c.creditsCharged,
    chargedAt: c.chargedAt?.toISOString() ?? null,
  };
}

function toImage(i: ImageRow, c: CompositionRow, url: string | null): PhotoImage {
  return {
    id: i.id,
    setId: i.setId,
    compositionId: i.compositionId,
    channel: i.channel,
    preset: i.preset,
    slot: i.slot,
    garment: c.garment,
    view: c.view,
    color: color(c),
    placement: c.placement,
    source: c.source,
    status: i.status,
    key: i.key,
    url,
    widthPx: i.widthPx,
    heightPx: i.heightPx,
    format: i.format ?? null,
    checks: i.checks ?? null,
    designLockScore: i.designLockScore,
    aiGenerated: i.aiGenerated,
    containsSyntheticPerson: i.containsSyntheticPerson,
    drawnTemplate: i.drawnTemplate,
    altText: i.altText,
    creditsCharged: i.creditsCharged,
    model: i.model,
    error: i.error,
    reviewedBy: i.reviewedBy,
    reviewedAt: i.reviewedAt?.toISOString() ?? null,
    createdAt: i.createdAt.toISOString(),
    updatedAt: i.updatedAt.toISOString(),
  };
}

type SetAgg = {
  counts: PhotoSetSummary["counts"];
  creditsCharged: number;
  hasAiImages: boolean;
  hasSyntheticPerson: boolean;
};

const emptyAgg = (): SetAgg => ({
  counts: { total: 0, queued: 0, rendering: 0, rendered: 0, approved: 0, rejected: 0, failed: 0 },
  creditsCharged: 0,
  hasAiImages: false,
  hasSyntheticPerson: false,
});

async function aggregates(tx: Tx, setIds: string[]): Promise<Map<string, SetAgg>> {
  const out = new Map<string, SetAgg>(setIds.map((id) => [id, emptyAgg()]));
  if (setIds.length === 0) return out;
  const rows = await tx
    .select({
      setId: photoImages.setId,
      status: photoImages.status,
      n: sql<number>`count(*)`.mapWith(Number),
      credits: sql<number>`coalesce(sum(${photoImages.creditsCharged}), 0)`.mapWith(Number),
      ai: sql<boolean>`bool_or(${photoImages.aiGenerated})`,
      person: sql<boolean>`bool_or(${photoImages.containsSyntheticPerson})`,
    })
    .from(photoImages)
    .where(inArray(photoImages.setId, setIds))
    .groupBy(photoImages.setId, photoImages.status);
  for (const r of rows) {
    const a = out.get(r.setId);
    if (!a) continue;
    a.counts[r.status] += r.n;
    a.counts.total += r.n;
    a.creditsCharged += r.credits;
    a.hasAiImages ||= Boolean(r.ai);
    a.hasSyntheticPerson ||= Boolean(r.person);
  }
  return out;
}

async function signed(companyId: string, key: string | null): Promise<string | null> {
  if (!key || !isCompanyKey(companyId, key)) return null;
  return presignGet(key);
}

async function toSummary(
  s: SetRow,
  agg: SetAgg,
  leadImageUrl: string | null,
  zipUrl: string | null,
): Promise<PhotoSetSummary> {
  return {
    id: s.id,
    designId: s.designId,
    designName: s.designName,
    status: s.status,
    garments: s.garments,
    colors: s.colors,
    views: s.views.filter((v): v is TemplateView => v !== "lifestyle"),
    channels: s.channels,
    lifestyle: null,
    counts: agg.counts,
    creditsEstimated: s.creditsEstimated,
    creditsCharged: agg.creditsCharged,
    hasAiImages: agg.hasAiImages,
    hasSyntheticPerson: agg.hasSyntheticPerson,
    zip: {
      status: s.zipStatus,
      channel: s.zipChannel ?? null,
      url: zipUrl,
      bytes: s.zipBytes,
      imageCount: s.zipImageCount,
      builtAt: s.zipBuiltAt?.toISOString() ?? null,
      error: s.zipError,
    },
    leadImageUrl,
    error: s.error,
    createdBy: s.createdBy,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

/** The list thumbnail: the first channel's slot-0 image, once rendered. */
function leadOf(s: SetRow, images: ImageRow[]): ImageRow | undefined {
  const done = images.filter((i) => i.setId === s.id && i.slot === 0 && i.key);
  return done.find((i) => i.channel === s.channels[0]) ?? done[0];
}

async function loadSetRow(tx: Tx, id: string): Promise<SetRow> {
  const [row] = await tx.select().from(photoSets).where(eq(photoSets.id, id)).limit(1);
  if (!row) throw notFound("photo set", id);
  return row;
}

/* ---- Design analysis ---------------------------------------------------------------------- */

async function printFile(tx: Tx, ctx: TenantContext, designId: string) {
  const design = await getDesign(tx, ctx, designId);
  const front = design.placements.find((p) => p.placement === "front");
  const back = design.placements.find((p) => p.placement === "back");
  return { design, front, back };
}

export async function analyzeDesign(
  tx: Tx,
  ctx: TenantContext,
  input: { designId: string; refresh?: boolean },
): Promise<DesignPhotoAnalysisResult> {
  const { design, front, back } = await printFile(tx, ctx, input.designId);
  if (design.status === "archived")
    throw photoBadRequest("design_archived", null, "This design is archived");
  if (!front && !back)
    throw photoBadRequest("no_print_file", null, "This design has no front or back print file");
  const [row] = await tx
    .select()
    .from(photoAnalyses)
    .where(eq(photoAnalyses.designId, design.id))
    .limit(1);
  if (row && !input.refresh) {
    if (row.status === "ready" && row.analysis) return { status: "ready", analysis: row.analysis };
    if (row.status === "pending" && Date.now() - row.updatedAt.getTime() < ANALYSIS_STALE_MS)
      return { status: "pending", jobId: row.jobId };
  }
  await assertCredits(tx, ctx.companyId, 1);
  const jobId = crypto.randomUUID();
  await tx
    .insert(photoAnalyses)
    .values({
      companyId: ctx.companyId,
      designId: design.id,
      status: "pending",
      jobId,
      requestedBy: ctx.userId,
    })
    .onConflictDoUpdate({
      target: [photoAnalyses.companyId, photoAnalyses.designId],
      set: {
        status: "pending",
        jobId,
        analysis: null,
        error: null,
        requestedBy: ctx.userId,
        updatedAt: new Date(),
      },
    });
  const job = { companyId: ctx.companyId, designId: design.id, jobId, userId: ctx.userId };
  afterCommit(tx, () =>
    enqueueAnalysis(job).catch((err) =>
      log.error("analysis enqueue failed", {
        companyId: ctx.companyId,
        designId: design.id,
        error: (err as Error).message,
      }),
    ),
  );
  return { status: "pending", jobId };
}

function readableAiError(err: unknown): { message: string; permanent: boolean } {
  if (isORPCError(err)) {
    if (err.code === "CREDITS_EXHAUSTED")
      return { message: "AI credits are used up for this period.", permanent: true };
    if (err.code === "AI_SPEND_CAP_REACHED")
      return {
        message: "Today's AI spending limit is reached. Try again tomorrow.",
        permanent: true,
      };
    return { message: "The design analysis could not finish. Try again.", permanent: false };
  }
  if (err instanceof ImagingError)
    return {
      message: "The image service is not responding. Try again in a few minutes.",
      permanent: err.status > 0 && isPermanentHttpStatus(err.status),
    };
  return { message: "The design analysis could not finish. Try again.", permanent: false };
}

async function failAnalysis(companyId: string, designId: string, jobId: string, error: string) {
  await withTenant(companyId, (tx) =>
    tx
      .update(photoAnalyses)
      .set({ status: "failed", error })
      .where(
        and(
          eq(photoAnalyses.designId, designId),
          eq(photoAnalyses.jobId, jobId),
          eq(photoAnalyses.status, "pending"),
        ),
      ),
  );
}

/**
 * The analysis job: palette from imaging, then the AI route, with no transaction open across
 * either call. Contrast warnings are computed here, in code, against the recommended colors and
 * the shop's own blank colors.
 */
export async function runAnalysis(
  input: AnalysisJobInput,
  finalAttempt: boolean,
): Promise<{ status: "ready" | "failed" | "skipped" }> {
  const { companyId, designId, jobId } = input;
  const ctx = systemContext(companyId);
  const prep = await withTenant(companyId, async (tx) => {
    const [row] = await tx
      .select()
      .from(photoAnalyses)
      .where(eq(photoAnalyses.designId, designId))
      .limit(1);
    if (!row || row.jobId !== jobId || row.status !== "pending") return null;
    const { design, front, back } = await printFile(tx, ctx, designId);
    const facets = await blankFacets(tx, ctx);
    const shopBlanks: BlankColor[] = facets.colors
      .filter((c) => c.colorHex && /^#[0-9a-fA-F]{6}$/.test(c.colorHex))
      .map((c) => ({ name: c.color || c.colorCode, hex: (c.colorHex as string).toLowerCase() }));
    return { design, file: front ?? back, shopBlanks };
  });
  if (!prep) return { status: "skipped" };
  if (!prep.file) {
    await failAnalysis(companyId, designId, jobId, "This design has no front or back print file.");
    return { status: "failed" };
  }
  let analysis: DesignPhotoAnalysis;
  try {
    const p = await imaging.photoPalette({ design_key: prep.file.fileKey });
    const palette = {
      colors: p.colors.map((c) => ({ hex: normalizeHex(c.hex), share: clamp01(c.share) })),
      lightShare: clamp01(p.light_share),
      darkShare: clamp01(p.dark_share),
      transparentShare: clamp01(p.transparent_share),
    };
    const out = await analyzeDesignForPhotos(companyId, input.userId, {
      designId,
      previewKey: prep.file.previewKey,
      palette,
      designName: prep.design.name,
      tags: prep.design.tags,
    });
    const blanks = [
      ...out.recommendedColors.map((c) => ({ name: c.name, hex: c.hex })),
      ...prep.shopBlanks,
    ];
    analysis = {
      ...out,
      designId,
      palette: palette.colors.slice(0, 6),
      lightShare: palette.lightShare,
      darkShare: palette.darkShare,
      transparentShare: palette.transparentShare,
      contrastWarnings: contrastWarnings(palette.colors, blanks),
    };
  } catch (err) {
    const { message, permanent } = readableAiError(err);
    log.warn("photo analysis failed", { companyId, designId, permanent, finalAttempt, message });
    if (permanent || finalAttempt) {
      await failAnalysis(companyId, designId, jobId, message);
      return { status: "failed" };
    }
    throw err;
  }
  await withTenant(companyId, (tx) =>
    tx
      .update(photoAnalyses)
      .set({ status: "ready", analysis, error: null })
      .where(
        and(
          eq(photoAnalyses.designId, designId),
          eq(photoAnalyses.jobId, jobId),
          eq(photoAnalyses.status, "pending"),
        ),
      ),
  );
  return { status: "ready" };
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
function normalizeHex(hex: string): string {
  const h = hex.replace(/^#/, "").toLowerCase();
  return `#${h.length === 3 ? [...h].map((c) => c + c).join("") : h}`;
}

/* ---- Estimate and create ------------------------------------------------------------------ */

type Planned = { garment: PhotoSetSpec["garments"][number]; view: TemplateView; color: BlankColor };

async function plan(tx: Tx, ctx: TenantContext, spec: PhotoSetSpec) {
  const { design, front, back } = await printFile(tx, ctx, spec.designId);
  if (design.status === "archived")
    throw photoBadRequest("design_archived", null, "This design is archived");
  if (!front && !back)
    throw photoBadRequest("no_print_file", null, "This design has no front or back print file");
  const skipped: PhotoEstimate["skipped"] = [];
  const colors: BlankColor[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  for (const c of spec.colors) {
    const hex = c.hex.toLowerCase();
    if (seen.has(hex)) duplicates++;
    else {
      seen.add(hex);
      colors.push({ name: c.name, hex });
    }
  }
  const garments = [...new Set(spec.garments)];
  const views = [...new Set(spec.views)];
  const planned: Planned[] = [];
  let unavailable = 0;
  for (const garment of garments) {
    for (const view of views) {
      if (view === "back" && !back) {
        skipped.push({ garment, view, reason: "no_back_print_file" });
        continue;
      }
      if (view !== "back" && !front) {
        unavailable += colors.length;
        continue;
      }
      for (let d = 0; d < duplicates; d++)
        skipped.push({ garment, view, reason: "duplicate_color" });
      for (const color of colors) planned.push({ garment, view, color });
    }
  }
  if (unavailable > 0)
    throw photoBadRequest(
      "view_not_available",
      unavailable,
      "This design has no front print file; choose the back view only",
    );
  if (planned.length > MAX_PHOTO_COMPOSITIONS)
    throw photoBadRequest(
      "too_many_compositions",
      planned.length,
      `At most ${MAX_PHOTO_COMPOSITIONS} compositions per set`,
    );
  if (planned.length === 0)
    throw photoBadRequest("view_not_available", 0, "None of the chosen views can be shown");
  const channels = [...new Set(spec.channels)];
  return { design, front, back, planned, skipped, channels, colors, garments, views };
}

export async function estimate(
  tx: Tx,
  ctx: TenantContext,
  spec: PhotoSetSpec,
): Promise<PhotoEstimate> {
  const p = await plan(tx, ctx, spec);
  const credits = p.planned.length * PHOTO_TEMPLATE_CREDITS;
  const balance = await creditBalance(tx, ctx.companyId);
  return {
    compositions: p.planned.length,
    images: p.planned.length * p.channels.length,
    credits,
    creditsRemaining: balance.remaining,
    canAfford: balance.remaining >= credits,
    skipped: p.skipped,
  };
}

function specHash(spec: PhotoSetSpec): string {
  return sha256Hex(
    JSON.stringify({
      designId: spec.designId,
      garments: spec.garments,
      colors: spec.colors.map((c) => [c.name, c.hex.toLowerCase()]),
      views: spec.views,
      channels: spec.channels,
      underbasePreview: spec.underbasePreview,
    }),
  );
}

/** Per channel: the analysis's suggested view order, then the template order. */
function viewRank(order: string[] | undefined): (v: string) => number {
  const ranked = [...(order ?? []).filter((v) => v !== "lifestyle"), ...TEMPLATE_VIEWS];
  return (v) => ranked.indexOf(v);
}

export async function createSet(
  tx: Tx,
  ctx: TenantContext,
  input: PhotoSetCreateInput,
): Promise<PhotoSet> {
  const hash = specHash(input);
  const [existing] = await tx
    .select()
    .from(photoSets)
    .where(eq(photoSets.idempotencyKey, input.idempotencyKey))
    .limit(1);
  if (existing) return sameKey(tx, ctx, existing, hash);

  const p = await plan(tx, ctx, input);
  const credits = p.planned.length * PHOTO_TEMPLATE_CREDITS;
  const committed = await openCommitments(tx);
  const balance = await creditBalance(tx, ctx.companyId);
  const available = balance.remaining - committed;
  if (available < credits) throw creditsExhausted(Math.max(0, available), balance.periodEnd);

  const [analysisRow] = await tx
    .select({ analysis: photoAnalyses.analysis, status: photoAnalyses.status })
    .from(photoAnalyses)
    .where(eq(photoAnalyses.designId, p.design.id))
    .limit(1);
  const analysis = analysisRow?.status === "ready" ? analysisRow.analysis : null;

  const [set] = await tx
    .insert(photoSets)
    .values({
      companyId: ctx.companyId,
      designId: p.design.id,
      designName: p.design.name,
      idempotencyKey: input.idempotencyKey,
      specHash: hash,
      garments: p.garments,
      colors: p.colors,
      views: p.views,
      channels: p.channels,
      underbasePreview: input.underbasePreview,
      creditsEstimated: credits,
      createdBy: ctx.userId,
    })
    .onConflictDoNothing({ target: [photoSets.companyId, photoSets.idempotencyKey] })
    .returning();
  if (!set) {
    // A concurrent request with the same key won the insert.
    const [raced] = await tx
      .select()
      .from(photoSets)
      .where(eq(photoSets.idempotencyKey, input.idempotencyKey))
      .limit(1);
    if (!raced) throw conflict("This request is already being processed");
    return sameKey(tx, ctx, raced, hash);
  }

  const comps = await tx
    .insert(photoCompositions)
    .values(
      p.planned.map((c) => ({
        companyId: ctx.companyId,
        setId: set.id,
        source: "template" as const,
        garment: c.garment,
        view: c.view,
        colorName: c.color.name,
        colorHex: c.color.hex,
        placement: c.view === "back" ? ("back" as const) : ("front" as const),
      })),
    )
    .returning();
  const gIdx = (g: string) => p.garments.indexOf(g as never);
  const cIdx = (hex: string) => p.colors.findIndex((c) => c.hex === hex);
  const images: (typeof photoImages.$inferInsert)[] = [];
  for (const channel of p.channels) {
    const rank = viewRank(analysis?.imageOrder?.[channel]);
    const ordered = [...comps].sort(
      (a, b) =>
        rank(a.view) - rank(b.view) ||
        gIdx(a.garment) - gIdx(b.garment) ||
        cIdx(a.colorHex) - cIdx(b.colorHex),
    );
    ordered.forEach((c, slot) => {
      images.push({
        companyId: ctx.companyId,
        setId: set.id,
        compositionId: c.id,
        channel,
        preset: presetFor(channel, slot),
        slot,
        drawnTemplate: true,
        altText: analysis?.altText?.[channel]?.slice(0, 250) ?? null,
      });
    });
  }
  await tx.insert(photoImages).values(images);
  await emit(tx, ctx.companyId, "photo_set.created", {
    setId: set.id,
    designId: set.designId,
    compositionIds: comps.map((c) => c.id),
  });
  await audit(tx, {
    companyId: ctx.companyId,
    actor: ctx.actor,
    action: "photos.set_created",
    entityType: "photo_set",
    entityId: set.id,
    summary: `Listing photo set: ${comps.length} compositions, ${images.length} images`,
    data: { compositions: comps.length, images: images.length, credits },
  });
  publishSetAfterCommit(tx, ctx.companyId, set.id);
  return getSet(tx, ctx, { id: set.id });
}

async function sameKey(tx: Tx, ctx: TenantContext, row: SetRow, hash: string) {
  if (row.specHash !== hash)
    throw conflict("This request key was already used for a different photo set");
  return getSet(tx, ctx, { id: row.id });
}

/* ---- Reads -------------------------------------------------------------------------------- */

export async function listSets(
  tx: Tx,
  ctx: TenantContext,
  input: PageInput & { designId?: string; status?: PhotoSetStatus[] },
) {
  const page = keyset(photoSets.createdAt, photoSets.id, input);
  const rows = await tx
    .select()
    .from(photoSets)
    .where(
      and(
        page.where,
        input.designId ? eq(photoSets.designId, input.designId) : undefined,
        input.status?.length ? inArray(photoSets.status, input.status) : undefined,
      ),
    )
    .orderBy(...page.orderBy)
    .limit(page.limit + 1);
  const pageRows = rows.slice(0, page.limit);
  const ids = pageRows.map((r) => r.id);
  const aggs = await aggregates(tx, ids);
  // Only the slot-0 image per set is signed (lesson 2026-10-01 P1: no URL per image in lists).
  const leads = ids.length
    ? await tx
        .select()
        .from(photoImages)
        .where(
          and(
            inArray(photoImages.setId, ids),
            eq(photoImages.slot, 0),
            inArray(photoImages.status, DONE_IMAGE),
          ),
        )
    : [];
  const summaries = new Map<string, PhotoSetSummary>();
  for (const r of pageRows) {
    const lead = leadOf(r, leads);
    summaries.set(
      r.id,
      await toSummary(
        r,
        aggs.get(r.id) ?? emptyAgg(),
        await signed(ctx.companyId, lead?.key ?? null),
        null,
      ),
    );
  }
  return page.result(rows, (r) => summaries.get(r.id) as PhotoSetSummary);
}

export async function getSet(tx: Tx, ctx: TenantContext, input: { id: string }): Promise<PhotoSet> {
  const s = await loadSetRow(tx, input.id);
  const comps = await tx
    .select()
    .from(photoCompositions)
    .where(eq(photoCompositions.setId, s.id))
    .orderBy(asc(photoCompositions.createdAt), asc(photoCompositions.id));
  const imgs = await tx
    .select()
    .from(photoImages)
    .where(eq(photoImages.setId, s.id))
    .orderBy(asc(photoImages.channel), asc(photoImages.slot));
  const byComp = new Map(comps.map((c) => [c.id, c]));
  const agg = (await aggregates(tx, [s.id])).get(s.id) ?? emptyAgg();
  const images: PhotoImage[] = [];
  for (const i of imgs) {
    const c = byComp.get(i.compositionId);
    if (!c) continue;
    const url = DONE_IMAGE.includes(i.status) ? await signed(ctx.companyId, i.key) : null;
    images.push(toImage(i, c, url));
  }
  const lead = leadOf(
    s,
    imgs.filter((i) => DONE_IMAGE.includes(i.status)),
  );
  const leadUrl = lead ? (images.find((i) => i.id === lead.id)?.url ?? null) : null;
  const zipUrl = s.zipStatus === "ready" ? await signed(ctx.companyId, s.zipKey) : null;
  return {
    ...(await toSummary(s, agg, leadUrl, zipUrl)),
    compositions: comps.map(toComposition),
    images,
    pushes: [],
  };
}

/* ---- Review ------------------------------------------------------------------------------- */

export async function reviewImages(
  tx: Tx,
  ctx: TenantContext,
  input: { setId: string; approve: string[]; reject: string[] },
): Promise<PhotoSet> {
  const s = await loadSetRow(tx, input.setId);
  const wanted = [...new Set([...input.approve, ...input.reject])];
  const rows = await tx
    .select()
    .from(photoImages)
    .where(and(eq(photoImages.setId, s.id), inArray(photoImages.id, wanted)))
    .for("update");
  const missing = wanted.length - rows.length;
  if (missing > 0)
    throw photoBadRequest("image_not_in_set", missing, "Some images are not part of this set");
  const approve = new Set(input.approve);
  const changes: { id: string; to: "approved" | "rejected" }[] = [];
  let notReviewable = 0;
  for (const r of rows) {
    const to = approve.has(r.id) ? "approved" : "rejected";
    if (r.status === to) continue;
    if (!canTransitionPhotoImage(r.status, to)) notReviewable++;
    else changes.push({ id: r.id, to });
  }
  if (notReviewable > 0)
    throw photoBadRequest(
      "not_reviewable",
      notReviewable,
      "Only rendered images can be approved or rejected",
    );
  const now = new Date();
  for (const to of ["approved", "rejected"] as const) {
    const ids = changes.filter((c) => c.to === to).map((c) => c.id);
    if (ids.length === 0) continue;
    await tx
      .update(photoImages)
      .set({ status: to, reviewedBy: ctx.userId, reviewedAt: now })
      .where(inArray(photoImages.id, ids));
  }
  if (changes.length > 0) {
    await audit(tx, {
      companyId: ctx.companyId,
      actor: ctx.actor,
      action: "photos.images_reviewed",
      entityType: "photo_set",
      entityId: s.id,
      summary: `Reviewed ${changes.length} listing photos`,
      data: {
        approved: changes.filter((c) => c.to === "approved").length,
        rejected: changes.filter((c) => c.to === "rejected").length,
      },
    });
    publishSetAfterCommit(tx, ctx.companyId, s.id);
  }
  return getSet(tx, ctx, { id: s.id });
}

/* ---- Zip ---------------------------------------------------------------------------------- */

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "color";

/** `<channel>/<slot>-<garment>-<view>-<color>.jpg`, slot zero-padded (00 is the main image). */
export function zipName(i: ImageRow, c: CompositionRow): string {
  const ext = i.format === "png" ? "png" : "jpg";
  return `${i.channel}/${String(i.slot).padStart(2, "0")}-${c.garment}-${c.view}-${slug(c.colorName)}.${ext}`;
}

export async function exportZip(
  tx: Tx,
  ctx: TenantContext,
  input: { setId: string; channel?: PhotoSetSpec["channels"][number] },
) {
  const s = (
    await tx.select().from(photoSets).where(eq(photoSets.id, input.setId)).for("update").limit(1)
  )[0];
  if (!s) throw notFound("photo set", input.setId);
  const scope = await tx
    .select()
    .from(photoImages)
    .where(
      and(
        eq(photoImages.setId, s.id),
        input.channel ? eq(photoImages.channel, input.channel) : undefined,
      ),
    );
  const approved = scope.filter((i) => i.status === "approved" && i.key);
  const excluded = scope
    .filter((i) => i.status !== "approved")
    .map((i) => ({ imageId: i.id, reason: "not_approved" as const }));
  if (approved.length === 0) {
    const waiting = scope.filter((i) => i.status === "rendered").length;
    throw photoBadRequest("not_approved", waiting, "Approve at least one image first");
  }
  const fingerprint = sha256Hex(
    JSON.stringify({ channel: input.channel ?? null, ids: approved.map((i) => i.id).sort() }),
  );
  const reuse =
    s.zipFingerprint === fingerprint &&
    s.zipJobId &&
    (s.zipStatus === "ready" || s.zipStatus === "queued" || s.zipStatus === "building");
  let zipJobId = s.zipJobId;
  let row = s;
  if (!reuse || !zipJobId) {
    zipJobId = crypto.randomUUID();
    [row] = (await tx
      .update(photoSets)
      .set({
        zipStatus: "queued",
        zipChannel: input.channel ?? null,
        zipJobId,
        zipFingerprint: fingerprint,
        zipError: null,
        zipImageCount: approved.length,
      })
      .where(eq(photoSets.id, s.id))
      .returning()) as [SetRow];
    const job = { companyId: ctx.companyId, setId: s.id, zipJobId };
    afterCommit(tx, () =>
      enqueueZip(job).catch(async (err) => {
        log.error("zip enqueue failed", {
          companyId: ctx.companyId,
          setId: s.id,
          error: (err as Error).message,
        });
        await failZip(
          ctx.companyId,
          s.id,
          job.zipJobId,
          "The zip could not be started. Try again.",
        );
      }),
    );
  }
  const zipUrl = row.zipStatus === "ready" ? await signed(ctx.companyId, row.zipKey) : null;
  const summary = await toSummary(row, emptyAgg(), null, zipUrl);
  return { jobId: zipJobId, zip: summary.zip, included: approved.length, excluded };
}

async function failZip(companyId: string, setId: string, zipJobId: string, error: string) {
  await withTenant(companyId, (tx) =>
    tx
      .update(photoSets)
      .set({ zipStatus: "failed", zipError: error })
      .where(and(eq(photoSets.id, setId), eq(photoSets.zipJobId, zipJobId))),
  );
  void publishSet(companyId, setId);
}

/** The zip job: the approved images at the time it runs, through imaging, outside any tx. */
export async function runZip(
  input: ZipJobInput,
  finalAttempt: boolean,
): Promise<{ status: "ready" | "failed" | "skipped"; key?: string }> {
  const { companyId, setId, zipJobId } = input;
  const prep = await withTenant(companyId, async (tx) => {
    const [s] = await tx.select().from(photoSets).where(eq(photoSets.id, setId)).limit(1);
    if (!s || s.zipJobId !== zipJobId) return null;
    if (s.zipStatus === "ready" && s.zipKey) return { done: s.zipKey };
    const imgs = await tx
      .select({ i: photoImages, c: photoCompositions })
      .from(photoImages)
      .innerJoin(photoCompositions, eq(photoCompositions.id, photoImages.compositionId))
      .where(
        and(
          eq(photoImages.setId, setId),
          eq(photoImages.status, "approved"),
          s.zipChannel ? eq(photoImages.channel, s.zipChannel) : undefined,
        ),
      )
      .orderBy(asc(photoImages.channel), asc(photoImages.slot));
    await tx.update(photoSets).set({ zipStatus: "building" }).where(eq(photoSets.id, setId));
    return {
      items: imgs
        .filter(({ i }) => i.key && isCompanyKey(companyId, i.key))
        .map(({ i, c }) => ({ key: i.key as string, name: zipName(i, c) })),
    };
  });
  if (!prep) return { status: "skipped" };
  if ("done" in prep) return { status: "ready", key: prep.done };
  if (prep.items.length === 0) {
    await failZip(companyId, setId, zipJobId, "No approved images to zip.");
    return { status: "failed" };
  }
  const outKey = `${companyId}/photos/${setId}/zip/${zipJobId}.zip`;
  let res: { key: string; bytes: number };
  try {
    res = await imaging.photoZip({ items: prep.items, out_key: outKey });
  } catch (err) {
    const permanent =
      err instanceof ImagingError && err.status > 0 && isPermanentHttpStatus(err.status);
    log.warn("photo zip failed", {
      companyId,
      setId,
      permanent,
      finalAttempt,
      error: (err as Error).message,
    });
    if (permanent || finalAttempt) {
      await failZip(companyId, setId, zipJobId, "The zip could not be built. Try again.");
      return { status: "failed" };
    }
    throw err;
  }
  await withTenant(companyId, (tx) =>
    tx
      .update(photoSets)
      .set({
        zipStatus: "ready",
        zipKey: res.key,
        zipBytes: res.bytes,
        zipImageCount: prep.items.length,
        zipBuiltAt: new Date(),
        zipError: null,
      })
      .where(and(eq(photoSets.id, setId), eq(photoSets.zipJobId, zipJobId))),
  );
  void publishSet(companyId, setId);
  return { status: "ready", key: res.key };
}

/* ---- Attach to a listing draft ------------------------------------------------------------ */

export async function attachToDraft(
  tx: Tx,
  ctx: TenantContext,
  input: { setId: string; draftId: string; imageIds: string[] },
): Promise<{
  draft: ListingDraft;
  attached: number;
  excluded: { imageId: string; reason: "not_approved" | "channel_mismatch" }[];
}> {
  const s = await loadSetRow(tx, input.setId);
  const draft = await getDraft(tx, ctx, input.draftId);
  const ids = [...new Set(input.imageIds)];
  const rows = await tx
    .select()
    .from(photoImages)
    .where(and(eq(photoImages.setId, s.id), inArray(photoImages.id, ids)))
    .orderBy(asc(photoImages.slot));
  if (rows.length < ids.length)
    throw photoBadRequest(
      "image_not_in_set",
      ids.length - rows.length,
      "Some images are not part of this set",
    );
  const excluded: { imageId: string; reason: "not_approved" | "channel_mismatch" }[] = [];
  const ok: ImageRow[] = [];
  for (const r of rows) {
    if (r.status !== "approved" || !r.key || !isCompanyKey(ctx.companyId, r.key))
      excluded.push({ imageId: r.id, reason: "not_approved" });
    else if (r.channel !== draft.channel)
      excluded.push({ imageId: r.id, reason: "channel_mismatch" });
    else ok.push(r);
  }
  if (ok.length === 0) {
    const notApproved = excluded.filter((e) => e.reason === "not_approved").length;
    if (notApproved > 0)
      throw photoBadRequest(
        "not_approved",
        notApproved,
        "Approve the images before attaching them",
      );
    throw photoBadRequest(
      "channel_mismatch",
      excluded.length,
      "These images were made for a different channel than the draft",
    );
  }
  const updated = await attachPhotosToDraft(tx, ctx, {
    draftId: draft.id,
    imageKeys: ok.map((r) => r.key as string),
    aiGenerated: ok.some((r) => r.aiGenerated),
    syntheticPerformer: ok.some((r) => r.containsSyntheticPerson),
  });
  await audit(tx, {
    companyId: ctx.companyId,
    actor: ctx.actor,
    action: "photos.attached_to_draft",
    entityType: "photo_set",
    entityId: s.id,
    summary: `Attached ${ok.length} listing photos to a draft`,
    data: { draftId: draft.id, attached: ok.length, excluded: excluded.length },
  });
  return { draft: updated, attached: ok.length, excluded };
}

/* ---- Render (one job per composition) ----------------------------------------------------- */

/** Composition ids of a set that still have images to render (the dispatch job's input). */
export async function openCompositions(companyId: string, setId: string): Promise<string[]> {
  return withTenant(companyId, async (tx) => {
    const rows = await tx
      .selectDistinct({ id: photoImages.compositionId })
      .from(photoImages)
      .where(and(eq(photoImages.setId, setId), inArray(photoImages.status, OPEN_IMAGE)));
    return rows.map((r) => r.id);
  });
}

const CHECK_CODES = new Set<string>(PHOTO_CHECK_CODES);
const WARN_ONLY = new Set(["design_larger_than_print_area"]);

export function toChecks(c: PhotoRenderResult["checks"]): PhotoChecks {
  const failures: PhotoCheckFailure[] = [];
  for (const code of c.failures) {
    if (!CHECK_CODES.has(code)) {
      log.warn("unknown photo check code from imaging", { code });
      continue;
    }
    failures.push({
      code: code as PhotoCheckFailure["code"],
      severity: WARN_ONLY.has(code) ? "warn" : "error",
      detail: null,
    });
  }
  return {
    passes: c.passes,
    failures,
    backgroundPureWhite: c.background_pure_white,
    fillRatio: c.fill_ratio === null ? null : clamp01(c.fill_ratio),
    longestSidePx: c.longest_side_px,
    regionUnchangedScore: null,
  };
}

function readableImagingError(err: unknown): { message: string; transient: boolean } {
  if (err instanceof ImagingError && err.status > 0 && isPermanentHttpStatus(err.status))
    return { message: `The image service refused this photo (${err.status}).`, transient: false };
  return { message: "The image service is not responding. Try again later.", transient: true };
}

type RenderOutcome =
  | { imageId: string; ok: true; res: PhotoRenderResult }
  | { imageId: string; ok: false; error: string };

/**
 * Renders every open image of one composition, then charges the composition once.
 * Three steps (no transaction across imaging): claim the images, render, then lock the set and
 * the composition and record results + the charge (only when `charged_at` is null).
 */
export async function renderComposition(
  companyId: string,
  compositionId: string,
  finalAttempt: boolean,
): Promise<{ rendered: number; failed: number; charged: boolean; skipped?: boolean }> {
  const ctx = systemContext(companyId);
  const prep = await withTenant(companyId, async (tx) => {
    const [c] = await tx
      .select()
      .from(photoCompositions)
      .where(eq(photoCompositions.id, compositionId))
      .limit(1);
    if (!c) return null;
    const s = await loadSetRow(tx, c.setId);
    const open = await tx
      .select()
      .from(photoImages)
      .where(and(eq(photoImages.compositionId, c.id), inArray(photoImages.status, OPEN_IMAGE)));
    if (open.length === 0) return { c, s, open, file: null };
    if (!c.chargedAt) {
      // Claim step (S-51): no render, and no charge, once the balance can't pay for this composition.
      const b = await creditBalance(tx, companyId);
      if (b.remaining < PHOTO_TEMPLATE_CREDITS) {
        const failed = open.map((o) => ({
          imageId: o.id,
          ok: false as const,
          error: CREDITS_USED_UP,
        }));
        return {
          c,
          s,
          open: [],
          file: null,
          noCredits: await recordRenders(tx, companyId, c.id, failed),
        };
      }
    }
    const { front, back } = await printFile(tx, ctx, s.designId);
    const file = c.placement === "back" ? back : front;
    await tx
      .update(photoImages)
      .set({ status: "rendering" })
      .where(and(eq(photoImages.compositionId, c.id), eq(photoImages.status, "queued")));
    if (s.status === "queued")
      await tx.update(photoSets).set({ status: "rendering" }).where(eq(photoSets.id, s.id));
    return { c, s, open, file: file ?? null };
  });
  if (!prep) return { rendered: 0, failed: 0, charged: false, skipped: true };
  if ("noCredits" in prep && prep.noCredits) {
    log.warn("photo render skipped: credits used up", { companyId, compositionId });
    void publishSet(companyId, prep.s.id);
    return prep.noCredits;
  }
  const { c, s, open, file } = prep;

  const outcomes: RenderOutcome[] = [];
  let retryLater: unknown = null;
  for (const img of open) {
    if (!file) {
      outcomes.push({
        imageId: img.id,
        ok: false,
        error: `The design has no ${c.placement} print file.`,
      });
      continue;
    }
    try {
      const res = await imaging.photoRender({
        design_key: file.fileKey,
        design_width_in: file.widthIn,
        design_height_in: file.heightIn,
        placement: c.placement,
        garment: c.garment,
        view: c.view,
        blank_hex: c.colorHex,
        underbase_preview: s.underbasePreview,
        preset: img.preset,
        out_key: `${companyId}/photos/${s.id}/${img.id}.jpg`,
        xmp_subjects: [],
      });
      outcomes.push({ imageId: img.id, ok: true, res });
    } catch (err) {
      const { message, transient } = readableImagingError(err);
      log.warn("photo render failed", {
        companyId,
        compositionId,
        imageId: img.id,
        transient,
        finalAttempt,
      });
      if (transient && !finalAttempt) {
        retryLater = err;
        break;
      }
      outcomes.push({ imageId: img.id, ok: false, error: message });
    }
  }

  const result = await withTenant(companyId, (tx) => recordRenders(tx, companyId, c.id, outcomes));
  void publishSet(companyId, s.id);
  if (retryLater) throw retryLater;
  return result;
}

async function recordRenders(
  tx: Tx,
  companyId: string,
  compositionId: string,
  outcomes: RenderOutcome[],
) {
  const [c0] = await tx
    .select({ setId: photoCompositions.setId })
    .from(photoCompositions)
    .where(eq(photoCompositions.id, compositionId));
  if (!c0) return { rendered: 0, failed: 0, charged: false };
  await lockCompanyCharges(tx, companyId);
  // Lock order: company charge lock, set, then composition (every writer of both takes them in this order).
  const [s] = await tx.select().from(photoSets).where(eq(photoSets.id, c0.setId)).for("update");
  const [c] = await tx
    .select()
    .from(photoCompositions)
    .where(eq(photoCompositions.id, compositionId))
    .for("update");
  if (!s || !c) return { rendered: 0, failed: 0, charged: false };
  let rendered = 0;
  let failed = 0;
  for (const o of outcomes) {
    const set: Partial<typeof photoImages.$inferInsert> = o.ok
      ? {
          status: "rendered",
          key: isCompanyKey(companyId, o.res.key) ? o.res.key : null,
          widthPx: o.res.width_px,
          heightPx: o.res.height_px,
          format: o.res.format === "png" ? "png" : "jpeg",
          checks: toChecks(o.res.checks),
          error: null,
        }
      : { status: "failed", error: o.error };
    const updated = await tx
      .update(photoImages)
      .set(set)
      .where(and(eq(photoImages.id, o.imageId), inArray(photoImages.status, OPEN_IMAGE)))
      .returning({ id: photoImages.id });
    if (updated.length) o.ok ? rendered++ : failed++;
  }

  // One charge per composition: only when an image of it rendered and nothing was charged yet.
  const imgs = await tx.select().from(photoImages).where(eq(photoImages.compositionId, c.id));
  let charged = false;
  if (!c.chargedAt && imgs.some((i) => DONE_IMAGE.includes(i.status))) {
    const credits = PHOTO_TEMPLATE_CREDITS;
    const b = await creditBalance(tx, companyId);
    if (b.remaining < credits) {
      // Another set spent the credits while this one rendered (S-51): keep nothing, charge nothing.
      const voided = await tx
        .update(photoImages)
        .set({ status: "failed", key: null, error: CREDITS_USED_UP })
        .where(and(eq(photoImages.compositionId, c.id), eq(photoImages.status, "rendered")))
        .returning({ id: photoImages.id });
      rendered = Math.max(0, rendered - voided.length);
      failed += voided.length;
      await finalizeSet(tx, companyId, s.id);
      return { rendered, failed, charged: false };
    }
    await chargeCredits(tx, {
      companyId,
      kind: "photo_image",
      credits,
      model: null,
      usage: null,
      ref: { type: "photo_composition", id: c.id },
      userId: s.createdBy,
    });
    await tx
      .update(photoCompositions)
      .set({ chargedAt: new Date(), creditsCharged: credits })
      .where(eq(photoCompositions.id, c.id));
    const lead =
      imgs.find((i) => i.channel === s.channels[0] && DONE_IMAGE.includes(i.status)) ??
      imgs.find((i) => DONE_IMAGE.includes(i.status));
    if (lead)
      await tx
        .update(photoImages)
        .set({ creditsCharged: credits })
        .where(eq(photoImages.id, lead.id));
    charged = true;
  }
  await finalizeSet(tx, companyId, s.id);
  return { rendered, failed, charged };
}

/** Moves the set to `ready`/`failed` once no image is open; emits `photo_set.completed` once. */
async function finalizeSet(tx: Tx, companyId: string, setId: string) {
  const agg = (await aggregates(tx, [setId])).get(setId) ?? emptyAgg();
  if (agg.counts.queued + agg.counts.rendering > 0) return;
  const done = agg.counts.rendered + agg.counts.approved + agg.counts.rejected;
  const status = done > 0 ? "ready" : "failed";
  const [moved] = await tx
    .update(photoSets)
    .set({
      status,
      completedAt: new Date(),
      error:
        status === "failed"
          ? "No photo could be rendered."
          : agg.counts.failed > 0
            ? `${agg.counts.failed} of ${agg.counts.total} photos could not be rendered.`
            : null,
    })
    .where(and(eq(photoSets.id, setId), notInArray(photoSets.status, ["ready", "failed"])))
    .returning({ id: photoSets.id });
  if (moved) await emit(tx, companyId, "photo_set.completed", { setId, status });
}

/** Final failure of a render job (BullMQ gave up): its open images fail, nothing is charged. */
export async function failComposition(companyId: string, compositionId: string, error: string) {
  const setId = await withTenant(companyId, async (tx) => {
    const [c] = await tx
      .select({ setId: photoCompositions.setId })
      .from(photoCompositions)
      .where(eq(photoCompositions.id, compositionId));
    if (!c) return null;
    const open = await tx
      .select({ id: photoImages.id })
      .from(photoImages)
      .where(
        and(eq(photoImages.compositionId, compositionId), inArray(photoImages.status, OPEN_IMAGE)),
      );
    await recordRenders(
      tx,
      companyId,
      compositionId,
      open.map((o) => ({ imageId: o.id, ok: false as const, error })),
    );
    return c.setId;
  });
  if (setId) void publishSet(companyId, setId);
}

/* ---- Realtime ----------------------------------------------------------------------------- */

async function publishSet(companyId: string, setId: string) {
  try {
    const payload = await withTenant(companyId, async (tx) => {
      const [s] = await tx.select().from(photoSets).where(eq(photoSets.id, setId)).limit(1);
      if (!s) return null;
      const a = (await aggregates(tx, [setId])).get(setId) ?? emptyAgg();
      return {
        setId,
        designId: s.designId,
        status: s.status,
        rendered: a.counts.rendered + a.counts.approved + a.counts.rejected,
        failed: a.counts.failed,
        total: a.counts.total,
      };
    });
    if (payload) await publish(companyId, "photo_set.updated", payload);
  } catch (err) {
    log.warn("photo_set.updated publish failed", {
      companyId,
      setId,
      error: (err as Error).message,
    });
  }
}

function publishSetAfterCommit(tx: Tx, companyId: string, setId: string) {
  afterCommit(tx, () => publishSet(companyId, setId));
}
