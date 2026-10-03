import type { DesignPhotoAnalysis, GarmentType, PhotoSceneKind } from "@invai/contracts";
import type { Tx } from "../../db/client";
import type { GeneratedScene, ImageProvider, ScenePrompt } from "./types";

/*
 * Stubs for T-27-3 to build against (wave 27 "Agreed interfaces"); filled in by T-27-1.
 */

export * from "./types";

export async function getImageProvider(_companyId: string): Promise<ImageProvider> {
  throw new Error("getImageProvider: not implemented yet (T-27-1)");
}

export async function assertImageGenAllowed(
  _tx: Tx,
  _companyId: string,
  _count: number,
  _opts: { heldCredits?: number; provider?: ImageProvider } = {},
): Promise<void> {
  throw new Error("assertImageGenAllowed: not implemented yet (T-27-1)");
}

export async function recordImageGen(_input: {
  companyId: string;
  userId: string | null;
  prompt: ScenePrompt;
  result: GeneratedScene | null;
  provider: ImageProvider;
  entity?: { type: string; id: string } | null;
  error?: unknown;
  latencyMs?: number;
}): Promise<{ aiJobId: string }> {
  throw new Error("recordImageGen: not implemented yet (T-27-1)");
}

export function buildScenePrompt(
  _analysis: DesignPhotoAnalysis | null,
  _sceneKind: PhotoSceneKind,
  _garment: GarmentType,
  _blankName: string,
): ScenePrompt {
  throw new Error("buildScenePrompt: not implemented yet (T-27-1)");
}
