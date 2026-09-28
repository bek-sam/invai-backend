import { CHANNEL_RULES, type Channel } from "@invai/contracts";
import type { z } from "zod";
import { logger } from "../../lib/log";
import { detectLang } from "../market-copy";
import { MOCK_MODEL } from "../models";
import { resolvePeriod } from "../periods";
import type {
  DigestNarrative,
  DigestNarrativeVars,
  ListingCopy,
  ListingVars,
  NicheClassification,
  NicheVars,
  PromptDef,
  TrademarkJudgement,
  TrademarkJudgeVars,
} from "../prompts";
import type {
  AiProvider,
  AssistantFinal,
  AssistantRun,
  AssistantStreamEvent,
  StructuredResult,
  TokenUsage,
} from "./types";

/*
 * Mock provider (no ANTHROPIC_API_KEY). Deterministic and schema-valid: listing copy is built
 * from the design name, tags and blank; the assistant really calls the company-scoped tools and
 * writes its answer from their results, streamed as text deltas.
 */

const log = logger("ai:mock");

const estimateTokens = (s: string) => Math.ceil(s.length / 4);

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const titleCase = (s: string) =>
  s
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0]?.toUpperCase() + w.slice(1))
    .join(" ");

/** Blank descriptions without brand names (brands are trademarks; nominative use is left to the shop). */
function blankPhrase(styleCode: string | undefined): { short: string; long: string } {
  const code = (styleCode ?? "").toUpperCase();
  if (code.startsWith("CC"))
    return {
      short: "Garment-Dyed Heavyweight Tee",
      long: "a garment-dyed, heavyweight 100% ring-spun cotton tee with a relaxed fit and a soft, lived-in feel",
    };
  if (code.startsWith("BC") || code.includes("3001"))
    return {
      short: "Soft Unisex Jersey Tee",
      long: "a lightweight, retail-fit unisex jersey tee in combed ring-spun cotton",
    };
  if (code.startsWith("G"))
    return {
      short: "Softstyle Cotton Tee",
      long: "a midweight, soft ring-spun cotton tee with a classic unisex fit",
    };
  return { short: "Unisex Cotton Tee", long: "a comfortable unisex cotton tee" };
}

const GIFT_ANGLES = ["Gift for Her", "Gift for Him", "Birthday Gift", "Gift Idea", "Graphic Tee"];
const TAG_SUFFIXES = ["shirt", "tee", "gift", "lover gift", "graphic tee", "t shirt"];
const GENERIC_TAGS = [
  "graphic tee",
  "gift for her",
  "gift for him",
  "birthday gift",
  "unisex shirt",
  "trendy tee",
  "cute shirt",
  "vintage style tee",
  "comfy tee",
  "casual shirt",
  "summer shirt",
  "statement tee",
  "funny shirt",
];

const cleanTag = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9 '-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

function fitTitle(parts: string[], max: number): string {
  let title = "";
  for (const p of parts) {
    const next = title ? `${title}, ${p}` : p;
    if (next.length > max) break;
    title = next;
  }
  return title || (parts[0] ?? "").slice(0, max);
}

