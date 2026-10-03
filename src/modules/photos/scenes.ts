import {
  type DesignPhotoAnalysis,
  PHOTO_CHECK_CODES,
  type PhotoCheckFailure,
  type PhotoChecks,
} from "@invai/contracts";
import { and, eq, inArray, isNull, lte, or } from "drizzle-orm";
import {
  assertImageGenAllowed,
  buildScenePrompt,
  getImageProvider,
  ImageGenError,
  ImageRefusalError,
  recordImageGen,
} from "../../ai/images";
import { PHOTO_SCENE_CREDITS, PHOTO_TEMPLATE_CREDITS } from "../../ai/models";
import { systemContext } from "../../api/context";
import { type Tx, withTenant } from "../../db/client";
import { photoCompositions, photoImages, photoSets } from "../../db/schema";
import {
  ImagingError,
  imaging,
  type PhotoSceneCompositeResult,
} from "../../integrations/imaging/client";
import { isORPCError } from "../../lib/errors";
import { logger } from "../../lib/log";
import { isPermanentHttpStatus } from "../../lib/queues";
import { getObject, headObject, isCompanyKey, putObject } from "../../lib/s3";
import {
  CREDITS_USED_UP,
  loadSetRow,
  lockCompanyCharges,
  OPEN_IMAGE,
  openWork,
  printFile,
  publishSet,
  type RenderOutcome,
  readyAnalysis,
  recordRenders,
  SCENE_SIZE_PX,
} from "./service";

/*
 * Lifestyle scenes (phase B, T-27-3, ADR 0023 §1-§3, §5). One job per scene composition:
 *   claim (company charge lock: caps + credits checked before any provider call, images claimed)
 *   -> imaging scene base + mask (blank garment, no design pixels)
 *   -> provider scene (stored under the company prefix; a stored scene is never generated again)
 *   -> imaging scene composite per channel preset (design-lock checks)
 *   -> record results and charge PHOTO_SCENE_CREDITS once (charge lock, set, composition).
 * A failed lock check regenerates the scene once; a second failure fails the images, uncharged.
 * No transaction is open across imaging or the provider.
 */

const log = logger("photos.scenes");

type CompositionRow = typeof photoCompositions.$inferSelect;
type ImageRow = typeof photoImages.$inferSelect;

/** Amazon's XMP subject for a photoreal AI person (ADR 0023 §3). */
export const SYNTHETIC_PERFORMER_SUBJECT = "contains-synthetic-performer";
const LOCK_CODES = new Set(["design_drift", "region_changed"]);
const CHECK_CODES = new Set<string>(PHOTO_CHECK_CODES);

const MSG = {
  cap: "Today's limit for AI scene images is reached. Try again tomorrow.",
  spend: "Today's AI spending limit is reached. Try again tomorrow.",
  refused: "The image service declined to draw this scene. Try another scene kind.",
  provider: "The image service could not draw this scene. Try again later.",
  imaging: "The image service is not responding. Try again later.",
  noFront: "The design has no front print file.",
  drift: (codes: string[]) =>
    `The design did not match the scene after two tries (${codes.join(", ")}). Try again.`,
};

const sceneKey = (c: CompositionRow, attempt: number) =>
  `${c.companyId}/photos/${c.setId}/scenes/${c.id}-a${attempt}.png`;
const baseKeys = (c: CompositionRow) => ({
  out_key: `${c.companyId}/photos/${c.setId}/scenes/${c.id}-base.png`,
  mask_out_key: `${c.companyId}/photos/${c.setId}/scenes/${c.id}-mask.png`,
});

/** Thrown to let BullMQ retry (imaging or the provider was briefly unavailable). */
class RetryLater extends Error {
  constructor(readonly cause: unknown) {
    super((cause as Error)?.message ?? "retry later");
  }
}

/**
 * Credits and caps for one more provider call, under the company charge lock (AC8): the daily
 * scene cap (scenes claimed elsewhere and not yet drawn count too), credits held by claimed,
 * uncharged work elsewhere, then the spend cap. Returns the shop-readable refusal, or null.
 */
