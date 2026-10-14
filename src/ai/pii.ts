/**
 * Buyer personal data never reaches the model (architecture 8.4). Prompt values and assistant
 * messages and history pass this scrubber: emails, phone numbers, street addresses and card-like
 * numbers are replaced with placeholders. Design text and shop copy pass through unchanged.
 */

/**
 * Separator between phone digit groups (T-53-1, S-92): space, `.`, `-`, `/`, `_`, NBSP, narrow NBSP,
 * any dash from U+2010 to U+2015 (en, figure, em) and the minus sign. T-54-4 (S-93): also tab, the
 * U+2000-U+200D spaces, U+205F, U+3000, U+2060, U+FEFF, `~`, `\u00B7` and the fullwidth `\uFF0D \uFF0E \uFF0F \uFF3F`.
 * T-55-1 (S-94): also CR, LF, VT, FF, U+0085, U+1680, U+2028, U+2029, `\u2022`, `\uFF5E`, `\u301C`, `\u30FB` and `\uFF65`.
 * A run of any length joins two groups (`SEP*` is unambiguous, so it stays linear); a comma or colon joins
 * only the US and Mexican national patterns, as one char with no space (`NAT_RUN`). Digits are any Unicode
 * decimal digit (`\p{Nd}`), so Arabic-Indic and fullwidth digits count.
 */
const SEP =
  "[ \\t\\n\\v\\f\\r.\\-/_~\u0085\u00B7\u00A0\u1680\u202F\u2000-\u200D\u2010-\u2015\u2022\u2028\u2029\u205F\u2060\u2212\u3000\u301C\u30FB\uFEFF\uFF0D\uFF0E\uFF0F\uFF3F\uFF5E\uFF65]";
const SEP_RUN = `${SEP}*`;
/** National patterns only: a comma or colon may join 3-3-4 and 2-4-4 groups (never a thousands grouping or a time). */
const NAT_RUN = `(?:${SEP}*|[,:])`;
const SPACE_IN_RUN = /[ \t\n\v\f\r\u0085\u00A0\u1680\u202F\u2000-\u200A\u2028\u2029\u205F\u3000]/;
const D = "\\p{Nd}";
const NOT_AFTER_WORD = "(?<![\\w\\p{Nd}])";
const NOT_BEFORE_WORD = "(?![\\w\\p{Nd}])";
const OPEN = "[(\uFF08]";
const CLOSE = "[)\uFF09]";

