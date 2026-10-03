import { IMAGE_CAP_ERRORS } from "@invai/contracts";
import { ORPCError } from "@orpc/server";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { type Tx, withTenant } from "../../db/client";
import { aiJobs } from "../../db/schema";
import { env } from "../../env";
import { sanitizeText } from "../../lib/text-safety";
import { assertSpendAvailable, recordSpend, spendCaps, spendDay } from "../breaker";
import { assertCredits } from "../credits";
import { PHOTO_SCENE_CREDITS } from "../models";
import type { GeneratedScene, ImageProvider, ScenePrompt, SizePx } from "./types";

/*
 * Caps before every scene call (T-27-1 AC4), in the order a shop can act on them:
 *  1. the per-shop daily image cap (IMAGE_GEN_DAILY_CAP_PER_SHOP, UTC day like breaker.ts),
 *     counted from today's finished `image_scene` ai_jobs rows; mock scenes count too, so the
 *     limit can be seen and tested without spend;
 *  2. AI credits (PHOTO_SCENE_CREDITS per scene, plus credits already promised to open sets);
 *  3. the platform/tenant daily AI spend breaker with this call's estimated cost (real provider
 *     only: the mock never touches money counters).
 * The count is read, not reserved: scenes in flight are not yet rows, so parallel jobs can pass
 * the cap by at most their concurrency; the credit charge guard and the spend breaker still hold.
 */

export const IMAGE_JOB_KIND = "image_scene" as const;

function utcDayBounds(now: Date): { start: Date; end: Date } {
  const start = new Date(`${spendDay(now)}T00:00:00.000Z`);
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

/** Finished scenes for this company today (UTC). Runs inside the caller's tenant transaction. */
export async function imagesUsedToday(tx: Tx, companyId: string, now = new Date()) {
  const { start, end } = utcDayBounds(now);
  const [r] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(aiJobs)
    .where(
      and(
        eq(aiJobs.companyId, companyId),
        eq(aiJobs.kind, IMAGE_JOB_KIND),
        eq(aiJobs.status, "done"),
        gte(aiJobs.createdAt, start),
        lt(aiJobs.createdAt, end),
      ),
    );
  return r?.n ?? 0;
}

export function imageCapReached(cap: number, used: number, now: Date) {
  const def = IMAGE_CAP_ERRORS.IMAGE_DAILY_CAP_REACHED;
  return new ORPCError("IMAGE_DAILY_CAP_REACHED", {
    status: def.status,
    message: def.message,
    data: { cap, used, resetAt: utcDayBounds(now).end.toISOString() },
  });
}

export type ImageGenCheckOptions = {
  /** Credits already promised to open sets (S-51), counted against the balance too. */
  heldCredits?: number;
  /** The provider the scenes will use (else the company's, from getImageProvider). */
  provider?: ImageProvider;
  /** Requested size, for the spend estimate. */
  sizePx?: SizePx;
  now?: Date;
};

export async function assertImageGenAllowedWith(
  tx: Tx,
  companyId: string,
  count: number,
  provider: ImageProvider,
  opts: ImageGenCheckOptions = {},
): Promise<void> {
  if (!Number.isInteger(count) || count < 1)
    throw new Error("image count must be a positive integer");
  const now = opts.now ?? new Date();
  const cap = env.IMAGE_GEN_DAILY_CAP_PER_SHOP;
  const used = await imagesUsedToday(tx, companyId, now);
  if (used + count > cap) throw imageCapReached(cap, used, now);
  await assertCredits(
    tx,
    companyId,
    count * PHOTO_SCENE_CREDITS + Math.max(0, opts.heldCredits ?? 0),
  );
  if (provider.name !== "mock") {
    const estimate = count * provider.estimateCents(opts.sizePx ?? 1024);
    await assertSpendAvailable(companyId, now, spendCaps(), estimate);
  }
}

/**
 * One ai_jobs row per provider call (done or failed), then the real cost onto the spend counters
 * after the commit. Credits are not charged here: the photos module charges PHOTO_SCENE_CREDITS
 * once per approved-able scene with its own guard (ADR 0023 §5), so `credits` stays 0 on the row.
 */
export async function recordImageGen(input: {
  companyId: string;
  userId: string | null;
  prompt: ScenePrompt;
  provider: ImageProvider;
  /** The scene, or null when the call failed (then `error` says why; cost 0, not counted). */
  result: GeneratedScene | null;
  error?: unknown;
  entity?: { type: string; id: string } | null;
  startedAt?: Date;
}): Promise<{ aiJobId: string }> {
  const r = input.result;
  const costCents = r && r.provider !== "mock" ? Math.max(0, Math.round(r.costCents)) : 0;
  const finishedAt = new Date();
  const id = await withTenant(input.companyId, async (tx) => {
    const [row] = await tx
      .insert(aiJobs)
      .values({
        companyId: input.companyId,
        kind: IMAGE_JOB_KIND,
        status: r ? "done" : "failed",
        provider: input.provider.name,
        model: r?.model ?? input.provider.model,
        input: {
          prompt: input.prompt.ref,
          sceneKind: input.prompt.sceneKind,
          containsPerson: input.prompt.containsPerson,
          // Fixed vocabulary only (scene-prompt.ts): safe to keep for traces.
          text: input.prompt.text,
        },
        output: r
          ? { widthPx: r.widthPx, heightPx: r.heightPx, containsPerson: r.containsPerson }
          : {},
        costCents,
        credits: 0,
        stopReason: r ? "end_turn" : null,
        error: r
          ? null
          : sanitizeText(String((input.error as Error)?.message ?? input.error ?? "failed")).slice(
              0,
              500,
            ),
        entityType: input.entity?.type ?? null,
        entityId: input.entity?.id ?? null,
        createdBy: input.userId,
        startedAt: input.startedAt ?? finishedAt,
        finishedAt,
      })
      .returning({ id: aiJobs.id });
    if (!row) throw new Error("ai_jobs insert failed");
    return row.id;
  });
  await recordSpend(input.companyId, costCents);
  return { aiJobId: id };
}