async function sceneRefusal(tx: Tx, companyId: string, compositionId: string) {
  const others = await openWork(tx, ["rendering"], compositionId);
  try {
    await assertImageGenAllowed(tx, companyId, 1 + others.scenesPending, {
      heldCredits:
        others.templates * PHOTO_TEMPLATE_CREDITS + others.scenesStored * PHOTO_SCENE_CREDITS,
      sizePx: SCENE_SIZE_PX,
    });
    return null;
  } catch (err) {
    if (!isORPCError(err)) throw err;
    if (err.code === "IMAGE_DAILY_CAP_REACHED") return MSG.cap;
    if (err.code === "CREDITS_EXHAUSTED") return CREDITS_USED_UP;
    if (err.code === "AI_SPEND_CAP_REACHED") return MSG.spend;
    throw err;
  }
}

const failAll = (open: { id: string }[], error: string): RenderOutcome[] =>
  open.map((o) => ({ imageId: o.id, ok: false as const, error }));

type Prepared = {
  c: CompositionRow;
  setId: string;
  createdBy: string | null;
  underbase: boolean;
  open: ImageRow[];
  front: { fileKey: string; widthIn: number; heightIn: number } | null;
  analysis: DesignPhotoAnalysis | null;
};

export type SceneResult = {
  rendered: number;
  failed: number;
  charged: boolean;
  providerCalls: number;
  skipped?: boolean;
};

export async function renderScene(
  companyId: string,
  compositionId: string,
  finalAttempt: boolean,
): Promise<SceneResult> {
  const ctx = systemContext(companyId);
  let providerCalls = 0;

  // 1. Claim, under the charge lock (lock order as in recordRenders: company, then rows).
  const claim = await withTenant(companyId, async (tx) => {
    await lockCompanyCharges(tx, companyId);
    const [c] = await tx
      .select()
      .from(photoCompositions)
      .where(eq(photoCompositions.id, compositionId))
      .limit(1);
    if (c?.source !== "ai_scene") return null;
    const s = await loadSetRow(tx, c.setId);
    const open = await tx
      .select()
      .from(photoImages)
      .where(and(eq(photoImages.compositionId, c.id), inArray(photoImages.status, OPEN_IMAGE)));
    if (open.length === 0) return { kind: "done" as const, setId: s.id };
    const needsProvider = !c.sceneKey;
    if (needsProvider && !c.chargedAt) {
      const refusal = await sceneRefusal(tx, companyId, c.id);
      if (refusal) {
        const r = await recordRenders(tx, companyId, c.id, failAll(open, refusal));
        return { kind: "refused" as const, setId: s.id, refused: r };
      }
    }
    await tx
      .update(photoImages)
      .set({ status: "rendering" })
      .where(and(eq(photoImages.compositionId, c.id), eq(photoImages.status, "queued")));
    if (s.status === "queued")
      await tx.update(photoSets).set({ status: "rendering" }).where(eq(photoSets.id, s.id));
    const { front } = await printFile(tx, ctx, s.designId);
    const prep: Prepared = {
      c,
      setId: s.id,
      createdBy: s.createdBy,
      underbase: s.underbasePreview,
      open,
      front: front ?? null,
      analysis: await readyAnalysis(tx, s.designId),
    };
    return { kind: "claimed" as const, prep };
  });
  if (!claim) return { rendered: 0, failed: 0, charged: false, providerCalls, skipped: true };
  if (claim.kind === "done")
    return { rendered: 0, failed: 0, charged: false, providerCalls, skipped: true };
  if (claim.kind === "refused") {
    log.warn("photo scene refused before the provider call", { companyId, compositionId });
    void publishSet(companyId, claim.setId);
    return { ...claim.refused, providerCalls };
  }
  const p = claim.prep;

  const finish = async (outcomes: RenderOutcome[]) => {
    const r = await withTenant(companyId, (tx) => recordRenders(tx, companyId, p.c.id, outcomes));
    void publishSet(companyId, p.setId);
    return { ...r, providerCalls };
  };
  const permanent = (error: string) => finish(failAll(p.open, error));

  try {
    if (!p.front) return await permanent(MSG.noFront);
    await ensureBase(p);
    let attempt = Math.max(1, p.c.sceneAttempt);
    for (;;) {
      const scene = await ensureScene(p, attempt, () => providerCalls++);
      if ("refusal" in scene) return await permanent(scene.refusal);
      const results = await compositeAll(p, scene.key);
      const drifted = results.filter(({ res }) => !res.checks.passes || !res.key);
      if (drifted.length > 0 && attempt === 1) {
        log.info("photo scene drifted, regenerating once", {
          companyId,
          compositionId,
          failures: [...new Set(drifted.flatMap(({ res }) => res.checks.failures))],
        });
        await withTenant(companyId, (tx) =>
          tx
            .update(photoCompositions)
            .set({ sceneAttempt: 2, sceneKey: null })
            .where(and(eq(photoCompositions.id, p.c.id), lte(photoCompositions.sceneAttempt, 1))),
        );
        p.c = { ...p.c, sceneAttempt: 2, sceneKey: null };
        attempt = 2;
        continue;
      }
      return await finish(
        results.map(({ img, res }) => toOutcome(img, res, scene.containsPerson, scene.model)),
      );
    }
  } catch (err) {
    if (err instanceof RetryLater && !finalAttempt) throw err.cause;
    const message = err instanceof RetryLater ? readable(err.cause) : readable(err);
    log.warn("photo scene failed", { companyId, compositionId, finalAttempt, message });
    if (!finalAttempt && !(err instanceof RetryLater) && isTransient(err)) throw err;
    return await permanent(message);
  }
}

