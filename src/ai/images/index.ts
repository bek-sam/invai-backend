import type { Tx } from "../../db/client";
import { env } from "../../env";
import { isSampleWorkspace } from "../../modules/tenancy/demo-flag";
import { assertImageGenAllowedWith, type ImageGenCheckOptions } from "./caps";
import { mockImageProvider } from "./mock";
import { openAiImageProvider } from "./openai";
import type { ImageProvider } from "./types";

/*
 * Image-generation entry points for the photos module (wave 27 "Agreed interfaces", T-27-1).
 * The mock unless IMAGE_GEN_PROVIDER=openai and OPENAI_API_KEY are both set and the company is
 * not a sample workspace. Tests never get the real provider: env drops AI keys under NODE_ENV=test.
 */

export { IMAGE_JOB_KIND, imagesUsedToday, recordImageGen } from "./caps";
export { mockImageProvider } from "./mock";
export {
  buildScenePrompt,
  PRINT_AREA_RULE,
  SCENE_PROMPT_REF,
  SCENE_RULES,
  sceneContainsPerson,
} from "./scene-prompt";
export { providerSize } from "./sizes";
export * from "./types";

export async function getImageProvider(companyId: string): Promise<ImageProvider> {
  if (env.IMAGE_GEN_PROVIDER !== "openai" || !env.OPENAI_API_KEY) return mockImageProvider;
  return (await isSampleWorkspace(companyId)) ? mockImageProvider : openAiImageProvider;
}

/**
 * Refuses with IMAGE_DAILY_CAP_REACHED, CREDITS_EXHAUSTED or AI_SPEND_CAP_REACHED (in that order)
 * before `count` scenes are generated or enqueued. Run inside the caller's tenant transaction.
 */
export async function assertImageGenAllowed(
  tx: Tx,
  companyId: string,
  count: number,
  opts: ImageGenCheckOptions = {},
): Promise<void> {
  const provider = opts.provider ?? (await getImageProvider(companyId));
  await assertImageGenAllowedWith(tx, companyId, count, provider, opts);
}