export function mockListingCopy(v: ListingVars): ListingCopy {
  const rules = CHANNEL_RULES[v.channel].listing;
  const h = hash(`${v.designName}|${v.channel}`);
  const theme = titleCase(
    v.designName.replace(/\b(shirt|tee|t-shirt)\b/gi, "").trim() || v.designName,
  );
  const blank = blankPhrase(v.blank?.style);
  const angle = GIFT_ANGLES[h % GIFT_ANGLES.length] as string;
  const tagWords = v.designTags.map(titleCase);

  const title = fitTitle(
    [`${theme} Shirt`, ...(tagWords[0] ? [`${tagWords[0]} Tee`] : []), blank.short, angle],
    rules.titleMax,
  );

  const colors = v.blank?.colors.length ? v.blank.colors.slice(0, 6).join(", ") : null;
  const description = [
    `${theme} — ${v.designTags.length ? `a ${v.designTags.slice(0, 3).join(", ")} design` : "an original design"} made for everyday wear${v.brief ? ` (${v.brief.trim().replace(/\.$/, "")})` : ""}.`,
    v.designText ? `Printed text: "${v.designText}".` : null,
    `Printed on ${blank.long}. The design is a DTF transfer: vivid color, soft hand feel and no cracking.`,
    colors ? `Available colors: ${colors}.` : null,
    "Care: wash inside out in cold water, tumble dry low, do not iron directly on the print.",
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, rules.descriptionMax);

  let tags: string[] = [];
  if (rules.tagsMax > 0) {
    const candidates = [
      ...v.designTags.map(cleanTag),
      ...v.designTags.flatMap((t) => TAG_SUFFIXES.map((s) => cleanTag(`${t} ${s}`))),
      cleanTag(`${theme} shirt`),
      cleanTag(theme),
      ...GENERIC_TAGS,
    ];
    const seen = new Set<string>();
    for (const t of candidates) {
      if (!t || t.length > Math.min(rules.tagMaxLen, 20) || seen.has(t)) continue;
      seen.add(t);
      tags.push(t);
      if (tags.length >= Math.min(rules.tagsMax, 13)) break;
    }
  }
  tags = tags.slice(0, rules.tagsMax);

  const bullets =
    rules.bulletsMax > 0
      ? [
          `${theme.toUpperCase()} DESIGN: an original ${v.designTags[0] ?? "graphic"} print, pressed to order`,
          `COMFORTABLE FIT: ${blank.long}`,
          "VIVID DTF PRINT: bright, flexible transfer that stays soft and resists cracking",
          "EASY CARE: machine wash cold inside out, tumble dry low",
          `GREAT GIFT: ${angle.toLowerCase()} for birthdays, holidays or just because`,
        ]
          .slice(0, rules.bulletsMax)
          .map((b) => b.slice(0, rules.bulletMaxLen))
      : [];

  const attributes = [
    { key: "material", value: "cotton" },
    { key: "style", value: blank.short },
    { key: "occasion", value: angle },
    { key: "print_method", value: "DTF transfer" },
  ];
  return { title, description, tags, bullets, attributes };
}

/**
 * Best-effort schema-valid placeholder for a prompt this mock has no hand-written fixture for
 * (a new route added after this file, or a typo'd `prompt.id`). Walks the zod shape and picks a
 * plausible value per node type; `mockProvider.structured` still runs the real `schema.parse` on
 * the result, so a shape this can't handle surfaces as a normal parse error, not a silent lie.
 */
function defaultForSchema(schema: z.ZodType): unknown {
  const def = (schema as unknown as { _def: { type: string; [k: string]: unknown } })._def;
  switch (def.type) {
    case "object": {
      const shape = (schema as z.ZodObject).shape;
      const out: Record<string, unknown> = {};
      for (const [key, field] of Object.entries(shape))
        out[key] = defaultForSchema(field as z.ZodType);
      return out;
    }
    case "array":
      return [];
    case "record":
      return {};
    case "string":
      return "";
    case "number":
      return 0;
    case "boolean":
      return false;
    case "literal":
      return (def.values as unknown[])[0];
    case "enum":
      return Object.values(def.entries as Record<string, unknown>)[0];
    case "nullable":
      return null;
    case "optional":
      return undefined;
    case "default":
      return def.defaultValue;
    case "null":
      return null;
    default:
      return def.innerType ? defaultForSchema(def.innerType as z.ZodType) : null;
  }
}

function usageOf(system: string, user: string, output: unknown): TokenUsage {
  return {
    tokensIn: estimateTokens(system) + estimateTokens(user),
    tokensOut: estimateTokens(JSON.stringify(output)),
    cacheReadTokens: 0,
  };
}

/* --------------------------------- assistant --------------------------------- */

type PlannedCall = { tool: string; input: Record<string, unknown> };

const CHANNEL_WORDS: Channel[] = ["etsy", "amazon", "shopify", "tiktok", "walmart", "ebay"];

const DAY_MS = 86_400_000;

/**
 * "this week" / "this month" are partial periods: compare them with the same span of the week or
 * month before (week-to-date vs last week-to-date), not with the days right before. Any other
 * period uses the tool's default (the same length immediately before).
 */
