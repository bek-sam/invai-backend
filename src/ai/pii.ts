/**
 * Buyer personal data never reaches the model (architecture 8.4). Prompt values and assistant
 * messages and history pass this scrubber: emails, phone numbers, street addresses and card-like
 * numbers are replaced with placeholders. Design text and shop copy pass through unchanged.
 */

/**
 * Separator between phone digit groups (T-53-1, S-92): space, `.`, `-`, `/`, `_`, NBSP, narrow NBSP,
 * any dash from U+2010 to U+2015 (en, figure, em) and the minus sign. A run of 0 to 3 of them joins two
 * groups (`602  555  0143`, `+52 - 55`); the bound keeps every pattern linear. T-54-4 (S-93): also tab, the
 * U+2000-U+200D spaces, U+205F, U+3000, U+2060, U+FEFF, `~`, `·` and the fullwidth `－ ． ／ ＿`, runs of 0 to 8;
 * digits may be fullwidth. Two phones glued by a digit (any separator but space and `-`) are not split (backlog).
 */
const SEP =
  "[ \\t.\\-/_~\u00B7\u00A0\u202F\u2000-\u200D\u2010-\u2015\u205F\u2060\u2212\u3000\uFEFF\uFF0D\uFF0E\uFF0F\uFF3F]";
const SEP_RUN = `${SEP}{0,8}`;
const SPACE_IN_RUN = /[ \t\u00A0\u202F\u2000-\u200A\u205F\u3000]/;
/** Digits, ASCII or fullwidth (T-54-4): a class, never a rewrite of the text. */
const D = "[0-9\uFF10-\uFF19]";
const NOT_AFTER_WORD = "(?<![\\w\uFF10-\uFF19])";
const NOT_BEFORE_WORD = "(?![\\w\uFF10-\uFF19])";
const OPEN = "[(\uFF08]";
const CLOSE = "[)\uFF09]";

/**
 * International phone numbers (R-B454): a `+` not preceded by a digit or `+` (so `call+525512345678` is a phone),
 * then digit groups with a separator run (`SEP`) and at most one `(..)` group, 8 to 15 digits in total. A
 * trailing date or count that joins the run (`+52 55 1234 5678 2026-10-14`) is trimmed back off. Runs
 * under 8 digits (`+12 orders`, `+1,234`, `+6.5%`) and numbers followed by a digit, `%` or `[.,]\d`
 * are not phones. The match is capped at 16 groups of 16 digits (a longer run is never a phone, and an
 * unbounded run made the trim loop quadratic). This runs before `[number]`: a `+` never starts a card number.
 */
