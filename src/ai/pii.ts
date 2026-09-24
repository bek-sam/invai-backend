/**
 * Buyer personal data never reaches the model (architecture 8.4). Everything sent through the
 * gateway passes this scrubber: emails, phone numbers, street addresses and card-like numbers
 * are replaced with placeholders. Design text and shop copy pass through unchanged.
 */

const PATTERNS: [RegExp, string][] = [
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]"],
  [/\b(?:\d[ -]?){13,19}\b/g, "[number]"],
  [/(?:\+?1[ .-]?)?\(?\b\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}\b/g, "[phone]"],
  [
    /\b\d{1,6}\s+(?:[A-Z][a-z]*\.?\s){1,4}(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Way|Ct|Court|Pl|Place|Pkwy|Hwy)\b\.?(?:\s*(?:Apt|Suite|Unit|#)\s*[\w-]+)?/g,
    "[address]",
  ],
  [/\b\d{5}(?:-\d{4})\b/g, "[zip]"],
];

export function stripPii(text: string): string {
  let out = text;
  for (const [re, repl] of PATTERNS) out = out.replace(re, repl);
  return out;
}

/** Deep-scrub every string in a JSON-like value. */
export function stripPiiDeep<T>(value: T): T {
  if (typeof value === "string") return stripPii(value) as T;
  if (Array.isArray(value)) return value.map((v) => stripPiiDeep(v)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, stripPiiDeep(v)]),
    ) as T;
  }
  return value;
}