const INTL_RE = new RegExp(
  `(?<![\\p{Nd}+\uFF0B])[+\uFF0B](?:${SEP_RUN}(?:${OPEN}${D}{1,16}${CLOSE}|${D}{1,16})){1,16}`,
  "gu",
);
const INTL_GROUP = new RegExp(`${SEP_RUN}(?:${OPEN}${D}+${CLOSE}|${D}+)`, "gu");
const groupSeparator = (g: string) => /^[^\p{Nd}(\uFF08]*/u.exec(g)?.[0] ?? "";
const digitCount = (s: string) => s.match(/\p{Nd}/gu)?.length ?? 0;
const DOT_DD = new RegExp(`^[.\uFF0E]${D}{1,2}$`, "u");
const NEXT_GLUED = new RegExp(`^(?:[\\p{Nd}%]|[.,\uFF0E]${D})`, "u");

function scrubInternational(text: string): string {
  return text.replace(INTL_RE, (match, offset: number) => {
    const groups = match.slice(1).match(INTL_GROUP) ?? [];
    if (groups.filter((g) => /[(\uFF08]/.test(g)).length > 1) return match;
    let used = groups.length;
    while (used > 1 && digitCount(groups.slice(0, used).join("")) > 15) used--;
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

const ZEROS = [0x30, 0xff10, 0x660, 0x6f0, 0x966];
const dv = (v: number) => `[${ZEROS.map((z) => String.fromCharCode(z + v)).join("")}]`;
const LADA = `(?:${dv(5)}[${ZEROS.map((z) => String.fromCharCode(z + 5) + String.fromCharCode(z + 6)).join("")}]|${dv(3)}${dv(3)}|${dv(8)}${dv(1)})`;
const MX_RE = new RegExp(
  `${OPEN}?${NOT_AFTER_WORD}${LADA}${CLOSE}?${NAT_RUN}${D}{4}${NAT_RUN}${D}{4}${NOT_BEFORE_WORD}`,
  "gu",
);
const scrubMexican = (text: string) => text.replace(MX_RE, "[phone]");
const US_RE = new RegExp(
  `(?:[+\uFF0B]?[1\uFF11]${NAT_RUN})?${OPEN}?${NOT_AFTER_WORD}${D}{3}${CLOSE}?${NAT_RUN}${D}{3}${NAT_RUN}${D}{4}${NOT_BEFORE_WORD}`,
  "gu",
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
 * (`"jo smith"@x.com`) opens at the nearest unescaped `"` after the previous email, at any distance and across
 * newlines (T-55-1, S-94: no 254 bound, no newline stop), found by one forward scan carried across matches (an `@` inside
 * the quotes is allowed; a `\"` is skipped). A zero-width char may follow any TLD letter; the local part also takes
 * the fullwidth `． ＿ － ＋ ％` and the ideographic and halfwidth full stops.
 * T-54-4: the anchor may be fullwidth `\uFF20` or small `\uFE6B`, domain dots may be fullwidth, zero-width chars and astral letters belong to the local part. Emails run before the UUID mask, so a UUID
 * local part is scrubbed.
 */
const ZW = "\u00AD\u200B-\u200D\u2060\uFEFF";
const AT = "[@\uFF20\uFE6B]";
const DOT = "[.\uFF0E\u3002\uFF61]";
const EMAIL_DOMAIN_RE = new RegExp(
  `${AT}(?:[\\p{L}\\p{N}\\p{M}${ZW}.\\uFF0E\\u3002\\uFF61-]+${DOT}(?:\\p{L}[${ZW}]*){2,}|\\[(?:IPv6:)?[0-9A-F.:]{2,45}\\])`,
  "giu",
);
const HAS_AT = /[@\uFF20\uFE6B]/;
const IS_AT = /^[@\uFF20\uFE6B]$/;
const LOCAL_CHAR = new RegExp(
  `[\\p{L}\\p{N}\\p{M}._%+'\u2019\uFF0E\u3002\uFF61\uFF0D\uFF3F\uFF0B\uFF05${ZW}-]`,
  "u",
);
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

/**
 * Opener of a quoted local part: the nearest unescaped `"` after `last` and before the closing quote at `at - 1`,
 * any distance, across newlines. `q` carries a forward scan (each char read once per call to scrubEmails).
 */
type QuoteScan = { pos: number; quote: number; bs: number };
function quotedStart(text: string, at: number, last: number, q: QuoteScan): number {
  if (text[at - 1] !== '"') return -1;
  if (q.pos < last) {
    q.pos = last;
    q.quote = -1;
    q.bs = 0;
  }
  for (; q.pos < at - 1; q.pos++) {
    const c = text[q.pos];
    if (c === '"' && q.bs % 2 === 0) q.quote = q.pos;
    q.bs = c === "\\" ? q.bs + 1 : 0;
  }
  return q.quote >= last ? q.quote : -1;
}

function scrubEmails(text: string): string {
  if (!HAS_AT.test(text)) return text;
  let out = "";
  let last = 0;
  let lastWasEmail = false;
  const q: QuoteScan = { pos: 0, quote: -1, bs: 0 };
  for (const m of text.matchAll(EMAIL_DOMAIN_RE)) {
    const at = m.index;
    const end = at + m[0].length;
    let start = quotedStart(text, at, last, q);
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

const NET_SEP =
  "[ \\t\\-\u00A0\u202F\u2000-\u200D\u2010-\u2015\u205F\u2060\u2212\u3000\uFEFF\uFF0D]";
/** Glue net (S-94): a digit run joined only by separators with 20+ digits (two phones glued), or 10+ single digits each apart. */
const RUN_RE = new RegExp(
  `${NOT_AFTER_WORD}(?:${D}(?:${SEP}+${D}){9,}|${D}(?:${SEP_RUN}${D}){12,})${NOT_BEFORE_WORD}`,
  "gu",
);
const SINGLE_DIGITS = new RegExp(`^${D}(?:${SEP}+${D})+$`, "u");
/** The card net of old (13-19 digits, single space or dash), applied inside a run of under 20 digits. */
const NUMBER_IN_RUN = new RegExp(
  `${NOT_AFTER_WORD}${D}(?:${NET_SEP}?${D}){12,18}${NOT_BEFORE_WORD}`,
  "gu",
);
const scrubRuns = (text: string) =>
  text.replace(RUN_RE, (m) =>
    digitCount(m) >= 20 || SINGLE_DIGITS.test(m) ? "[phone]" : m.replace(NUMBER_IN_RUN, "[number]"),
  );
const fw = (s: string) => s.replace(/[!-~]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0));
const SUFFIX = [
  "St",
  "Street",
  "Ave",
  "Avenue",
  "Rd",
  "Road",
  "Blvd",
  "Boulevard",
  "Dr",
  "Drive",
  "Ln",
  "Lane",
  "Way",
  "Ct",
  "Court",
  "Pl",
  "Place",
  "Pkwy",
  "Hwy",
];
const UNIT = ["Apt", "Suite", "Unit", "#"];
const ADDRESS_RE = new RegExp(
  `${NOT_AFTER_WORD}${D}{1,6}[\\s\u3000]+(?:[A-Z\uFF21-\uFF3A][a-z\uFF41-\uFF5A]*[.\uFF0E]?[\\s\u3000]){1,4}(?:${[...SUFFIX, ...SUFFIX.map(fw)].join("|")})(?![\\w\uFF10-\uFF19\uFF21-\uFF3A\uFF41-\uFF5A])[.\uFF0E]?(?:[\\s\u3000]*(?:${[...UNIT, ...UNIT.map(fw)].join("|")})[\\s\u3000]*[\\w\\-\uFF10-\uFF19\uFF21-\uFF3A\uFF41-\uFF5A\uFF0D]+)?`,
  "gu",
);
const ZIP_RE = new RegExp(`${NOT_AFTER_WORD}${D}{5}[-\uFF0D]${D}{4}${NOT_BEFORE_WORD}`, "gu");

const PATTERNS: [RegExp | ((text: string) => string), string][] = [
  [scrubInternational, ""],
  [scrubRuns, ""],
  [US_RE, "[phone]"],
  [scrubMexican, ""],
  [ADDRESS_RE, "[address]"],
  [ZIP_RE, "[zip]"],
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
