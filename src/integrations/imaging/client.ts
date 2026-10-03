import { deflateSync } from "node:zlib";
import { z } from "zod";
import { env } from "../../env";
import { logger } from "../../lib/log";
import { isPermanentHttpStatus } from "../../lib/queues";
import { putObject } from "../../lib/s3";

const log = logger("imaging");

/**
 * Typed HTTP client for invai-imaging (v1-plan section 5.1). All file references are S3 keys in
 * S3_BUCKET; imaging reads and writes S3 itself. Units are inches unless named `_px`.
 * Errors: `ImagingError` with the upstream status and `detail`.
 */

export class ImagingError extends Error {
  constructor(
    public readonly endpoint: string,
    public readonly status: number,
    public readonly detail: string,
  ) {
    super(`imaging ${endpoint} failed (${status}): ${detail}`);
  }
}

const Health = z.object({ ok: z.boolean(), vips_version: z.string().optional() });

const QaIssue = z.object({
  code: z.string(),
  severity: z.enum(["error", "warn"]),
  message: z.string(),
});
const QaCheckResult = z.object({
  width_px: z.number(),
  height_px: z.number(),
  has_alpha: z.boolean(),
  soft_alpha_ratio: z.number(),
  effective_dpi: z.number().nullable().optional(),
  issues: z.array(QaIssue),
});
export type QaCheckResult = z.infer<typeof QaCheckResult>;

const KeyResult = z.object({ key: z.string() });

const PreviewResult = z.object({
  out_key: z.string(),
  width_px: z.number(),
  height_px: z.number(),
});
export type PreviewResult = z.infer<typeof PreviewResult>;

/*
 * T-P1-4 (B-209): `preview` never fails the caller. When imaging can't be reached (T-23-5-style
 * degrade, but a thumbnail is low enough stakes to synthesize instead of leaving pending), it
 * writes a small flat-gray placeholder PNG to `out_key` itself and returns that. Built by hand
 * with `node:zlib` (no image library on the backend side): PNG signature + IHDR/IDAT/IEND
 * chunks, 8-bit RGB, one filter-0 scanline per row.
 */
const PLACEHOLDER_PREVIEW_PX = 64;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** A flat gray `size`x`size` 8-bit RGB PNG: valid image bytes, never upstream pixels. */
export function placeholderPreviewPng(size: number = PLACEHOLDER_PREVIEW_PX): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor (RGB)
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, 0xc8)]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

export const TemplateSlot = z.object({
  name: z.string(),
  kind: z.enum(["text", "photo"]),
  x_in: z.number(),
  y_in: z.number(),
  w_in: z.number(),
  h_in: z.number(),
  font_family: z.string(),
  font_size_pt: z.number(),
  min_font_size_pt: z.number().nullable().optional(),
  max_lines: z.number().int().nullable().optional(),
  stroke_width_pt: z.number().optional(),
  stroke_color: z.string().nullable().optional(),
  fit: z.enum(["fit", "fill"]).optional(),
  color: z.string(),
  align: z.enum(["left", "center", "right"]),
  max_chars: z.number().optional(),
  uppercase: z.boolean().optional(),
});
export const RenderTemplate = z.object({
  width_in: z.number(),
  height_in: z.number(),
  background_key: z.string().optional(),
  slots: z.array(TemplateSlot),
});
const RenderResult = z.object({
  key: z.string(),
  width_px: z.number(),
  height_px: z.number(),
  flags: z.array(
    z.object({
      slot: z.string(),
      code: z.enum([
        "overflow",
        "empty",
        "too_long",
        "suspicious_chars",
        "missing_glyphs",
        "low_res_photo",
      ]),
      message: z.string(),
    }),
  ),
});
export type RenderResult = z.infer<typeof RenderResult>;

export const NestItem = z.object({
  id: z.string(),
  width_in: z.number(),
  height_in: z.number(),
  quantity: z.number().int().positive().optional(),
});
const NestResult = z.object({
  sheets: z.array(
    z.object({
      index: z.number(),
      length_in: z.number(),
      utilization: z.number(),
      placements: z.array(
        z.object({
          id: z.string(),
          copy: z.number(),
          x_in: z.number(),
          y_in: z.number(),
          width_in: z.number(),
          height_in: z.number(),
          rotated: z.boolean(),
        }),
      ),
    }),
  ),
});
export type NestResult = z.infer<typeof NestResult>;

