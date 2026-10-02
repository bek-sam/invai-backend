import {
  type BlankColor,
  type ContrastWarning,
  PHOTO_CHANNELS,
  type PHOTO_VIEWS,
  type PhotoChannel,
} from "@invai/contracts";
import type { PhotoAnalysisOutput, PhotoAnalysisVars } from "../prompts";

/*
 * Checks for the photo-analysis output (T-26-3). The model's answer is validated here, retried once
 * with the issues, and then repaired deterministically (`repairPhotoAnalysis`), so the stored
 * analysis always meets the contract: `#rrggbb` blanks that contrast with the art, alt text that is
 * plain, at most 250 characters and free of claims, and bounded counts and lengths.
 */

type Palette = PhotoAnalysisVars["palette"];

export const ALT_TEXT_MAX = 250;
export const MAX_RECOMMENDED_COLORS = 8;
export const MAX_SCENES = 8;
/** Art colors whose contrast with the blank is below this "disappear" into the shirt. */
export const LOW_CONTRAST = 2;
/** A blank is a poor pick when this share (or more) of the opaque art has low contrast with it. */
export const POOR_SHARE = 0.5;

const HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * Words a product photo's alt text must not carry: promotions, rankings, guarantees, licensing or
 * eco claims the shop can't back (listing-compliance-check: "no exaggerated claims").
 */