const INTL_RE = new RegExp(
  `(?<![0-9\uFF10-\uFF19+\uFF0B])[+\uFF0B](?:${SEP_RUN}(?:${OPEN}${D}{1,16}${CLOSE}|${D}{1,16})){1,16}`,
  "g",
);
const INTL_GROUP = new RegExp(`${SEP_RUN}(?:${OPEN}${D}+${CLOSE}|${D}+)`, "g");
const groupSeparator = (g: string) => /^[^0-9\uFF10-\uFF19(\uFF08]*/.exec(g)?.[0] ?? "";
const digitCount = (s: string) => s.replace(/[^0-9\uFF10-\uFF19]/g, "").length;
const DOT_DD = new RegExp(`^[.\uFF0E]${D}{1,2}$`);
const NEXT_GLUED = new RegExp(`^(?:[0-9\uFF10-\uFF19%]|[.,\uFF0E]${D})`);

function scrubInternational(text: string): string {
  return text.replace(INTL_RE, (match, offset: number) => {
    const groups = match.slice(1).match(INTL_GROUP) ?? [];
    if (groups.filter((g) => /[(\uFF08]/.test(g)).length > 1) return match;
    let used = groups.length;
    while (used > 1 && digitCount(groups.slice(0, used).join("")) > 15) used--;
    // A trim that would cut a date or count in two (`... 5678 14/10/2026`) goes back to a whitespace boundary.
    while (
      used > 1 &&
      used < groups.length &&
      !SPACE_IN_RUN.test(groupSeparator(groups[used] ?? ""))
    )
      used--;
    const total = digitCount(groups.slice(0, used).join(""));
    if (total < 8 || total > 15) return match;
    if (DOT_DD.test(groups[used - 1] ?? "")) return match;
    const phone = `${match.charAt(0)}${groups.slice(0, used).join("")}`;
    const next = text.slice(offset + phone.length);
    if (NEXT_GLUED.test(next)) return match;
    return `[phone]${match.slice(phone.length)}`;
  });
}

/**
 * Mexican national numbers: 2-digit ladas only (CDMX 55/56, Guadalajara 33, Monterrey 81), 2-4-4.
 * 3-digit ladas are 3-3-4 and the US pattern already catches them. A generic 2-4-4 would eat
 * `10 2024-2025`.
 */
const MX_RE = new RegExp(
  `${OPEN}?${NOT_AFTER_WORD}(?:[5\uFF15][56\uFF15\uFF16]|[3\uFF13][3\uFF13]|[8\uFF18][1\uFF11])${CLOSE}?${SEP_RUN}${D}{4}${SEP_RUN}${D}{4}${NOT_BEFORE_WORD}`,
  "g",
);
const US_RE = new RegExp(
  `(?:[+\uFF0B]?[1\uFF11]${SEP_RUN})?${OPEN}?${NOT_AFTER_WORD}${D}{3}${CLOSE}?${SEP_RUN}${D}{3}${SEP_RUN}${D}{4}${NOT_BEFORE_WORD}`,
  "g",
);

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const maskToken = (n: number) =>
  `\uE000${String.fromCharCode(97 + (n % 26))}${"x".repeat(Math.floor(n / 26))}\uE001`;

/**
 * Emails, anchored at the `@` (S-91 r3, T-53-1): the regex finds `@domain` (a Unicode domain with a
 * TLD, or a bounded IP literal `[192.0.2.4]`), then the local part is extended left over local-part
 * chars, stopping at the end of the previous scrubbed email. Neither the domain nor the local part can
 * cross an `@`, so every char is scanned a bounded number of times (linear), and emails glued together
 * (`a@b.com.d@x.com`) are each scrubbed. A domain whose `@` has no local part right after a scrubbed
 * email (`jo@x.com.bob@yahoo.com`) joins that email. A run of `@` before the anchor is skipped
 * (`a@@x.com`); leading apostrophes are not part of the local part (`'jo@x.com'`); a quoted local part
 * (`"jo smith"@x.com`) is found by one backward scan of at most 254 chars (the longest deliverable address, T-54-4)
 * that stops at the previous email or a newline (an `@` inside the quotes is allowed; a `\"` is skipped).
 * T-54-4: the anchor may be fullwidth `＠` or small `﹫`, domain dots may be fullwidth, zero-width chars and astral letters belong to the local part. Emails run before the UUID mask, so a UUID
 * local part is scrubbed.
 */
const ZW = "\u00AD\u200B-\u200D\u2060\uFEFF";
const AT = "[@\uFF20\uFE6B]";
const DOT = "[.\uFF0E\u3002\uFF61]";
const EMAIL_DOMAIN_RE = new RegExp(
  `${AT}(?:[\\p{L}\\p{N}\\p{M}${ZW}.\\uFF0E\\u3002\\uFF61-]+${DOT}\\p{L}{2,}|\\[(?:IPv6:)?[0-9A-F.:]{2,45}\\])`,
  "giu",
);
const HAS_AT = /[@\uFF20\uFE6B]/;
const IS_AT = /^[@\uFF20\uFE6B]$/;
const LOCAL_CHAR = new RegExp(`[\\p{L}\\p{N}\\p{M}._%+'\u2019${ZW}-]`, "u");
const QUOTED_LOCAL_MAX = 254;
const isApostrophe = (c: string | undefined) => c === "'" || c === "\u2019";

/** Start of the local-part char (1 or 2 UTF-16 units) that ends right before `end`, or `end` when none. */
function localCharStart(text: string, end: number, last: number): number {
  if (end <= last) return end;
  const c = text.charCodeAt(end - 1);
  if (c >= 0xdc00 && c <= 0xdfff && end - 2 >= last && LOCAL_CHAR.test(text.slice(end - 2, end)))
    return end - 2;
  return LOCAL_CHAR.test(text[end - 1] ?? "") ? end - 1 : end;
}

function walkLocal(text: string, from: number, last: number): number {
  let start = from;
  for (let p = localCharStart(text, start, last); p < start; p = localCharStart(text, start, last))
    start = p;
  return start;
}

function escapedQuote(text: string, i: number, stop: number): boolean {
  let run = 0;
  for (let j = i - 1; j >= stop && text[j] === "\\"; j--) run++;
  return run % 2 === 1;
}

function quotedStart(text: string, at: number, last: number): number {
  if (text[at - 1] !== '"') return -1;
  const stop = Math.max(last, at - 2 - QUOTED_LOCAL_MAX);
  for (let i = at - 2; i >= stop; i--) {
    const c = text[i];
    if (c === '"' && !escapedQuote(text, i, stop)) return i;
    if (c === "\n") return -1;
  }
  return -1;
}

function scrubEmails(text: string): string {
  if (!HAS_AT.test(text)) return text;
  let out = "";
  let last = 0;
  let lastWasEmail = false;
  for (const m of text.matchAll(EMAIL_DOMAIN_RE)) {
    const at = m.index;
    const end = at + m[0].length;
    let start = quotedStart(text, at, last);
    if (start < 0) {
      let s0 = at;
      while (s0 > last && IS_AT.test(text[s0 - 1] ?? "")) s0--;
      start = walkLocal(text, s0, last);
      while (start < s0 && isApostrophe(text[start])) start++;
      if (start === s0) start = at;
    } else {
      start = walkLocal(text, start, last);
    }
    if (start < at) {
      out += `${text.slice(last, start)}[email]`;
    } else if (!(lastWasEmail && at === last)) {
      continue;
    }
    last = end;
    lastWasEmail = true;
  }
  return out + text.slice(last);
}

const PATTERNS: [RegExp | ((text: string) => string), string][] = [
  [scrubInternational, ""],
  [/\b(?:\d[ -]?){13,19}\b/g, "[number]"],
  [US_RE, "[phone]"],
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
  let out = scrubEmails(text).replace(UUID_RE, (u) => {
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