export const ComposePlacement = z.object({
  transfer_id: z.string(),
  file_key: z.string(),
  x_in: z.number(),
  y_in: z.number(),
  width_in: z.number(),
  height_in: z.number(),
  rotated: z.boolean(),
  label: z.object({
    order_no: z.string(),
    item_no: z.string(),
    size: z.string(),
    color: z.string(),
    design: z.string(),
    reprint: z.boolean(),
  }),
});
const ComposeResult = z.object({
  key: z.string(),
  pdf_key: z.string().nullable().optional(),
  preview_key: z.string(),
  width_px: z.number(),
  height_px: z.number(),
  bytes: z.number(),
});
export type ComposeResult = z.infer<typeof ComposeResult>;

/* ---- Listing photos (T-26-2 routes, consumed by modules/photos, ADR 0023) ---------------- */

export const PhotoPaletteResult = z.object({
  colors: z.array(z.object({ hex: z.string(), share: z.number() })),
  light_share: z.number(),
  dark_share: z.number(),
  transparent_share: z.number(),
});
export type PhotoPaletteResult = z.infer<typeof PhotoPaletteResult>;

const PrintArea = z.object({ w_in: z.number(), h_in: z.number() });
export const PhotoTemplate = z.object({
  garment: z.string(),
  view: z.string(),
  placement: z.string().optional(),
  print_areas: z.object({ front: PrintArea.optional(), back: PrintArea.optional() }),
  drawn: z.boolean(),
});
export type PhotoTemplate = z.infer<typeof PhotoTemplate>;

export const PhotoRenderResult = z.object({
  key: z.string(),
  width_px: z.number().int(),
  height_px: z.number().int(),
  format: z.string(),
  print_box_px: z.array(z.number()),
  checks: z.object({
    passes: z.boolean(),
    failures: z.array(z.string()),
    background_pure_white: z.boolean().nullable(),
    fill_ratio: z.number().nullable(),
    longest_side_px: z.number().int().nullable(),
  }),
});
export type PhotoRenderResult = z.infer<typeof PhotoRenderResult>;

export const PhotoZipResult = z.object({ key: z.string(), bytes: z.number().int() });

/* ---- Listing photos phase B (T-27-2 routes, consumed by modules/photos, T-27-3) ---------- */

const PrintBoxPx = z.array(z.number().int()).length(4);

export const PhotoSceneBaseResult = z.object({
  key: z.string(),
  mask_key: z.string(),
  print_box_px: PrintBoxPx,
  width_px: z.number().int().optional(),
  height_px: z.number().int().optional(),
});
export type PhotoSceneBaseResult = z.infer<typeof PhotoSceneBaseResult>;

/** `key` is null when a design-lock check failed: imaging writes nothing then. */
export const PhotoSceneCompositeResult = z.object({
  key: z.string().nullable(),
  checks: z.object({
    passes: z.boolean(),
    failures: z.array(z.string()),
    region_unchanged_score: z.number().nullable(),
    design_lock_score: z.number().nullable(),
  }),
  width_px: z.number().int().nullable().optional(),
  height_px: z.number().int().nullable().optional(),
  format: z.string().nullable().optional(),
});
export type PhotoSceneCompositeResult = z.infer<typeof PhotoSceneCompositeResult>;

export type ImagingClient = ReturnType<typeof createImagingClient>;

/** Imaging answers 429 + Retry-After when its heavy-job slots are full (T-9-5, B-19). */
export const IMAGING_BUSY_RETRIES = 5;
const MAX_RETRY_WAIT_MS = 30_000;
const DEFAULT_RETRY_WAIT_MS = 2_000;

/** Retry-After as delay-seconds or an HTTP date, clamped to 0.1–30 s. */
export function retryAfterMs(header: string | null, now = Date.now()): number {
  let ms = DEFAULT_RETRY_WAIT_MS;
  if (header?.trim()) {
    const secs = Number(header);
    const date = Date.parse(header);
    if (Number.isFinite(secs)) ms = secs * 1000;
    else if (Number.isFinite(date)) ms = date - now;
  }
  return Math.min(MAX_RETRY_WAIT_MS, Math.max(100, ms));
}

