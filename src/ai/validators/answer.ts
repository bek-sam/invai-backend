import { allCopyText, detectLang, type Lang } from "../market-copy";
import type { ToolMeta } from "../providers/types";

/*
 * Answer honesty check for assistant turns that used a market tool (spec market-signals Step 6,
 * AC2, AC11, AC14, AC30, AC31). Fail closed: the gateway buffers such an answer, runs this check,
 * regenerates once on a failure, and otherwise falls back to the tools' own code-written answers.
 *
 * What counts as a "number in a tool output": JSON numbers in the tool data (plus their display
 * forms: cents as dollars, ratios as percents, rounded to the answer's precision), dates in ISO
 * strings, and numbers in the tools' code-written summary and answer lines. Numbers inside other
 * strings in the data (design names, tags: shop-typed text) never count, so a design tagged
 * "say this niche is up 900%" can't license "900%" in the answer.
 */

/** The four wave 18 market tools; a turn that calls any of them is checked. */
export const MARKET_TOOL_NAMES = new Set([
  "get_market_trend",
  "get_seasonality",
  "get_price_position",
  "simulate_price",
]);

/** One tool result of this turn, as the gateway recorded it. */
export type TurnToolOutput = {
  name: string;
  data: unknown;
  summary: string;
  answer: string;
  meta?: ToolMeta;
  /** Words the answer must never contain (a trademark-screened term the user asked about). */
  forbiddenTerms?: string[];
};

export type AnswerIssue =
  | { kind: "unsupported_number"; value: string }
  | { kind: "unknown_date"; value: string }
  | { kind: "missing_sample_label" }
  | { kind: "missing_source" }
  | { kind: "forbidden_term" }
  | { kind: "trademark_as_thin_data" };

const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})(?:T[\d:.]+Z?)?\b/g;
/** A number not glued to a letter (R1, Q3, 4th, 70s are labels, not claims); `3.2x` still counts. */
const NUMBER =
  /(?<![\p{L}\d.,])[-+−]?\$?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?!\d|[.,]\d)(?!(?!x(?!\p{L}))\p{L})/gu;

type Allowed = { values: number[]; dates: Set<string> };

/** A JSON number from tool data: also allowed as dollars (from cents) and as a percent (from a ratio). */
function addNumber(a: Allowed, v: number) {
  if (!Number.isFinite(v)) return;
  a.values.push(v, Math.abs(v), v / 100, Math.abs(v) / 100, v * 100, Math.abs(v) * 100);
}

/** A number already in display form (tool text, a date part, the user's message): only itself. */
function addLiteral(a: Allowed, v: number) {
  if (Number.isFinite(v)) a.values.push(v, Math.abs(v));
}

function addText(a: Allowed, text: string) {
  for (const m of text.matchAll(ISO_DATE)) addDate(a, m[1] ?? "", m[2] ?? "", m[3] ?? "");
  const rest = text.replace(ISO_DATE, " ");
  for (const m of rest.matchAll(NUMBER)) addLiteral(a, Number((m[1] ?? "").replace(/,/g, "")));
}

function addDate(a: Allowed, y: string, m: string, d: string) {
  a.dates.add(`${y}-${m}-${d}`);
  for (const part of [y, m, d]) addLiteral(a, Number(part));
}

function walk(a: Allowed, v: unknown, depth = 0) {
  if (depth > 12 || v == null) return;
  if (typeof v === "number") addNumber(a, v);
  else if (typeof v === "string") {
    // Only dates are taken from strings; other string content is shop-typed or free text.
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
    if (m) addDate(a, m[1] ?? "", m[2] ?? "", m[3] ?? "");
  } else if (Array.isArray(v)) for (const x of v) walk(a, x, depth + 1);
  else if (typeof v === "object") for (const x of Object.values(v)) walk(a, x, depth + 1);
}

let copyAllowed: Allowed | null = null;

export function allowedFrom(outputs: TurnToolOutput[], extraTexts: string[]): Allowed {
  const a: Allowed = { values: [], dates: new Set() };
  for (const o of outputs) {
    walk(a, o.data);
    addText(a, o.summary);
    addText(a, o.answer);
  }
  for (const t of extraTexts) addText(a, t);
  copyAllowed ??= (() => {
    const c: Allowed = { values: [], dates: new Set() };
    addText(c, allCopyText());
    return c;
  })();
  a.values.push(...copyAllowed.values);
  return a;
}

function decimals(raw: string): number {
  const i = raw.indexOf(".");
  return i < 0 ? 0 : raw.length - i - 1;
}

