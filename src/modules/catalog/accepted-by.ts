const MAX_UNITS = 200;
const FALLBACK = "A teammate";
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Display name for `acceptedBy` (contract cap: 200 UTF-16 units). Cuts on a whole character
 * (grapheme) so an emoji, flag or base+mark at the cut is kept or dropped whole. A lone surrogate
 * would make Postgres jsonb refuse the write, which would fail the accept and then the designs list.
 */
export function acceptedByName(name: string | null | undefined): string {
  const s = (name ?? "").replace(LONE_SURROGATE, "\uFFFD").trim();
  let out = "";
  for (const { segment } of segmenter.segment(s)) {
    if (out.length + segment.length > MAX_UNITS) break;
    out += segment;
  }
  if (!out && s) {
    // One grapheme longer than the cap: cut by code point, never leave a dangling high surrogate.
    out = s.slice(0, MAX_UNITS);
    const last = out.charCodeAt(out.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  }
  return out.trimEnd() || FALLBACK;
}
