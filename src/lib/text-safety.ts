/*
 * Text made safe for Postgres text/jsonb columns and for downstream consumers (T-8-6, follow-up
 * to T-8-2 r3 / OI-5). Postgres rejects a raw NUL byte in text and jsonb with 22P05/22021, so any
 * caller-supplied string that reaches a column unsanitized crashes the write. This module is the
 * one place that decides what's unstorable; every boundary that accepts outside text (oRPC
 * inputs, webhook payloads, CSV rows) calls into it instead of growing its own regex.
 */

/**
 * C0 control characters other than tab, newline and carriage return, plus DEL. NUL in particular
 * can't be stored: Postgres text and jsonb reject it (22P05), so a stray NUL in a design name or a
 * pasted personalization would crash an insert. None of them carry meaning for the model or a UI.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const UNSTORABLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** A surrogate half without its partner: jsonb rejects the `\ud800` escape JSON.stringify emits. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** One string made safe for Postgres text/jsonb: controls dropped, lone surrogates → U+FFFD. */
export function sanitizeText(text: string): string {
  return text.replace(UNSTORABLE, "").replace(LONE_SURROGATE, "�");
}

/**
 * Every string in `value` (object keys too) through `sanitizeText`, recursively. Pure: returns a
 * new value and never mutates `value` in place.
 */
export function sanitizeDeep<T>(value: T): T {
  if (typeof value === "string") return sanitizeText(value) as T;
  if (Array.isArray(value)) return value.map((v) => sanitizeDeep(v)) as T;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [sanitizeText(k), sanitizeDeep(v)]),
    ) as T;
  }
  return value;
}
