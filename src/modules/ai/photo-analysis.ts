import { DesignPhotoAnalysis, type PhotoChannel } from "@invai/contracts";
import { runStructured } from "../../ai/gateway";
import { MOCK_MODEL } from "../../ai/models";
import {
  type PhotoAnalysisOutput,
  type PhotoAnalysisVars,
  photoAnalysisPrompt,
} from "../../ai/prompts";
import { type ImageInput, MAX_IMAGE_BYTES } from "../../ai/providers/types";
import {
  contrastWarningsFor,
  repairPhotoAnalysis,
  validatePhotoAnalysis,
} from "../../ai/validators/photo-analysis";
import { logger } from "../../lib/log";
import { getObject, isCompanyKey } from "../../lib/s3";

const log = logger("ai.photos");
const HEX = /^#[0-9a-fA-F]{6}$/;

export type AnalyzeDesignForPhotosInput = {
  designId: string;
  /** `designs.previewKey`: the small preview, never the print file. */
  previewKey: string | null;
  /** From imaging `/photo/palette` (T-26-4), shares 0..1. */
  palette: PhotoAnalysisVars["palette"];
  designName: string;
  tags: string[];
};

/** Sniffs the preview's real type from its first bytes; anything else is not sent. */
export function imageMediaType(buf: Buffer): ImageInput["mediaType"] | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (
    buf.length >= 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  )
    return "image/webp";
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.toString("ascii", 0, 6))) return "image/gif";
  return null;
}

/** Test seam: the preview loader (S3 by default). */
let loadPreview: (key: string) => Promise<Buffer> = getObject;
export function setPreviewLoader(fn: typeof loadPreview | null) {
  loadPreview = fn ?? getObject;
}

/**
 * The design's small preview as a vision input, or none. Only a key under this company's prefix
 * is read (never the print file: the caller passes `designs.previewKey`); a missing, oversized or
 * unknown-format preview means a text-only analysis, not a failure.
 */
export async function previewImage(companyId: string, key: string | null): Promise<ImageInput[]> {
  if (!key) return [];
  if (!isCompanyKey(companyId, key)) {
    log.warn("preview key outside the company prefix; analyzing without the image", { companyId });
    return [];
  }
  try {
    const buf = await loadPreview(key);
    const mediaType = imageMediaType(buf);
    if (!mediaType || buf.length > MAX_IMAGE_BYTES) {
      log.warn("preview not sendable; analyzing without the image", {
        companyId,
        bytes: buf.length,
        mediaType,
      });
      return [];
    }
    return [{ mediaType, data: buf.toString("base64") }];
  } catch (err) {
    log.warn("preview could not be read; analyzing without the image", {
      companyId,
      error: (err as Error).message,
    });
    return [];
  }
}

function toRecord<T>(
  list: { channel: PhotoChannel; value: T }[],
): Partial<Record<PhotoChannel, T>> {
  return Object.fromEntries(list.map((x) => [x.channel, x.value])) as Partial<
    Record<PhotoChannel, T>
  >;
}

/**
 * Design analysis for listing photos (T-26-3, ADR 0023). Runs inside a job on the `ai` queue and
 * holds no transaction across the model call: the gateway opens its own short ones (credits check,
 * ai_jobs row, charge). One vision call, validated in code; on issues one retry with them attached,
 * then a deterministic repair, so the result always meets the contract. Credits: the gateway's
 * token-based charge under `photo_image`, ledger ref = the design (a refresh charges again).
 */
export async function analyzeDesignForPhotos(
  companyId: string,
  userId: string | null,
  input: AnalyzeDesignForPhotosInput,
): Promise<DesignPhotoAnalysis> {
  const images = await previewImage(companyId, input.previewKey);
  const vars: PhotoAnalysisVars = {
    designName: input.designName,
    tags: input.tags,
    palette: input.palette,
    hasImage: images.length > 0,
    fixErrors: null,
  };
  const meta = {
    companyId,
    userId,
    kind: "photo_analysis" as const,
    creditKind: "photo_image" as const,
    entity: { type: "design", id: input.designId },
  };
  let res = await runStructured(meta, photoAnalysisPrompt, vars, images);
  let credits = res.credits;
  let output: PhotoAnalysisOutput = res.output;
  const issues = validatePhotoAnalysis(output, input.palette);
  if (issues.length) {
    res = await runStructured(
      meta,
      photoAnalysisPrompt,
      { ...vars, fixErrors: issues.map((i) => `- ${i}`).join("\n") },
      images,
    );
    credits += res.credits;
    output = res.output;
  }
  const fixed = repairPhotoAnalysis(output, input.palette);
  const mock = res.model === MOCK_MODEL;
  return DesignPhotoAnalysis.parse({
    designId: input.designId,
    source: mock ? "mock" : "model",
    model: mock ? null : res.model,
    palette: input.palette.colors.filter((c) => HEX.test(c.hex)).slice(0, 6),
    lightShare: input.palette.lightShare,
    darkShare: input.palette.darkShare,
    transparentShare: input.palette.transparentShare,
    style: fixed.style,
    audience: fixed.audience,
    detectedText: fixed.detectedText,
    colorDescription: fixed.colorDescription,
    recommendedColors: fixed.recommendedColors,
    contrastWarnings: contrastWarningsFor(input.palette, fixed.recommendedColors),
    sceneSuggestions: fixed.sceneSuggestions,
    altText: toRecord(fixed.altText.map((a) => ({ channel: a.channel, value: a.text }))),
    imageOrder: toRecord(fixed.imageOrder.map((o) => ({ channel: o.channel, value: o.views }))),
    creditsUsed: credits,
    analyzedAt: new Date().toISOString(),
  } satisfies DesignPhotoAnalysis);
}