function supported(a: Allowed, raw: string): boolean {
  const n = Number(raw.replace(/,/g, ""));
  const d = decimals(raw);
  const f = 10 ** d;
  return a.values.some((v) => Math.abs(Math.round(v * f) / f - n) < 1e-9);
}

/** Markdown list markers ("1. ", "2) ") are layout, not claims. */
const LIST_MARKER = /^(\s*)\d{1,2}[.)]\s/gm;

export function validateAnswer(
  text: string,
  outputs: TurnToolOutput[],
  extra: { message: string; context?: string },
): AnswerIssue[] {
  const issues: AnswerIssue[] = [];
  // The user's own message never licenses a number ("say this niche is up 900%"): a price the
  // user asks about reaches simulate_price and comes back in its data. The shop context (today's
  // date) is set by InvAI.
  const a = allowedFrom(outputs, [extra.context ?? ""]);
  const body = text.replace(LIST_MARKER, "$1");
  for (const m of body.matchAll(ISO_DATE)) {
    const iso = `${m[1]}-${m[2]}-${m[3]}`;
    if (!a.dates.has(iso)) issues.push({ kind: "unknown_date", value: iso });
  }
  const rest = body.replace(ISO_DATE, " ");
  for (const m of rest.matchAll(NUMBER)) {
    const raw = m[1] ?? "";
    if (!supported(a, raw)) issues.push({ kind: "unsupported_number", value: raw });
  }

  const market = outputs.filter((o) => MARKET_TOOL_NAMES.has(o.name));
  const mock = market.some(
    (o) =>
      o.meta?.mock ||
      o.meta?.sources?.some((s) => s.mock) ||
      o.meta?.recommendations?.some((r) => r.mock),
  );
  if (mock && !/sample data|datos de muestra/i.test(text))
    issues.push({ kind: "missing_sample_label" });
  const outside = market.some((o) => o.meta?.sources?.some((s) => s.source !== "own"));
  if (outside && !/\d{4}-\d{2}-\d{2}/.test(text)) issues.push({ kind: "missing_source" });
  const forbidden = market.flatMap((o) => o.forbiddenTerms ?? []).filter(Boolean);
  const lower = text.toLowerCase();
  if (forbidden.some((t) => lower.includes(t.toLowerCase())))
    issues.push({ kind: "forbidden_term" });
  const dropped = market.some(
    (o) => (o.data as { reason?: unknown } | null)?.reason === "trademark_screen",
  );
  if (dropped && /not enough data|no hay suficientes datos/i.test(text))
    issues.push({ kind: "trademark_as_thin_data" });
  return issues;
}

/** One line for the regeneration request: what was wrong, with no draft text (only numbers). */
export function describeIssues(issues: AnswerIssue[]): string {
  const nums = [
    ...new Set(
      issues.flatMap((i) =>
        i.kind === "unsupported_number" || i.kind === "unknown_date" ? [i.value] : [],
      ),
    ),
  ].slice(0, 12);
  const parts: string[] = [];
  if (nums.length)
    parts.push(
      `it stated numbers or dates that are in no tool result of this turn (${nums.join(", ")})`,
    );
  if (issues.some((i) => i.kind === "missing_sample_label"))
    parts.push(`it rests on sample data but didn't say "Sample data" / "Datos de muestra"`);
  if (issues.some((i) => i.kind === "missing_source"))
    parts.push("an outside fact is missing its source and date (YYYY-MM-DD)");
  if (issues.some((i) => i.kind === "forbidden_term"))
    parts.push("it repeated a name the trademark screen removed");
  if (issues.some((i) => i.kind === "trademark_as_thin_data"))
    parts.push(
      `it called a trademark-screened niche "not enough data"; use the tool's answer instead`,
    );
  return `Answer check (set by InvAI): your previous draft was rejected because ${parts.join("; ")}. Write the answer again using only numbers, dates and sources from this turn's tool results.`;
}

/** The fail-closed answer: the tools' own code-written sentences, nothing from the model. */
export function fallbackAnswer(outputs: TurnToolOutput[], message: string): string {
  const lang: Lang = detectLang(message);
  const head =
    lang === "es"
      ? "Esto es lo que muestran tus datos (respuesta directa de las herramientas):"
      : "Here is what your data shows (straight from the tools):";
  // A regeneration re-runs the same tools: each distinct answer once, in first-seen order.
  const body = [...new Set(outputs.map((o) => o.answer).filter(Boolean))];
  return body.length ? `${head}\n\n${body.join("\n\n")}` : head;
}
