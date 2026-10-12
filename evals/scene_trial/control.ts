import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { type ImageProvider, recordImageGen, type ScenePrompt } from "../../src/ai/images";
import { assertImageGenAllowedWith } from "../../src/ai/images/caps";
import { withSystem, withTenant } from "../../src/db/client";
import { aiJobs } from "../../src/db/schema";
import { imaging } from "../../src/integrations/imaging/client";
import { getObject, putObject } from "../../src/lib/s3";
import { SCENE_SIZE_PX } from "../../src/modules/photos/service";

/*
 * Control call (T-38-2 AC4, B-367, architect A8). One provider call with the scene base and mask
 * of a fresh base, and a fixed prompt that asks the model to change nothing. It shows what the
 * checks score when the provider is as aligned as it can be, a real reference for
 * STRUCTURAL_REG_MAX. Fences: the prompt lives only here (no route can select it) and is fixed
 * text with its own ref; the call goes through assertImageGenAllowedWith and recordImageGen (the
 * ledger and the daily cap see it); it creates no photo_images row and charges no credits; the
 * design is only composited by imaging afterwards, as in a real scene.
 */

export const CONTROL_PROMPT_REF = "scene_control@1";

export const CONTROL_PROMPT: ScenePrompt = {
  ref: CONTROL_PROMPT_REF,
  // An existing kind, for typing only; a person is assumed, never flipped to false (0023 section 3).
  sceneKind: "studio",
  containsPerson: true,
  text: [
    "Return the given image exactly as it is.",
    "Change nothing: do not alter, add, remove, move, resize, recolor or restyle anything in it.",
    "Keep every pixel of the garment, the background and the marked area as given.",
  ].join("\n"),
};

export type ControlScores = {
  passes: boolean;
  failures: string[];
  registration: number | null;
  c1: number | null;
  lock: number | null;
  regionReasons: string[];
  structural: boolean;
};

/** A9: a "change nothing" call that still fails check 1 with registration below the structural line. */
export function controlGate(s: Pick<ControlScores, "failures" | "registration">, regMax = 0.5) {
  const failsCheck1 = s.failures.includes("region_changed");
  const lowReg = s.registration == null || s.registration < regMax;
  return failsCheck1 && lowReg
    ? { stop: true, reason: `control failed check 1 with registration below ${regMax}: stop before trial A` }
    : { stop: false, reason: "control gate passed: trial A may run" };
}

export async function runControl(input: {
  companyId: string;
  userId: string | null;
  provider: ImageProvider;
  design: { fileKey: string; widthIn: number; heightIn: number };
  colorHex: string;
}): Promise<{
  scores: ControlScores;
  cents: number;
  aiJobId: string;
  keys: { base: string; mask: string; scene: string };
}> {
  const { companyId, provider } = input;
  const id = randomUUID();
  const prefix = `${companyId}/photos/control/${id}`;
  const keys = { base: `${prefix}-base.png`, mask: `${prefix}-mask.png`, scene: `${prefix}-a1.png` };

  // A fresh base and mask every run: nothing stored is reused (A10).
  const base = await imaging.photoSceneBase({
    garment: "tee",
    view: "lifestyle_base",
    blank_hex: input.colorHex,
    size_px: SCENE_SIZE_PX,
    out_key: keys.base,
    mask_out_key: keys.mask,
  });
  const [baseImage, mask] = await Promise.all([getObject(base.key), getObject(base.mask_key)]);

  await withTenant(companyId, (tx) =>
    assertImageGenAllowedWith(tx, companyId, 1, provider, { sizePx: SCENE_SIZE_PX }),
  );
  const startedAt = new Date();
  let scene: Awaited<ReturnType<ImageProvider["generateScene"]>>;
  try {
    scene = await provider.generateScene({
      baseImage,
      mask,
      prompt: CONTROL_PROMPT,
      sizePx: SCENE_SIZE_PX,
    });
  } catch (error) {
    await recordImageGen({
      companyId,
      userId: input.userId,
      prompt: CONTROL_PROMPT,
      provider,
      result: null,
      error,
      sizePx: SCENE_SIZE_PX,
      startedAt,
    });
    throw error;
  }
  const { aiJobId } = await recordImageGen({
    companyId,
    userId: input.userId,
    prompt: CONTROL_PROMPT,
    provider,
    result: scene,
    startedAt,
  });
  await putObject(keys.scene, scene.image, "image/png");

  const res = await imaging.photoSceneComposite({
    scene_key: keys.scene,
    base_key: base.key,
    print_box_px: base.print_box_px,
    design_key: input.design.fileKey,
    design_width_in: input.design.widthIn,
    design_height_in: input.design.heightIn,
    placement: "front",
    blank_hex: input.colorHex,
    preset: "shopify",
    out_key: `${prefix}.jpg`,
    xmp_subjects: [],
  });
  const [job] = await withSystem((tx) =>
    tx.select({ cents: aiJobs.costCents }).from(aiJobs).where(eq(aiJobs.id, aiJobId)),
  );
  return {
    scores: {
      passes: res.checks.passes,
      failures: res.checks.failures,
      registration: res.registration?.score ?? null,
      c1: res.checks.region_unchanged_score,
      lock: res.checks.design_lock_score,
      regionReasons: res.checks.region_reasons ?? [],
      structural: res.checks.structural === true,
    },
    cents: job?.cents ?? 0,
    aiJobId,
    keys,
  };
}
