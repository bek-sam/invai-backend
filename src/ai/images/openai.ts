import OpenAI, { APIConnectionTimeoutError, APIError, toFile } from "openai";
import type { ImageEditParamsNonStreaming, ImagesResponse } from "openai/resources/images";
import { env } from "../../env";
import { logger } from "../../lib/log";
import { imageCostCents, OPENAI_IMAGE_MODEL, OPENAI_IMAGE_QUALITY } from "../models";
import { isPng, pngSize } from "./png";
import { providerSize } from "./sizes";
import { type GeneratedScene, ImageGenError, type ImageProvider, ImageRefusalError } from "./types";

/*
 * OpenAI image provider (T-27-1 AC2), used only when the owner sets IMAGE_GEN_PROVIDER=openai and
 * OPENAI_API_KEY (getImageProvider). Images API edit endpoint: the blank garment base and the mask
 * (alpha 0 = editable, print area opaque), the scene prompt, `n: 1`, a fixed size and quality.
 * OpenAI documents GPT Image masks as prompt guidance only ("may not follow its exact shape"),
 * so the print area is restored and checked by invai-imaging afterwards (ADR 0023 §2).
 * Nothing about the buyer or the shop is sent: no `user` field, no design pixels, no names.
 * `input_fidelity` is not sent: gpt-image-2 ignores it and always reads inputs at high fidelity.
 * At most one retry, and only on a 5xx; timeouts are not retried here (the call may be billed).
 */

const log = logger("ai.images.openai");

/** The edit call usually takes 20-60 s at medium quality; the photos job's lock must exceed this. */
export const IMAGE_TIMEOUT_MS = 120_000;

let defaultClient: OpenAI | null = null;
function client(): OpenAI {
  // Only env's resolved key builds a client (the SDK would otherwise read process.env, S-49).
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) throw new ImageGenError("OPENAI_API_KEY is not configured", false);
  defaultClient ??= new OpenAI({ apiKey, maxRetries: 0, timeout: IMAGE_TIMEOUT_MS });
  return defaultClient;
}

/** 400s the safety system raises (moderation_blocked and older content-policy codes). */
const REFUSAL_CODE = /moderation|content_policy|safety/i;

function mapError(err: unknown): Error {
  if (err instanceof ImageGenError || err instanceof ImageRefusalError) return err;
  if (err instanceof APIConnectionTimeoutError) {
    return new ImageGenError("OpenAI image request timed out", false, null, true);
  }
  if (err instanceof APIError) {
    const status = typeof err.status === "number" ? err.status : null;
    if (status === 400 && REFUSAL_CODE.test(`${err.code ?? ""} ${err.message}`)) {
      return new ImageRefusalError(err.code ?? "moderation_blocked");
    }
    if (status === 429) return new ImageGenError("OpenAI image rate limit reached", true, 429);
    if (status !== null && status >= 500) {
      return new ImageGenError(`OpenAI image service error (${status})`, false, status, true);
    }
    return new ImageGenError(
      `OpenAI rejected the image request (${status ?? "no status"})`,
      false,
      status,
    );
  }
  return new ImageGenError(
    `OpenAI image request failed: ${(err as Error).message}`,
    false,
    null,
    true,
  );
}

function isRetryable5xx(err: unknown): boolean {
  return err instanceof APIError && typeof err.status === "number" && err.status >= 500;
}

export function createOpenAiImageProvider(getClient: () => OpenAI = client): ImageProvider {
  const model = OPENAI_IMAGE_MODEL;
  return {
    name: "openai",
    model,
    estimateCents: (sizePx) => imageCostCents(model, providerSize(sizePx).name),
    async generateScene(input): Promise<GeneratedScene> {
      const size = providerSize(input.sizePx);
      if (!isPng(input.baseImage) || !isPng(input.mask)) {
        throw new ImageGenError("base and mask must be PNG images", false);
      }
      const params: ImageEditParamsNonStreaming = {
        model,
        image: await toFile(input.baseImage, "base.png", { type: "image/png" }),
        mask: await toFile(input.mask, "mask.png", { type: "image/png" }),
        prompt: input.prompt.text,
        n: 1,
        size: size.name,
        quality: OPENAI_IMAGE_QUALITY,
        output_format: "png",
        background: "opaque",
      };
      let res: ImagesResponse;
      try {
        res = await getClient().images.edit(params);
      } catch (err) {
        if (!isRetryable5xx(err)) throw mapError(err);
        log.warn("image edit 5xx, retrying once", { status: (err as APIError).status });
        try {
          // Files are streams: build them again for the retry.
          res = await getClient().images.edit({
            ...params,
            image: await toFile(input.baseImage, "base.png", { type: "image/png" }),
            mask: await toFile(input.mask, "mask.png", { type: "image/png" }),
          });
        } catch (err2) {
          throw mapError(err2);
        }
      }
      const b64 = res.data?.[0]?.b64_json;
      if (!b64) throw new ImageGenError("OpenAI returned no image", false, null, true);
      const image = Buffer.from(b64, "base64");
      if (!isPng(image))
        throw new ImageGenError("OpenAI returned an image that is not a PNG", false, null, true);
      const dims = pngSize(image);
      return {
        image,
        widthPx: dims.width,
        heightPx: dims.height,
        provider: "openai",
        model,
        costCents: imageCostCents(model, size.name),
        containsPerson: input.prompt.containsPerson,
      };
    },
  };
}

export const openAiImageProvider = createOpenAiImageProvider();