function previousOf(
  t: string,
  from: Date,
  to: Date,
): { previousFrom: string; previousTo: string } | null {
  if (/\bthis week\b/.test(t) || (/\bweek\b/.test(t) && !/\blast week\b/.test(t)))
    return {
      previousFrom: new Date(from.getTime() - 7 * DAY_MS).toISOString(),
      previousTo: new Date(to.getTime() - 7 * DAY_MS).toISOString(),
    };
  if (/\bthis month\b/.test(t)) {
    const pf = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() - 1, 1));
    const pt = new Date(Math.min(pf.getTime() + (to.getTime() - from.getTime()), from.getTime()));
    return { previousFrom: pf.toISOString(), previousTo: pt.toISOString() };
  }
  return null;
}

/**
 * Niche classification without a model: the niche whose key or label words all appear in the
 * design's name and tags (most words wins), at 0.8; otherwise none at 0.2. Deterministic.
 */
export function mockNiche(v: NicheVars): NicheClassification {
  const words = new Set(
    [v.name, ...v.tags]
      .join(" ")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );
  let best: { key: string; score: number } | null = null;
  for (const n of v.niches) {
    const parts = [
      ...new Set([...n.key.split("-"), ...n.labelEn.toLowerCase().split(/[^a-z0-9]+/)]),
    ].filter((w) => w.length > 1);
    const need = n.key.split("-").filter(Boolean);
    if (!need.length || !need.every((w) => words.has(w))) continue;
    const score = parts.filter((w) => words.has(w)).length;
    if (!best || score > best.score) best = { key: n.key, score };
  }
  return best ? { niche: best.key, confidence: 0.8 } : { niche: null, confidence: 0.2 };
}

const DIGEST_LABELS: Record<"en" | "es", Record<string, string>> = {
  en: {
    data_health: "Check your data",
    action: "To do",
    win: "Nice work",
    market: "Market watch",
    glance: "At a glance",
    steady: "A steady week",
  },
  es: {
    data_health: "Revisa tus datos",
    action: "Por hacer",
    win: "Buen trabajo",
    market: "Mercado",
    glance: "De un vistazo",
    steady: "Una semana estable",
  },
};

/**
 * Weekly digest summary without a model (T-19-2): a fixed label per insight kind, then that
 * insight's own placeholders, as many as fit in 280 characters once filled. Deterministic and
 * built to pass the digest validator, so the shadow path runs end to end with no key.
 */
export function mockDigestNarrative(v: DigestNarrativeVars): DigestNarrative {
  const labels = DIGEST_LABELS[v.lang];
  const value = new Map(v.facts.map((f) => [f.id, f.value]));
  return {
    lang: v.lang,
    headline: v.lang === "es" ? "Tu semana en resumen" : "Your week in review",
    items: v.insights.map((ins) => {
      const label = labels[ins.kind] ?? labels.action ?? "";
      let text = `${label}:`;
      let shown = text.length;
      const used: string[] = [];
      for (const id of ins.factIds) {
        const add = (value.get(id) ?? "").length + 2;
        if (shown + add > 270) break;
        used.push(`{{${id}}}`);
        shown += add;
      }
      text = used.length ? `${label}: ${used.join(", ")}.` : `${label}.`;
      return { insightId: ins.id, text };
    }),
  };
}

const NICHE_STOP = new Set([
  "the",
  "a",
  "an",
  "is",
  "how",
  "my",
  "for",
  "about",
  "el",
  "la",
  "del",
  "de",
]);

/** A niche the user names: "the Dog Mom niche", "el nicho Disney", or a quoted "term". */
export function nicheFromMessage(message: string): string | null {
  const quoted = /["“”«]([^"“”»]{2,40})["“”»]/.exec(message);
  if (quoted?.[1]) return quoted[1].trim();
  const before = /((?:[\p{L}0-9'&-]+\s+){0,2}[\p{L}0-9'&-]+)\s+niche\b/iu.exec(message);
  const after =
    /\bnicho\s+(?:de\s+)?([\p{L}0-9'&-]+(?:\s+[\p{L}0-9'&-]+){0,2}?)\s*(?:[?.!,¿]|$)/iu.exec(
      message,
    );
  const raw = before?.[1] ?? after?.[1];
  if (!raw) return null;
  const words = raw.split(/\s+/);
  while (words.length && NICHE_STOP.has((words[0] ?? "").toLowerCase())) words.shift();
  return words.length ? words.join(" ") : null;
}

