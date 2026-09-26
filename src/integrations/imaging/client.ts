import { z } from "zod";
import { env } from "../../env";
import { logger } from "../../lib/log";

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

export const TemplateSlot = z.object({
  name: z.string(),
  kind: z.literal("text"),
  x_in: z.number(),
  y_in: z.number(),
  w_in: z.number(),
  h_in: z.number(),
  font_family: z.string(),
  font_size_pt: z.number(),
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
      code: z.enum(["overflow", "empty", "too_long", "suspicious_chars"]),
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

export type ImagingClient = ReturnType<typeof createImagingClient>;

export function createImagingClient(baseUrl = env.IMAGING_URL, timeoutMs = 120_000) {
  async function call<T>(
    endpoint: string,
    body: unknown,
    schema: z.ZodType<T>,
    init: { method?: "GET" | "POST"; timeoutMs?: number } = {},
  ): Promise<T> {
    const method = init.method ?? "POST";
    const res = await fetch(`${baseUrl}${endpoint}`, {
      method,
      headers: method === "POST" ? { "content-type": "application/json" } : undefined,
      body: method === "POST" ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(init.timeoutMs ?? timeoutMs),
    }).catch((err) => {
      throw new ImagingError(endpoint, 0, err instanceof Error ? err.message : String(err));
    });
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

  return {
    baseUrl,
    health: () => call("/health", undefined, Health, { method: "GET", timeoutMs: 3_000 }),
    isUp: async () => {
      try {
        return (await call("/health", undefined, Health, { method: "GET", timeoutMs: 2_000 })).ok;
      } catch {
        return false;
      }
    },

    qaCheck: (input: { file_key: string; target_width_in?: number; target_height_in?: number }) =>
      call("/qa/check", input, QaCheckResult),

    cleanAlpha: (input: { file_key: string; out_key: string; threshold?: number }) =>
      call("/qa/clean-alpha", input, KeyResult),

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
  };
}

export const imaging = createImagingClient();
