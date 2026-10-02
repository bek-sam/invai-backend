import type { BlankColor, ContrastWarning } from "@invai/contracts";

/*
 * Deterministic contrast warnings for listing photos (T-26-4 AC2). Computed in code, never by a
 * model: WCAG 2 relative luminance and contrast ratio between the design's dominant opaque
 * colors and a blank. Light art on a light blank or dark art on a dark blank warns, with the
 * ratio, so a shop doesn't list a shirt whose print disappears.
 */

/** WCAG's minimum for graphical objects (1.4.11): below 3:1 the print reads poorly. */
export const MIN_CONTRAST = 3;
/** Palette colors under this share are accents, not what the eye sees first. */
const DOMINANT_MIN_SHARE = 0.05;
const DOMINANT_MAX = 3;
/** Luminance where contrast against black equals contrast against white. */
const LIGHT_LUMINANCE = 0.179;

function channel(v: number): number {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function luminance(hex: string): number {
  const h = hex.replace(/^#/, "");
  const r = Number.parseInt(h.slice(0, 2), 16);
  const g = Number.parseInt(h.slice(2, 4), 16);
  const b = Number.parseInt(h.slice(4, 6), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** The top opaque colors by share, shares renormalized among them. */
export function dominantColors(palette: { hex: string; share: number }[]) {
  const top = palette
    .filter((c) => c.share >= DOMINANT_MIN_SHARE)
    .sort((a, b) => b.share - a.share)
    .slice(0, DOMINANT_MAX);
  const total = top.reduce((s, c) => s + c.share, 0);
  return total > 0 ? top.map((c) => ({ hex: c.hex, share: c.share / total })) : [];
}

/** Share-weighted contrast of the design's dominant colors against one blank. */
export function designContrast(palette: { hex: string; share: number }[], blankHex: string) {
  const top = dominantColors(palette);
  if (top.length === 0) return null;
  return top.reduce((s, c) => s + c.share * contrastRatio(c.hex, blankHex), 0);
}

export function contrastWarnings(
  palette: { hex: string; share: number }[],
  blanks: BlankColor[],
): ContrastWarning[] {
  const out: ContrastWarning[] = [];
  const seen = new Set<string>();
  for (const blank of blanks) {
    const hex = blank.hex.toLowerCase();
    if (seen.has(hex)) continue;
    seen.add(hex);
    const ratio = designContrast(palette, hex);
    if (ratio === null || ratio >= MIN_CONTRAST) continue;
    out.push({
      blank: { name: blank.name, hex },
      ratio: Math.min(21, Math.max(1, Math.round(ratio * 100) / 100)),
      kind: luminance(hex) >= LIGHT_LUMINANCE ? "light_on_light" : "dark_on_dark",
    });
  }
  return out;
}
