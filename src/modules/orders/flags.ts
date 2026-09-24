import type { ItemFlag } from "../../db/schema";

/*
 * Item flags are the active problems on a unit (contracts ItemFlag). Clearing removes the flag
 * from the item; the timeline keeps the history through audit rows.
 */

export type FlagInput = { code: string; severity: ItemFlag["severity"]; message: string };

export function withFlags(
  existing: ItemFlag[],
  add: FlagInput[],
  clear: string[] = [],
): ItemFlag[] {
  const now = new Date().toISOString();
  const clearSet = new Set(clear);
  const out = existing.filter((f) => !clearSet.has(f.code));
  for (const f of add) {
    const idx = out.findIndex((x) => x.code === f.code);
    const flag: ItemFlag = { ...f, active: true, createdAt: out[idx]?.createdAt ?? now };
    if (idx >= 0) out[idx] = flag;
    else out.push(flag);
  }
  return out;
}

export const ARTWORK_ITEM_FLAGS = [
  "personalization_missing",
  "artwork_overflow",
  "artwork_typo",
  "artwork_suspicious_chars",
  "artwork_qa_failed",
];

/** Personalization render flag -> item flag code. */
export const ARTWORK_TO_ITEM_FLAG: Record<string, string> = {
  overflow: "artwork_overflow",
  too_long: "artwork_overflow",
  empty: "personalization_missing",
  missing_answer: "personalization_missing",
  suspicious_chars: "artwork_suspicious_chars",
  possible_typo: "artwork_typo",
  odd_date: "artwork_typo",
};
