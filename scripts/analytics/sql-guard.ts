/*
 * SQL guard for the analytics files (wave 57 T-57-1, S-97, architect A1.0-A1.5).
 *
 * The control is an allow-list, not a longer deny list: every function call in an analytics
 * query must be on ALLOWED_CALLS, and anything the scanner cannot read with certainty is refused
 * (fail closed). `assertAllowedSql` takes the exact text `bindQuery` sends to Postgres (comments
 * already stripped) and reads it left to right in one pass, so cost is linear in the input.
 *
 * How an analyst adds a function: edit ALLOWED_CALLS in this file. The change is reviewed by the
 * security-reviewer; there is no runtime flag, environment variable or per-file override.
 */

/** Functions the five committed files call, plus plain aggregate, date and math helpers. None runs SQL. */
export const ALLOWED_CALLS: ReadonlySet<string> = new Set([
  // the five committed files
  "bool_or",
  "coalesce",
  "count",
  "floor",
  "lead",
  "least",
  "now",
  "nullif",
  "round",
  "sum",
  // named extras (A1.3)
  "avg",
  "min",
  "max",
  "greatest",
  "abs",
  "ceil",
  "lag",
  "row_number",
  "date_trunc",
  "extract",
  "bool_and",
]);

/**
 * Words that may stand before `(` without being a call. No pg_proc row on PG 17 has any of these
 * names (a test asserts it), so a keyword can never turn into a function.
 */
export const NON_CALL_KEYWORDS: ReadonlySet<string> = new Set([
  "as",
  "by",
  "exists",
  "filter",
  "from",
  "in",
  "over",
  "select",
  "sets",
  "when",
  "then",
  "else",
  "and",
  "or",
  "not",
  "on",
  "where",
  "join",
  "any",
  "all",
  "union",
  "case",
  "values",
  "array",
  "row",
  "lateral",
  "distinct",
  "cast",
  "group",
  "within",
]);

export class SqlGuardError extends Error {
  constructor(
    message: string,
    readonly offset: number,
  ) {
    super(`${message} (offset ${offset})`);
    this.name = "SqlGuardError";
  }
}

const shown = (s: string) => (s.length > 40 ? `${s.slice(0, 40)}...` : s);

const isIdentStart = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
const isDigit = (c: number) => c >= 48 && c <= 57;
const isIdentPart = (c: number) => isIdentStart(c) || isDigit(c);

type Pending = { name: string; quoted: boolean; pos: number; qualified: boolean };

export function assertAllowedSql(text: string): void {
  const n = text.length;
  let prev = ""; // text of the last non-whitespace token; "\"" marks a quoted identifier, "'" a string
  let pending: Pending | null = null;
  let i = 0;

  // Called for every non-whitespace token, in order.
  const token = (kind: "ident" | "qident" | "string" | "num" | "punct", t: string, pos: number) => {
    if (pending) {
      if (kind === "punct" && t === "(") {
        const p: Pending = pending;
        if (p.qualified)
          throw new SqlGuardError(`qualified call ${shown(p.name)}( is refused`, p.pos);
        const ok = p.quoted
          ? ALLOWED_CALLS.has(p.name)
          : NON_CALL_KEYWORDS.has(p.name) || ALLOWED_CALLS.has(p.name);
        if (!ok)
          throw new SqlGuardError(`function ${shown(p.name)} is not on the allow-list`, p.pos);
      }
      pending = null;
    }
    if (kind === "punct" && t === "." && (prev === ")" || prev === "]"))
      throw new SqlGuardError("attribute notation after ) or ] is refused", pos);
    if (kind === "ident") pending = { name: t, quoted: false, pos, qualified: prev === "." };
    else if (kind === "qident") pending = { name: t, quoted: true, pos, qualified: prev === "." };
    prev = kind === "qident" ? '"' : kind === "string" ? "'" : t;
  };

  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13) {
      i++;
      continue;
    }
    if (c === 92) throw new SqlGuardError("backslash is refused", i);
    if (c === 39 || c === 34) {
      // 'string' or "identifier"; the doubled quote is the only escape
      const start = i;
      let j = i + 1;
      let body = "";
      let from = j;
      for (;;) {
        if (j >= n) throw new SqlGuardError("unterminated quote", start);
        const d = text.charCodeAt(j);
        if (d === 92) throw new SqlGuardError("backslash is refused", j);
        if (d === c) {
          if (text.charCodeAt(j + 1) === c) {
            body += text.slice(from, j + 1);
            j += 2;
            from = j;
            continue;
          }
          body += text.slice(from, j);
          break;
        }
        j++;
      }
      if (c === 39) token("string", body, start);
      else token("qident", body, start);
      i = j + 1;
      continue;
    }
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < n && isIdentPart(text.charCodeAt(j))) j++;
      const word = text.slice(i, j).toLowerCase();
      if (word === "uescape") throw new SqlGuardError("UESCAPE is refused", i);
      const after = text.charCodeAt(j);
      if (word === "u" && after === 38)
        throw new SqlGuardError("U& string or identifier is refused", i);
      if (word === "e" && after === 39)
        throw new SqlGuardError("escape string E'...' is refused", i);
      token("ident", word, i);
      i = j;
      continue;
    }
    if (isDigit(c)) {
      let j = i + 1;
      while (j < n && isDigit(text.charCodeAt(j))) j++;
      if (j < n && isIdentPart(text.charCodeAt(j)))
        throw new SqlGuardError("a number glued to a letter or underscore is refused", i);
      token("num", text.slice(i, j), i);
      i = j;
      continue;
    }
    if (c === 36) throw new SqlGuardError("$ outside quotes is refused", i);
    if (c === 59) throw new SqlGuardError("; outside quotes is refused", i);
    if (c === 47 && text.charCodeAt(i + 1) === 42)
      throw new SqlGuardError("block comment /* is refused", i);
    if (c === 42 && text.charCodeAt(i + 1) === 47)
      throw new SqlGuardError("block comment */ is refused", i);
    if (c < 32 || c > 126)
      throw new SqlGuardError("a character outside printable ASCII is refused", i);
    token("punct", text[i] as string, i);
    i++;
  }
  // a name at the very end has no "(" after it
}