/** Holiday and season words that name a taxonomy niche directly. */
const SEASON_NICHES: [RegExp, string][] = [
  [/halloween/i, "halloween"],
  [/christmas|navidad/i, "christmas"],
  [/thanksgiving|acci[oó]n de gracias/i, "thanksgiving"],
  [/valentine|san valent[ií]n/i, "valentines"],
  [/mother'?s day|d[ií]a de las madres/i, "mothers-day"],
  [/father'?s day|d[ií]a del padre/i, "fathers-day"],
  [/back.to.school|regreso a clases/i, "back-to-school"],
  [/d[ií]a de (los )?muertos/i, "dia-de-muertos"],
];

/**
 * Wave 18 market routing (T-18-4 AC8): trend, season and price questions go to the market tools,
 * with the user's language and any niche, holiday or channel the message names.
 */
function planMarketCalls(message: string): PlannedCall[] {
  const t = message.toLowerCase();
  const lang = detectLang(message);
  const channel = CHANNEL_WORDS.find(
    (c) => t.includes(c) || (c === "tiktok" && t.includes("tik tok")),
  );
  const named = nicheFromMessage(message);
  const holiday = SEASON_NICHES.find(([re]) => re.test(message))?.[1] ?? null;
  const niche = named ?? holiday;
  const subject = niche ? { niche } : {};
  const calls: PlannedCall[] = [];
  const trend = /trending|\btrends?\b|tendencia|\bniche\b|\bnicho\b/.test(t);
  const season =
    /holiday|season|halloween|christmas|get ready|temporada|fiestas|navidad|prepar/.test(t);
  const price = /priced right|price position|precio|pricing|\bmy price|price ok|priced/.test(t);
  if (trend && !(season && !named))
    calls.push({ tool: "get_market_trend", input: { ...subject, lang } });
  if (season) calls.push({ tool: "get_seasonality", input: { ...subject, lang } });
  if (price) {
    const scoped = channel && channel !== "ebay" ? { channel } : {};
    calls.push({ tool: "get_price_position", input: { ...scoped, lang } });
    calls.push({ tool: "simulate_price", input: { ...scoped, lang } });
  }
  return calls;
}

export function planAssistantCalls(message: string, now: Date): PlannedCall[] {
  return planCalls(message, now).calls;
}

function planCalls(message: string, now: Date): { calls: PlannedCall[]; fallback: boolean } {
  const market = planMarketCalls(message);
  if (market.length) return { calls: market, fallback: false };
  const t = message.toLowerCase();
  // "this week vs last week": the current period is this week, compared with last week.
  const both = /\bthis week\b/.test(t) && /\blast week\b/.test(t);
  const bothMonths = /\bthis month\b/.test(t) && /\blast month\b/.test(t);
  const period = resolvePeriod(both ? "this week" : bothMonths ? "this month" : t, now);
  const range = { from: period.from.toISOString(), to: period.to.toISOString() };
  const channel = CHANNEL_WORDS.find(
    (c) => t.includes(c) || (c === "tiktok" && t.includes("tik tok")),
  );
  const calls: PlannedCall[] = [];
  const review =
    /business review|weekly review|what should i do|revisi[oó]n (semanal|del negocio)/.test(t);
  const compare = review || /compar|\bvs\.?\b|versus|\bwhy\b|por qu[eé]/.test(t);
  const ads = review || /\bads?\b|ad spend|advertis|\broas\b|\btacos\b|campaign|anuncio/.test(t);
  const insights =
    review ||
    /rising|falling|trending|push or drop|cross.?list|low.?margin|insight|dise[ñn]os/.test(t) ||
    (/\bdesigns\b/.test(t) && !/best.?sell|top design|selling|popular/.test(t));
  const fulfillment =
    review || /on.?time|\blate\b|reprint|refund|fulfil|a tiempo|reimpres|reembolso/.test(t);
  const scoped = channel ? { channel } : {};
  if (compare) {
    const prev = both || bothMonths || /\bthis (week|month)\b|\bweek\b/.test(t);
    calls.push({
      tool: "compare_periods",
      input: {
        ...range,
        ...(prev ? (previousOf(t, period.from, period.to) ?? {}) : {}),
        ...scoped,
      },
    });
  }
  if (ads)
    calls.push({
      tool: "get_ad_performance",
      input: { ...range, ...scoped, ...(/campaign/.test(t) ? { groupBy: "campaign" } : {}) },
    });
  if (insights) calls.push({ tool: "get_design_insights", input: { ...range, limit: 5 } });
  if (fulfillment) calls.push({ tool: "get_fulfillment_health", input: { ...range, ...scoped } });
  if (
    /margin|profit|net\b|revenue|earn|made|money|sales/.test(t) &&
    // compare_periods already reports revenue, net and margin for both periods.
    !(compare && !/design|blank|style|daily|per day|by day/.test(t)) &&
    !(ads && !compare && !/margin|profit/.test(t))
  ) {
    const dimension = /design/.test(t)
      ? "design"
      : /blank|style/.test(t)
        ? "blank"
        : /daily|per day|by day/.test(t)
          ? "day"
          : "channel";
    calls.push({
      tool: "get_profit",
      input: { dimension, ...range, ...(channel ? { channel } : {}) },
    });
  }
  if (
    /stock|inventory|reorder|blank|run out|restock/.test(t) &&
    !calls.some((c) => c.input.dimension === "blank")
  )
    calls.push({
      tool: "get_stock",
      input: { belowReorderOnly: /low|reorder|run out|restock/.test(t) },
    });
  if (
    /order|late|at risk|overdue|due|ship/.test(t) &&
    // "Am I shipping on time?" is a fulfillment question; keep the order counts for order words.
    !(fulfillment && !/order|overdue|at risk|\bdue\b/.test(t))
  )
    calls.push({
      tool: "get_orders_summary",
      input: { ...range, ...(channel ? { channel } : {}) },
    });
  if (/listing|best.?sell|top design|selling|popular/.test(t))
    calls.push({ tool: "get_listing_performance", input: { ...range, limit: 5 } });
  if (/channel/.test(t) && !channel) calls.push({ tool: "get_channel_performance", input: range });
  if (/production|sheet|press|floor|queue|vendor/.test(t))
    calls.push({ tool: "get_production_status", input: {} });
  if (!calls.length) {
    calls.push({ tool: "get_orders_summary", input: range });
    calls.push({ tool: "get_profit", input: { dimension: "channel", ...range } });
    return { calls, fallback: true };
  }
  return { calls, fallback: false };
}

const TOOL_LINE = "[Tools used earlier: ";
/** Tools whose input takes a `channel` filter, so "and only Etsy?" can narrow them. */
const CHANNEL_TOOLS = new Set([
  "get_profit",
  "get_orders_summary",
  "compare_periods",
  "get_ad_performance",
  "get_fulfillment_health",
]);
const PERIOD_WORDS = /\b(today|yesterday|week|month|(?:last|past)\s+\d{1,3}\s+days?)\b/;

/**
 * A follow-up with no tool keywords of its own ("And only Etsy?"): re-plan the previous user
 * question (same tools as the earlier turn's tool line, same period, same `now`, so the result is
 * deterministic), then apply the channel or period the follow-up names. Null when the history has
 * no earlier tool-backed turn.
 */
export function planFollowUp(
  message: string,
  history: AssistantRun["history"],
  now: Date,
): PlannedCall[] | null {
  const k = history.findLastIndex((h) => h.role === "assistant" && h.text.startsWith(TOOL_LINE));
  const prevUser = k > 0 ? history.slice(0, k).findLast((h) => h.role === "user") : undefined;
  if (!prevUser) return null;
  const line = history[k]?.text.split("\n")[0] ?? "";
  const used = new Set([...line.matchAll(/(?:: |; )([a-z]+_[a-z_]+)/g)].map((m) => m[1]));
  const base = planCalls(prevUser.text, now).calls.filter((c) => used.has(c.tool));
  if (!base.length) return null;
  const t = message.toLowerCase();
  const channel = CHANNEL_WORDS.find(
    (c) => t.includes(c) || (c === "tiktok" && t.includes("tik tok")),
  );
  const period = PERIOD_WORDS.test(t) ? resolvePeriod(t, now) : null;
  return base.map((c) => {
    const input: Record<string, unknown> = { ...c.input };
    if (period && "from" in input) {
      input.from = period.from.toISOString();
      input.to = period.to.toISOString();
      delete input.previousFrom;
      delete input.previousTo;
    }
    if (channel && CHANNEL_TOOLS.has(c.tool)) input.channel = channel;
    return { tool: c.tool, input };
  });
}

function* chunks(text: string): Generator<string> {
  const parts = text.split(/(\s+)/);
  for (let i = 0; i < parts.length; i += 6) yield parts.slice(i, i + 6).join("");
}

async function* mockAssistant(
  run: AssistantRun,
  onUsage?: (usage: TokenUsage) => void,
): AsyncGenerator<AssistantStreamEvent, AssistantFinal> {
  const own = planCalls(run.message, run.now);
  const planned = own.fallback
    ? (planFollowUp(run.message, run.history, run.now) ?? own.calls)
    : own.calls;
  const answers: string[] = [];
  const results: unknown[] = [];
  for (const call of planned) {
    const tool = run.tools.find((x) => x.name === call.tool);
    if (!tool) continue;
    const input = tool.input.parse(call.input) as Record<string, unknown>;
    yield { type: "tool_call", name: tool.name, input };
    const out = await tool.run(input);
    results.push(out.data);
    yield { type: "tool_result", name: tool.name, summary: out.summary, meta: out.meta };
    answers.push(out.answer);
    // A running estimate (no model call, so this is the same deterministic formula as the final
    // usage below), so a caller torn down mid-loop can still charge for the answer built so far.
    onUsage?.(usageOf(run.system, run.message, { results, answers }));
  }
  const text = answers.length
    ? `${answers.join("\n\n")}\n\n_(Demo mode: answer composed from your live shop data without a model call.)_`
    : "I couldn't find data for that question. Try asking about profit, orders, stock, listings or production.";
  for (const piece of chunks(text)) yield { type: "text", text: piece };
  const usage = usageOf(run.system, run.message, { results, text });
  return { usage, model: MOCK_MODEL, stopReason: "end_turn" };
}

export const mockProvider: AiProvider = {
  name: "mock",
  async structured<V, O>(prompt: PromptDef<V, O>, vars: V): Promise<StructuredResult<O>> {
    let output: unknown;
    if (prompt.id === "listing_copy") output = mockListingCopy(vars as ListingVars);
    else if (prompt.id === "trademark_judge") {
      const v = vars as TrademarkJudgeVars;
      output = {
        judgements: v.candidates.map((c) => ({
          mark: c.mark,
          judgement: "possible",
          reason: "Mock provider: flagged for human review.",
        })),
      } satisfies TrademarkJudgement;
    } else if (prompt.id === "market_niche") output = mockNiche(vars as NicheVars);
    else if (prompt.id === "digest_narrative")
      output = mockDigestNarrative(vars as DigestNarrativeVars);
    else {
      // Unknown prompt id (a new route, or a typo): don't 500 the request — warn and hand back a
      // schema-valid placeholder so callers exercise the real path end to end (B-45 hardening).
      log.warn("no fixture for prompt; returning a schema-valid default", { promptId: prompt.id });
      output = defaultForSchema(prompt.schema);
    }
    const parsed = prompt.schema.parse(output);
    return {
      output: parsed,
      usage: usageOf(prompt.system, prompt.user(vars), parsed),
      model: MOCK_MODEL,
      stopReason: "end_turn",
    };
  },
  assistant: mockAssistant,
};
