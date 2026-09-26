import { CHANNEL_RULES, type Channel } from "@invai/contracts";
import { MOCK_MODEL } from "../models";
import { resolvePeriod } from "../periods";
import type {
  ListingCopy,
  ListingVars,
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

export function planAssistantCalls(message: string, now: Date): PlannedCall[] {
  const t = message.toLowerCase();
  const period = resolvePeriod(t, now);
  const range = { from: period.from.toISOString(), to: period.to.toISOString() };
  const channel = CHANNEL_WORDS.find(
    (c) => t.includes(c) || (c === "tiktok" && t.includes("tik tok")),
  );
  const calls: PlannedCall[] = [];
  if (/margin|profit|net\b|revenue|earn|made|money|sales/.test(t)) {
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
  if (/order|late|at risk|overdue|due|ship/.test(t))
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
  }
  return calls;
}

function* chunks(text: string): Generator<string> {
  const parts = text.split(/(\s+)/);
  for (let i = 0; i < parts.length; i += 6) yield parts.slice(i, i + 6).join("");
}

async function* mockAssistant(
  run: AssistantRun,
  onUsage?: (usage: TokenUsage) => void,
): AsyncGenerator<AssistantStreamEvent, AssistantFinal> {
  const planned = planAssistantCalls(run.message, run.now);
  const answers: string[] = [];
  const results: unknown[] = [];
  for (const call of planned) {
    const tool = run.tools.find((x) => x.name === call.tool);
    if (!tool) continue;
    const input = tool.input.parse(call.input) as Record<string, unknown>;
    yield { type: "tool_call", name: tool.name, input };
    const out = await tool.run(input);
    results.push(out.data);
    yield { type: "tool_result", name: tool.name, summary: out.summary };
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
    } else throw new Error(`mock provider has no fixture for prompt ${prompt.id}`);
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