export function createImagingClient(
  baseUrl = env.IMAGING_URL,
  timeoutMs = 120_000,
  secret = env.IMAGING_SHARED_SECRET,
  sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
) {
  async function call<T>(
    endpoint: string,
    body: unknown,
    schema: z.ZodType<T>,
    init: { method?: "GET" | "POST"; timeoutMs?: number } = {},
  ): Promise<T> {
    const method = init.method ?? "POST";
    const headers: Record<string, string> = {};
    if (method === "POST") headers["content-type"] = "application/json";
    if (secret) headers["x-imaging-secret"] = secret;
    let res: Response;
    // A 429 is sent before imaging does any work, so retrying it is always safe.
    for (let attempt = 0; ; attempt++) {
      res = await fetch(`${baseUrl}${endpoint}`, {
        method,
        headers,
        body: method === "POST" ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(init.timeoutMs ?? timeoutMs),
      }).catch((err) => {
        throw new ImagingError(endpoint, 0, err instanceof Error ? err.message : String(err));
      });
      if (res.status !== 429 || attempt >= IMAGING_BUSY_RETRIES) break;
      const waitMs = retryAfterMs(res.headers.get("retry-after"));
      log.warn("imaging busy, retrying", { endpoint, attempt: attempt + 1, waitMs });
      await res.body?.cancel();
      await sleep(waitMs);
    }
    const text = await res.text();
    if (!res.ok) {
      let detail = text;
      try {
        detail = JSON.stringify((JSON.parse(text) as { detail?: unknown }).detail ?? text);
      } catch {}
      throw new ImagingError(endpoint, res.status, detail);
    }
    const parsed = schema.safeParse(JSON.parse(text));
    if (!parsed.success) {
      log.warn("unexpected imaging response", { endpoint, issues: parsed.error.issues });
      throw new ImagingError(endpoint, res.status, "unexpected response shape");
    }
    return parsed.data;
  }

  async function checkHealthy(): Promise<boolean> {
    try {
      return (await call("/health", undefined, Health, { method: "GET", timeoutMs: 2_000 })).ok;
    } catch {
      return false;
    }
  }

  return {
    baseUrl,
    health: () => call("/health", undefined, Health, { method: "GET", timeoutMs: 3_000 }),
    isUp: checkHealthy,

    qaCheck: (input: { file_key: string; target_width_in?: number; target_height_in?: number }) =>
      call("/qa/check", input, QaCheckResult),

    cleanAlpha: (input: { file_key: string; out_key: string; threshold?: number }) =>
      call("/qa/clean-alpha", input, KeyResult),

    /**
     * A thumbnail for `out_key`, longest side at most `max_px` (imaging default 512).
     *
     * T-P2-2 round 2 (B-233, `reviews/T-P2-2-reviewer-r1.md` finding 1): the placeholder below
     * ran whenever `/health` also failed, which is true both for "imaging isn't configured
     * locally" and for "imaging is genuinely down" (a restart, saturation, an outage) — those two
     * cases can't be told apart from here. The tech lead's ruling: a job must never save a
     * placeholder for a real failure, because nothing re-renders it afterward (only another
     * design edit triggers the job again), leaving a stale gray square in place indefinitely.
     * `allowPlaceholder: false` (the render job's choice, `catalog/service.ts`) skips the
     * fallback below entirely and rethrows every non-permanent failure, so the job sees a normal
     * error and the queue's existing retry/backoff applies; after the final attempt
     * `preview_key` stays null and the UI shows its no-image box. `allowPlaceholder` defaults to
     * `true`, unchanged for direct callers like the seed, which still want a thumbnail rather
     * than nothing when run against a machine with no imaging service at all. A bad-input
     * rejection (4xx/422) is permanent either way and always rethrows, never a placeholder.
     */
    preview: async (input: {
      file_key: string;
      out_key: string;
      max_px?: number;
      allowPlaceholder?: boolean;
    }): Promise<PreviewResult> => {
      const { allowPlaceholder = true, ...body } = input;
      try {
        return await call("/preview", body, PreviewResult);
      } catch (err) {
        if (err instanceof ImagingError && isPermanentHttpStatus(err.status)) throw err;
        if (!allowPlaceholder) throw err;
        if (await checkHealthy()) throw err;
        log.warn("imaging unreachable, writing a placeholder thumbnail", {
          outKey: input.out_key,
          error: err instanceof Error ? err.message : String(err),
        });
        const png = placeholderPreviewPng();
        await putObject(input.out_key, png, "image/png");
        return {
          out_key: input.out_key,
          width_px: PLACEHOLDER_PREVIEW_PX,
          height_px: PLACEHOLDER_PREVIEW_PX,
        };
      }
    },

    renderPersonalization: (input: {
      template: z.infer<typeof RenderTemplate>;
      values: Record<string, string>;
      out_key: string;
      dpi?: number;
    }) => call("/render/personalization", input, RenderResult),

    nest: (input: {
      items: z.infer<typeof NestItem>[];
      sheet_width_in?: number;
      spacing_in?: number;
      margin_in?: number;
      max_length_in?: number;
      allow_rotation?: boolean;
      label_height_in?: number;
      header_height_in?: number;
    }) => call("/nest", input, NestResult),

    compose: (input: {
      width_in: number;
      length_in: number;
      dpi?: number;
      placements: z.infer<typeof ComposePlacement>[];
      out_key: string;
      pdf_key?: string;
      preview_key: string;
      preview_width_px?: number;
      label_gap_in?: number;
      filename_hint?: string;
      sheet_id?: string;
      header_height_in?: number;
    }) => call("/compose", input, ComposeResult, { timeoutMs: 600_000 }),

    mockup: (input: {
      design_key: string;
      blank_color_hex: string;
      placement: "front" | "back";
      out_key: string;
      size_px?: number;
    }) => call("/mockup", input, KeyResult),

    mockLabel: (input: {
      shipment_id: string;
      carrier: string;
      service: string;
      tracking_code: string;
      from: { name: string; city: string; state: string; zip: string };
      to: { name: string; city: string; state: string; zip: string };
      weight_oz: number;
      out_key: string;
    }) => call("/labels/mock", input, KeyResult),

    sampleArt: (input: {
      text: string;
      out_key: string;
      width_in: number;
      height_in: number;
      dpi?: number;
      color_hex: string;
    }) => call("/sample-art", input, KeyResult),

    photoPalette: (input: { design_key: string }) =>
      call("/photo/palette", input, PhotoPaletteResult, { timeoutMs: 60_000 }),

    photoTemplates: () =>
      call("/photo/templates", undefined, z.array(PhotoTemplate), {
        method: "GET",
        timeoutMs: 10_000,
      }),

    photoRender: (input: {
      design_key: string;
      design_width_in: number;
      design_height_in: number;
      placement: "front" | "back";
      garment: string;
      view: string;
      blank_hex: string;
      underbase_preview: boolean;
      preset: string;
      out_key: string;
      xmp_subjects: string[];
    }) => call("/photo/render", input, PhotoRenderResult, { timeoutMs: 120_000 }),

    photoZip: (input: { items: { key: string; name: string }[]; out_key: string }) =>
      call("/photo/zip", input, PhotoZipResult, { timeoutMs: 300_000 }),

    photoSceneBase: (input: {
      garment: string;
      view: "on_model_white" | "lifestyle_base";
      blank_hex: string;
      size_px: number | [number, number];
      out_key: string;
      mask_out_key: string;
    }) => call("/photo/scene-base", input, PhotoSceneBaseResult, { timeoutMs: 60_000 }),

    photoSceneComposite: (input: {
      scene_key: string;
      base_key: string;
      print_box_px: number[];
      design_key: string;
      design_width_in: number;
      design_height_in: number;
      placement: "front";
      blank_hex: string;
      preset: string;
      out_key: string;
      xmp_subjects: string[];
      underbase_preview?: boolean;
    }) => call("/photo/scene-composite", input, PhotoSceneCompositeResult, { timeoutMs: 120_000 }),
  };
}

export const imaging = createImagingClient();