export const BANNED_ALT_CLAIMS =
  /(#\s?1\b|\b(best|number one|no\.? ?1|guarantee[ds]?|guaranteed|premium|official(ly)?|licensed|authentic|genuine|eco[- ]?friendly|organic|sustainable|sale|discount|cheap(est)?|free shipping|limited time|hurry|top[- ]rated|award[- ]winning|never fades?|lasts forever)\b)/iu;
const HASHTAG_OR_URL = /(#\w|https?:\/\/|www\.)/iu;
const EMOJI = /\p{Extended_Pictographic}/u;

/* --------------------------------- contrast --------------------------------- */

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of a `#rrggbb` color, 0..1. */
export function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  return (
    0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
  );
}

/** WCAG contrast ratio, 1..21. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** How a blank sits against the art: share of opaque art with low contrast, and the mean ratio. */
export function blankContrast(palette: Palette, blankHex: string) {
  const colors = palette.colors.filter((c) => HEX.test(c.hex) && c.share > 0);
  const total = colors.reduce((a, c) => a + c.share, 0);
  if (!colors.length || total <= 0) return { lowShare: 0, ratio: 21 };
  let lowShare = 0;
  let ratio = 0;
  for (const c of colors) {
    const r = contrastRatio(c.hex, blankHex);
    const w = c.share / total;
    if (r < LOW_CONTRAST) lowShare += w;
    ratio += w * r;
  }
  return { lowShare, ratio: Math.min(21, Math.max(1, ratio)) };
}

export function isPoorBlank(palette: Palette, blankHex: string): boolean {
  return blankContrast(palette, blankHex).lowShare >= POOR_SHARE;
}

/**
 * Contract `ContrastWarning`s for blanks where most of the art would disappear. Exported for the
 * photos module (T-26-4) to warn about the colors a shop picks itself.
 */
export function contrastWarningsFor(palette: Palette, blanks: BlankColor[]): ContrastWarning[] {
  const out: ContrastWarning[] = [];
  for (const blank of blanks) {
    if (!HEX.test(blank.hex)) continue;
    const { lowShare, ratio } = blankContrast(palette, blank.hex);
    if (lowShare < POOR_SHARE) continue;
    out.push({
      blank: { name: blank.name, hex: blank.hex },
      ratio: Math.round(ratio * 100) / 100,
      kind: luminance(blank.hex) > 0.18 ? "light_on_light" : "dark_on_dark",
    });
  }
  return out;
}

/* ---------------------------------- alt text --------------------------------- */

/** Keyword stuffing: a content word (4+ letters) used 3 or more times, or a comma list of 5+. */
export function isStuffed(text: string): boolean {
  if ((text.match(/,/g) ?? []).length >= 5) return true;
  const counts = new Map<string, number>();
  for (const w of text.toLowerCase().match(/\p{L}{4,}/gu) ?? []) {
    const n = (counts.get(w) ?? 0) + 1;
    if (n >= 3) return true;
    counts.set(w, n);
  }
  return false;
}

export function altTextIssue(text: string): string | null {
  const t = text.trim();
  if (!t) return "is empty";
  if (t.length > ALT_TEXT_MAX) return `is ${t.length} characters (max ${ALT_TEXT_MAX})`;
  if (BANNED_ALT_CLAIMS.test(t)) return "makes a promotional or unbackable claim";
  if (HASHTAG_OR_URL.test(t)) return "contains a hashtag or link";
  if (EMOJI.test(t)) return "contains emoji";
  if (/[<>]/.test(t)) return "contains markup";
  if (isStuffed(t)) return "repeats keywords";
  return null;
}

/* --------------------------------- validation --------------------------------- */

const LIMITS = { style: 300, audience: 300, colorDescription: 300, detectedText: 500 } as const;

/** Every rule the output breaks, as plain lines for the one retry. Empty when it passes. */
export function validatePhotoAnalysis(out: PhotoAnalysisOutput, palette: Palette): string[] {
  const issues: string[] = [];
  for (const [field, max] of Object.entries(LIMITS) as [keyof typeof LIMITS, number][]) {
    const v = out[field];
    if (v != null && v.length > max)
      issues.push(`${field} is ${v.length} characters (max ${max}).`);
  }
  if (!out.style.trim()) issues.push("style is empty.");
  if (out.recommendedColors.length < 1) issues.push("recommendedColors is empty.");
  if (out.recommendedColors.length > MAX_RECOMMENDED_COLORS)
    issues.push(`recommendedColors has ${out.recommendedColors.length} entries (max 8).`);
  const seen = new Set<string>();
  out.recommendedColors.forEach((c, i) => {
    if (!HEX.test(c.hex)) issues.push(`recommendedColors[${i}].hex "${c.hex}" is not #rrggbb.`);
    else {
      if (seen.has(c.hex.toLowerCase())) issues.push(`recommendedColors[${i}] repeats ${c.hex}.`);
      seen.add(c.hex.toLowerCase());
      if (isPoorBlank(palette, c.hex))
        issues.push(
          `recommendedColors[${i}] ${c.name} (${c.hex}) has too little contrast with the art (light on light or dark on dark).`,
        );
    }
    if (!c.name.trim() || c.name.length > 60)
      issues.push(`recommendedColors[${i}].name is empty or over 60 characters.`);
    if (c.reason.length > 200)
      issues.push(`recommendedColors[${i}].reason is over 200 characters.`);
  });
  if (out.sceneSuggestions.length > MAX_SCENES)
    issues.push(`sceneSuggestions has ${out.sceneSuggestions.length} entries (max 8).`);
  out.sceneSuggestions.forEach((s, i) => {
    if (s.description.length > 300)
      issues.push(`sceneSuggestions[${i}].description is over 300 characters.`);
  });
  const altSeen = new Set<PhotoChannel>();
  for (const a of out.altText) {
    if (altSeen.has(a.channel)) issues.push(`altText has two entries for ${a.channel}.`);
    altSeen.add(a.channel);
    const why = altTextIssue(a.text);
    if (why) issues.push(`altText for ${a.channel} ${why}.`);
  }
  for (const o of out.imageOrder) {
    if (!o.views.length) issues.push(`imageOrder for ${o.channel} is empty.`);
    if (new Set(o.views).size !== o.views.length)
      issues.push(`imageOrder for ${o.channel} repeats a view.`);
  }
  return issues;
}

/* ----------------------------------- repair ----------------------------------- */

/** Fallback blanks when the model's picks are all unusable: ordered by contrast with the art. */
export const STANDARD_BLANKS: BlankColor[] = [
  { name: "White", hex: "#ffffff" },
  { name: "Black", hex: "#111111" },
  { name: "Heather Gray", hex: "#9da3a8" },
  { name: "Navy", hex: "#1f2a44" },
  { name: "Natural", hex: "#f3ecd9" },
  { name: "Sand", hex: "#d8c7a3" },
  { name: "Red", hex: "#b3202a" },
  { name: "Royal", hex: "#2453a6" },
  { name: "Forest", hex: "#2e4b33" },
  { name: "Maroon", hex: "#5b1f2b" },
  { name: "Charcoal", hex: "#3a3d42" },
  { name: "Light Blue", hex: "#a9c8e8" },
];

/** Blanks ranked for this art: fewest disappearing colors first, then highest mean contrast. */
export function rankBlanks(palette: Palette, blanks: BlankColor[] = STANDARD_BLANKS) {
  return blanks
    .map((b) => ({ ...b, ...blankContrast(palette, b.hex) }))
    .filter((b) => b.lowShare < POOR_SHARE)
    .sort((a, b) => a.lowShare - b.lowShare || b.ratio - a.ratio || a.name.localeCompare(b.name));
}

function clip(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** A plain alt text built from code-chosen words only: never the (untrusted) design name. */
export function fallbackAltText(style: string, colorName: string): string {
  const s =
    style.trim() && !BANNED_ALT_CLAIMS.test(style) ? clip(style.toLowerCase(), 120) : "graphic";
  return clip(`${colorName} t-shirt with a ${s} design printed on the front`, ALT_TEXT_MAX);
}

const DEFAULT_ORDER: Record<PhotoChannel, (typeof PHOTO_VIEWS)[number][]> = {
  amazon: ["front_flat", "on_model_white", "folded"],
  etsy: ["on_model_white", "front_flat", "folded"],
  shopify: ["front_flat", "on_model_white", "folded"],
  tiktok: ["on_model_white", "front_flat", "folded"],
  walmart: ["front_flat", "on_model_white", "folded"],
};

/**
 * Makes any output meet the rules: drops bad or low-contrast blanks (refilling from the ranked
 * standard blanks), clips lengths, replaces failing alt text with a plain fallback, fills every
 * channel's alt text and image order, and keeps Amazon's main image a flat front view.
 */
export function repairPhotoAnalysis(
  out: PhotoAnalysisOutput,
  palette: Palette,
): PhotoAnalysisOutput {
  const seen = new Set<string>();
  const colors = out.recommendedColors
    .filter((c) => HEX.test(c.hex) && c.name.trim() && !isPoorBlank(palette, c.hex))
    .filter((c) => {
      const k = c.hex.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .map((c) => ({ name: clip(c.name, 60), hex: c.hex, reason: clip(c.reason, 200) }));
  for (const b of rankBlanks(palette)) {
    if (colors.length >= 3) break;
    if (seen.has(b.hex)) continue;
    seen.add(b.hex);
    colors.push({
      name: b.name,
      hex: b.hex,
      reason: "Contrasts well with the main colors of the art.",
    });
  }
  const style = clip(out.style, 300) || "graphic";
  const mainColor = colors[0]?.name ?? "White";
  const alt = new Map(out.altText.map((a) => [a.channel, a.text]));
  const order = new Map(out.imageOrder.map((o) => [o.channel, [...new Set(o.views)]]));
  return {
    style,
    audience: clip(out.audience, 300),
    detectedText:
      out.detectedText == null || !out.detectedText.trim() ? null : clip(out.detectedText, 500),
    colorDescription: clip(out.colorDescription, 300),
    recommendedColors: colors.slice(0, MAX_RECOMMENDED_COLORS),
    sceneSuggestions: out.sceneSuggestions
      .slice(0, MAX_SCENES)
      .map((s) => ({ ...s, description: clip(s.description, 300) })),
    altText: PHOTO_CHANNELS.map((ch) => {
      const t = alt.get(ch);
      return {
        channel: ch,
        text: t != null && !altTextIssue(t) ? t.trim() : fallbackAltText(style, mainColor),
      };
    }),
    imageOrder: PHOTO_CHANNELS.map((ch) => {
      let views = order.get(ch)?.length
        ? (order.get(ch) as typeof DEFAULT_ORDER.amazon)
        : DEFAULT_ORDER[ch];
      if (ch === "amazon" && views[0] !== "front_flat")
        views = ["front_flat", ...views.filter((v) => v !== "front_flat")];
      return { channel: ch, views };
    }),
  };
}