function isTransient(err: unknown): boolean {
  if (err instanceof ImageRefusalError) return false;
  if (err instanceof ImageGenError) return err.retryable;
  if (err instanceof ImagingError) return !(err.status > 0 && isPermanentHttpStatus(err.status));
  return true;
}

function readable(err: unknown): string {
  if (err instanceof ImageRefusalError) return MSG.refused;
  if (err instanceof ImageGenError) return MSG.provider;
  if (err instanceof ImagingError && err.status > 0 && isPermanentHttpStatus(err.status))
    return `The image service refused this photo (${err.status}).`;
  return MSG.imaging;
}

/** Wraps a call whose transient failure should retry the job (and permanent one fail the images). */
async function step<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw isTransient(err) ? new RetryLater(err) : err;
  }
}

async function ensureBase(p: Prepared) {
  if (p.c.sceneBaseKey && p.c.sceneMaskKey && p.c.scenePrintBoxPx?.length === 4) return;
  const keys = baseKeys(p.c);
  const res = await step(() =>
    imaging.photoSceneBase({
      garment: p.c.garment,
      view: "lifestyle_base",
      blank_hex: p.c.colorHex,
      size_px: SCENE_SIZE_PX,
      ...keys,
    }),
  );
  if (!isCompanyKey(p.c.companyId, res.key) || !isCompanyKey(p.c.companyId, res.mask_key))
    throw new ImagingError("/photo/scene-base", 422, "key outside the company prefix");
  const set = {
    sceneBaseKey: res.key,
    sceneMaskKey: res.mask_key,
    scenePrintBoxPx: res.print_box_px,
  };
  await withTenant(p.c.companyId, (tx) =>
    tx.update(photoCompositions).set(set).where(eq(photoCompositions.id, p.c.id)),
  );
  p.c = { ...p.c, ...set };
}

type StoredScene = { key: string; containsPerson: boolean; model: string };

/**
 * The stored scene for `attempt`, calling the provider only when none is stored: the composition
 * row first, then the deterministic key in S3 (a crash after the upload, before the row update).
 * A second attempt re-checks caps and credits under the charge lock before its provider call.
 */
