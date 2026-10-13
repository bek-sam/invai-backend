import { cutWhole } from "../../lib/text-safety";

const MAX_UNITS = 200;
const FALLBACK = "A teammate";

/**
 * Display name for `acceptedBy` (contract cap: 200 UTF-16 units). Cuts on a whole character
 * (grapheme) so an emoji, flag or base+mark at the cut is kept or dropped whole. A lone surrogate
 * would make Postgres jsonb refuse the write, which would fail the accept and then the designs list.
 */
export function acceptedByName(name: string | null | undefined): string {
  const out = cutWhole((name ?? "").trim(), MAX_UNITS);
  return out.trimEnd() || FALLBACK;
}
