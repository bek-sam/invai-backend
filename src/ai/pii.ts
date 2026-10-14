/**
 * Buyer personal data never reaches the model (architecture 8.4). Everything sent through the
 * gateway passes this scrubber: emails, phone numbers, street addresses and card-like numbers
 * are replaced with placeholders. Design text and shop copy pass through unchanged.
 */

/**
 * International phone numbers (R-B454): a `+` not preceded by a word char or `+`, then digit groups with
 * single separators (space, `.`, `-`) and at most one `(..)` group, 8 to 15 digits in total. A
 * trailing date or count that joins the run (`+52 55 1234 5678 2026-10-14`) is trimmed back off. Runs
 * under 8 digits (`+12 orders`, `+1,234`, `+6.5%`) and numbers followed by a digit, `%` or `[.,]\d`
 * are not phones. The match is capped at 16 groups of 16 digits (a longer run is never a phone, and an
 * unbounded run made the trim loop quadratic). This runs before `[number]`: a `+` never starts a card number.
 */
const INTL_RE = /(?<![\w+])\+(?:[ .-]?(?:\(\d{1,16}\)|\d{1,16})){1,16}/g;
const INTL_GROUP = /[ .-]?(?:\(\d+\)|\d+)/g;
const digitCount = (s: string) => s.replace(/\D/g, "").length;

function scrubInternational(text: string): string {
  return text.replace(INTL_RE, (match, offset: number) => {
    const groups = match.slice(1).match(INTL_GROUP) ?? [];
    if (groups.filter((g) => g.includes("(")).length > 1) return match;
    let used = groups.length;
    while (used > 1 && digitCount(groups.slice(0, used).join("")) > 15) used--;
    const total = digitCount(groups.slice(0, used).join(""));
    if (total < 8 || total > 15) return match;
    if (/^\.\d{1,2}$/.test(groups[used - 1] ?? "")) return match;
    const phone = `+${groups.slice(0, used).join("")}`;
    const next = text.slice(offset + phone.length);
    if (/^(?:[\d%]|[.,]\d)/.test(next)) return match;
    return `[phone]${match.slice(phone.length)}`;
  });
}

/**
 * Mexican national numbers: 2-digit ladas only (CDMX 55/56, Guadalajara 33, Monterrey 81), 2-4-4.
 * 3-digit ladas are 3-3-4 and the US pattern already catches them. A generic 2-4-4 would eat
 * `10 2024-2025`.
 */
const MX_RE = /\(?\b(?:55|56|33|81)\)?[ .-]?\d{4}[ .-]?\d{4}\b/g;

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const maskToken = (n: number) =>
  `\uE000${String.fromCharCode(97 + (n % 26))}${"x".repeat(Math.floor(n / 26))}\uE001`;

const PATTERNS: [RegExp | ((text: string) => string), string][] = [
  // The lookbehind starts a match only at the head of a local-part run, so a long run with no `@` is scanned once.
  [/(?<![A-Z0-9._%+-])[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]"],
  [scrubInternational, ""],
  [/\b(?:\d[ -]?){13,19}\b/g, "[number]"],
  [/(?:\+?1[ .-]?)?\(?\b\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}\b/g, "[phone]"],
  [MX_RE, "[phone]"],
  [
    /\b\d{1,6}\s+(?:[A-Z][a-z]*\.?\s){1,4}(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Way|Ct|Court|Pl|Place|Pkwy|Hwy)\b\.?(?:\s*(?:Apt|Suite|Unit|#)\s*[\w-]+)?/g,
    "[address]",
  ],
  [/\b\d{5}(?:-\d{4})\b/g, "[zip]"],
];

export function stripPii(text: string): string {
  // UUIDs (insight and fact ids, digest placeholders) are masked so an all-digit one is not scrubbed.
  const uuids: string[] = [];
  let out = text.replace(UUID_RE, (u) => {
    uuids.push(u);
    return maskToken(uuids.length - 1);
  });
  for (const [pattern, repl] of PATTERNS) {
    out = typeof pattern === "function" ? pattern(out) : out.replace(pattern, repl);
  }
  return uuids.length === 0
    ? out
    : out.replace(
        /\uE000([a-z])(x*)\uE001/g,
        (_, c: string, xs: string) => uuids[c.charCodeAt(0) - 97 + 26 * xs.length] ?? "",
      );
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
