import type { PhotoSceneKind } from "@invai/contracts";
import { AiOutputError, AiRefusalError } from "../providers/types";

/*
 * Image-generation provider for listing photos phase B (T-27-1, ADR 0023, decision 0022). The
 * provider only ever sees a blank, masked garment base from invai-imaging and a scene prompt built
 * in code (`buildScenePrompt`); the shop's design is composited by imaging afterwards.
 */

/** A scene prompt built only from fixed vocabulary (never the design's text or brand words). */
export type ScenePrompt = {
  /** `scene_prompt@<version>`, stored on ai_jobs like a text prompt's promptRef. */
  ref: string;
  sceneKind: PhotoSceneKind;
  /** Decided from the requested kind (conservative), never from the output (ADR 0023 §3). */
  containsPerson: boolean;
  text: string;
};

/** Requested output size (the preset or base size); the provider picks its nearest aspect. */
export type SizePx = number | { width: number; height: number };

export type GenerateSceneInput = {
  /** PNG from imaging `/photo/scene-base`: the blank garment, no design pixels. */
  baseImage: Buffer;
  /** PNG, same size as the base: alpha 0 = editable, opaque = protected print area. */
  mask: Buffer;
  prompt: ScenePrompt;
  sizePx: SizePx;
};

export type GeneratedScene = {
  /** PNG at one of the provider's output sizes (imaging upscales to the preset). */
  image: Buffer;
  widthPx: number;
  heightPx: number;
  provider: "openai" | "mock";
  model: string;
  /** From the price table in models.ts; 0 for the mock. */
  costCents: number;
  containsPerson: boolean;
};

export type ImageProvider = {
  name: "openai" | "mock";
  model: string;
  /** Price of one scene at this size, before the call (cap checks use it). */
  estimateCents(sizePx: SizePx): number;
  generateScene(input: GenerateSceneInput): Promise<GeneratedScene>;
};

/**
 * A failed image call. Extends the gateway's typed errors so `upstream("OpenAI", …)` mapping
 * applies; `retryable` tells the photos job whether a BullMQ retry can help (timeouts, 429, 5xx)
 * or not (4xx, refusal).
 */
export class ImageGenError extends AiOutputError {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly status: number | null = null,
  ) {
    super(message);
    this.name = "ImageGenError";
  }
}

/** The provider's safety system declined the prompt or image (not retryable). */
export class ImageRefusalError extends AiRefusalError {}