async function ensureScene(
  p: Prepared,
  attempt: number,
  countCall: () => void,
): Promise<StoredScene | { refusal: string }> {
  const c = p.c;
  const stored = (key: string): StoredScene => ({
    key,
    containsPerson: c.containsPerson,
    model: c.sceneModel ?? "unknown",
  });
  if (c.sceneKey && c.sceneAttempt === attempt) return stored(c.sceneKey);
  const key = sceneKey(c, attempt);
  const save = async (set: Partial<CompositionRow>) => {
    await withTenant(c.companyId, (tx) =>
      tx
        .update(photoCompositions)
        .set({ ...set, sceneAttempt: attempt, sceneKey: key })
        .where(
          and(
            eq(photoCompositions.id, c.id),
            or(isNull(photoCompositions.sceneKey), lte(photoCompositions.sceneAttempt, attempt)),
          ),
        ),
    );
    p.c = { ...c, ...set, sceneAttempt: attempt, sceneKey: key };
  };
  if ((await step(() => headObject(key))).exists) {
    await save({});
    return stored(key);
  }
  if (attempt > 1 && !c.chargedAt) {
    const refusal = await withTenant(c.companyId, async (tx) => {
      await lockCompanyCharges(tx, c.companyId);
      return sceneRefusal(tx, c.companyId, c.id);
    });
    if (refusal) return { refusal };
  }
  const provider = await getImageProvider(c.companyId);
  const prompt = buildScenePrompt(p.analysis, c.sceneKind ?? "studio", c.garment, c.colorName);
  const [baseImage, mask] = await step(() =>
    Promise.all([getObject(c.sceneBaseKey as string), getObject(c.sceneMaskKey as string)]),
  );
  const startedAt = new Date();
  const entity = { type: "photo_composition", id: c.id };
  let result: Awaited<ReturnType<typeof provider.generateScene>>;
  countCall();
  try {
    result = await provider.generateScene({ baseImage, mask, prompt, sizePx: SCENE_SIZE_PX });
  } catch (err) {
    // Spend for a failed call is recorded too (0 when the provider billed nothing).
    await recordImageGen({
      companyId: c.companyId,
      userId: p.createdBy,
      prompt,
      provider,
      result: null,
      error: err,
      entity,
      startedAt,
    });
    throw isTransient(err) ? new RetryLater(err) : err;
  }
  // Spend first (S-55): a failed upload retries and pays again, so this call must already count.
  await recordImageGen({
    companyId: c.companyId,
    userId: p.createdBy,
    prompt,
    provider,
    result,
    entity,
    startedAt,
  });
  await step(() => putObject(key, result.image, "image/png"));
  await save({ containsPerson: result.containsPerson, sceneModel: result.model });
  return { key, containsPerson: result.containsPerson, model: result.model };
}

async function compositeAll(p: Prepared, key: string) {
  const front = p.front as NonNullable<Prepared["front"]>;
  const out: { img: ImageRow; res: PhotoSceneCompositeResult }[] = [];
  for (const img of p.open) {
    const res = await step(() =>
      imaging.photoSceneComposite({
        scene_key: key,
        base_key: p.c.sceneBaseKey as string,
        print_box_px: p.c.scenePrintBoxPx as number[],
        design_key: front.fileKey,
        design_width_in: front.widthIn,
        design_height_in: front.heightIn,
        placement: "front",
        blank_hex: p.c.colorHex,
        preset: img.preset,
        out_key: `${p.c.companyId}/photos/${p.setId}/${img.id}.jpg`,
        xmp_subjects: p.c.containsPerson ? [SYNTHETIC_PERFORMER_SUBJECT] : [],
        underbase_preview: p.underbase,
      }),
    );
    out.push({ img, res });
  }
  return out;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

export function toSceneChecks(res: PhotoSceneCompositeResult): PhotoChecks {
  const failures: PhotoCheckFailure[] = res.checks.failures
    .filter((code) => CHECK_CODES.has(code))
    .map((code) => ({
      code: code as PhotoCheckFailure["code"],
      severity: "error" as const,
      detail: null,
    }));
  const w = res.width_px ?? null;
  const h = res.height_px ?? null;
  return {
    passes: res.checks.passes,
    failures,
    backgroundPureWhite: null,
    fillRatio: null,
    longestSidePx: w && h ? Math.max(w, h) : null,
    regionUnchangedScore:
      res.checks.region_unchanged_score === null
        ? null
        : clamp01(res.checks.region_unchanged_score),
  };
}

function toOutcome(
  img: ImageRow,
  res: PhotoSceneCompositeResult,
  containsPerson: boolean,
  model: string,
): RenderOutcome {
  const checks = toSceneChecks(res);
  if (!res.checks.passes || !res.key) {
    const codes = res.checks.failures.filter((f) => LOCK_CODES.has(f));
    return {
      imageId: img.id,
      ok: false,
      error: MSG.drift(codes.length ? codes : ["design_drift"]),
      checks,
    };
  }
  return {
    imageId: img.id,
    ok: true,
    image: {
      key: res.key,
      widthPx: res.width_px ?? null,
      heightPx: res.height_px ?? null,
      format: res.format === "png" ? "png" : "jpeg",
      checks,
      scene: {
        designLockScore:
          res.checks.design_lock_score === null ? null : clamp01(res.checks.design_lock_score),
        containsSyntheticPerson: containsPerson,
        model,
      },
    },
  };
}
