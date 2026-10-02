/**
 * The one place model ids and per-route settings live (v1-plan section 2, architecture 8.2).
 * Default: Claude Opus 5 with adaptive thinking, tuned per route with `output_config.effort`.
 * A cheaper model for a bulk route is a one-line change here, after an eval shows equal quality.
 */

export type Effort = "low" | "medium" | "high";

export type AiRoute =
  | "listing_copy"
  | "trademark_judge"
  | "assistant"
  | "market_niche"
  | "digest_narrative";

export type RouteConfig = {
  model: string;
  /**
   * `output_config.effort`, or null for a model that rejects it (Haiku 4.5). A null-effort route
   * also runs without thinking and without the refusal-fallback beta (Opus/Fable only).
   */
  effort: Effort | null;
  maxTokens: number;
};

export const DEFAULT_MODEL = "claude-opus-5";
export const SONNET_MODEL = "claude-sonnet-5";
export const HAIKU_MODEL = "claude-haiku-4-5";

export const ROUTES: Record<AiRoute, RouteConfig> = {
  listing_copy: { model: DEFAULT_MODEL, effort: "medium", maxTokens: 16_000 },
  trademark_judge: { model: DEFAULT_MODEL, effort: "low", maxTokens: 4_000 },
  assistant: { model: DEFAULT_MODEL, effort: "high", maxTokens: 32_000 },
  // Wave 18 (T-18-4, spec market-signals Step 2.2): one-label niche classification, a bulk route
  // run by the nightly mapper only when stems don't match. Haiku per the wave plan (decision 0007
  // bulk-route rule); real-model eval pending OI-8. Output is `{niche, confidence}`, well under 512.
  market_niche: { model: HAIKU_MODEL, effort: null, maxTokens: 512 },
  // Wave 19 (T-19-2, spec weekly-digest pipeline 8): one weekly single-shot summary per shop,
  // shadow mode until OI-8. Low effort: it phrases ranked facts with placeholders, no reasoning
  // over data. 2,000 caps thinking plus a headline and up to ~7 items of 280 chars, and keeps the
  // worst-case estimate (about 6¢) under DIGEST_MAX_CENTS_PER_WEEK (10¢).
  digest_narrative: { model: DEFAULT_MODEL, effort: "low", maxTokens: 2_000 },
};

/* ------------------------------ OpenAI routes ------------------------------ */

/**
 * Decision 0021: when only OPENAI_API_KEY is set, the same routes run on OpenAI's Responses API.
 * Ids and prices checked on developers.openai.com/api/docs/models and /pricing, 2026-10-01.
 * GPT-6.1 Sol ("near-Astra performance at a lower cost") stands in for Opus 5; GPT-6 Luna
 * ("focused, high-volume tasks") for Haiku on the one bulk route. Effort maps one to one; Luna's
 * `none` turns reasoning off like the Haiku route. The prompts were tuned on Claude: these routes
 * are unproven until `pnpm evals` runs in openai mode (decision 0021).
 */
export const OPENAI_SOL_MODEL = "gpt-6.1-sol";
export const OPENAI_LUNA_MODEL = "gpt-6-luna";

export type OpenAiRouteConfig = {
  model: string;
  /** Responses API `reasoning.effort`. */
  effort: "none" | Effort;
  /** `max_output_tokens`; on OpenAI it includes reasoning tokens, as `max_tokens` does thinking. */
  maxTokens: number;
};

export const OPENAI_ROUTES: Record<AiRoute, OpenAiRouteConfig> = {
  listing_copy: { model: OPENAI_SOL_MODEL, effort: "medium", maxTokens: 16_000 },
  trademark_judge: { model: OPENAI_SOL_MODEL, effort: "low", maxTokens: 4_000 },
  assistant: { model: OPENAI_SOL_MODEL, effort: "high", maxTokens: 32_000 },
  market_niche: { model: OPENAI_LUNA_MODEL, effort: "none", maxTokens: 512 },
  digest_narrative: { model: OPENAI_SOL_MODEL, effort: "low", maxTokens: 2_000 },
};

/**
 * Server-side refusal fallback: on a classifier decline the API re-runs the request on the
 * model Anthropic recommends for that refusal category. `stop_reason` is still checked.
 */
export const REFUSAL_FALLBACK = {
  betas: ["server-side-fallback-2026-07-01"],
  fallbacks: "default",
} as const;

/** Mock provider label stored on ai_jobs / drafts when no API key is configured. */
export const MOCK_MODEL = "mock-claude-opus-5";

/**
 * Credits: 1 credit per 1,000 billable tokens (cache reads count at 10%), minimum 1 per call.
 * A listing draft is typically 2–4 credits, an assistant answer 3–10.
 */
export function tokensToCredits(u: {
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
}) {
  const billable = u.tokensIn + u.tokensOut + Math.round(u.cacheReadTokens * 0.1);
  return Math.max(1, Math.ceil(billable / 1000));
}

/* --------------------------------- price table --------------------------------- */

/** Cents per million tokens, list price. */
export type ModelPriceCents = {
  inputPerMTok: number;
  outputPerMTok: number;
  /** Cache write, standard 5-minute TTL (`cache_control: { type: "ephemeral" }` with no `ttl`). */
  cacheWrite5mPerMTok: number;
  /** Cache write, 1-hour TTL (`ttl: "1h"`). Not currently requested by any provider call. */
  cacheWrite1hPerMTok: number;
  cacheReadPerMTok: number;
  /** Message Batches API: 50% off the standard input/output rate. */
  batchInputPerMTok: number;
  batchOutputPerMTok: number;
};

/**
 * List prices for every model this codebase can route to (Opus, Sonnet, Haiku — B-45). No price
 * is hard-coded outside this table: `tokensToCostCents` below only reads from it.
 *
 * Source: Anthropic's Claude API pricing, via the `claude-api` skill's "Current Models" reference
 * (skill cache date 2026-06-24; checked against docs.claude.com/en/docs/about-claude/pricing on
 * 2026-09-26). Cache write = 1.25x input (5m TTL) / 2x input (1h TTL); cache read = 0.1x input;
 * batch = 50% off input and output — Anthropic's standard multipliers, applied to each model's
 * base rate below. Re-check this table (and the date in this comment) whenever a model is added
 * or repriced.
 */
export const MODEL_PRICES: Record<string, ModelPriceCents> = {
  [DEFAULT_MODEL]: {
    // Opus 5: $5.00 / $25.00 per MTok in/out.
    inputPerMTok: 500,
    outputPerMTok: 2_500,
    cacheWrite5mPerMTok: 625,
    cacheWrite1hPerMTok: 1_000,
    cacheReadPerMTok: 50,
    batchInputPerMTok: 250,
    batchOutputPerMTok: 1_250,
  },
  [SONNET_MODEL]: {
    // Sonnet 5: $2.00 / $10.00 per MTok in/out.
    inputPerMTok: 200,
    outputPerMTok: 1_000,
    cacheWrite5mPerMTok: 250,
    cacheWrite1hPerMTok: 400,
    cacheReadPerMTok: 20,
    batchInputPerMTok: 100,
    batchOutputPerMTok: 500,
  },
  [HAIKU_MODEL]: {
    // Haiku 4.5: $1.00 / $5.00 per MTok in/out.
    inputPerMTok: 100,
    outputPerMTok: 500,
    cacheWrite5mPerMTok: 125,
    cacheWrite1hPerMTok: 200,
    cacheReadPerMTok: 10,
    batchInputPerMTok: 50,
    batchOutputPerMTok: 250,
  },
  // OpenAI (decision 0021), Standard tier, short context (under 272K input tokens; every route
  // here is far below it). OpenAI has one cache-write rate, so both TTL fields carry it. Source:
  // developers.openai.com/api/docs/pricing, checked 2026-10-01.
  [OPENAI_SOL_MODEL]: {
    // GPT-6.1 Sol: $2.00 in / $0.10 cached / $2.50 cache write / $10.00 out per MTok.
    inputPerMTok: 200,
    outputPerMTok: 1_000,
    cacheWrite5mPerMTok: 250,
    cacheWrite1hPerMTok: 250,
    cacheReadPerMTok: 10,
    batchInputPerMTok: 100,
    batchOutputPerMTok: 500,
  },
  [OPENAI_LUNA_MODEL]: {
    // GPT-6 Luna: $0.10 in / $0.01 cached / $0.125 cache write / $0.50 out per MTok.
    inputPerMTok: 10,
    outputPerMTok: 50,
    cacheWrite5mPerMTok: 12.5,
    cacheWrite1hPerMTok: 12.5,
    cacheReadPerMTok: 1,
    batchInputPerMTok: 5,
    batchOutputPerMTok: 25,
  },
};

/**
 * The price row for a model id: exact, else the longest table id it starts with (a dated
 * snapshot such as `gpt-6.1-sol-2026-09-01` prices as `gpt-6.1-sol`), else undefined.
 */
export function priceFor(model: string): ModelPriceCents | undefined {
  const exact = MODEL_PRICES[model];
  if (exact) return exact;
  const key = Object.keys(MODEL_PRICES)
    .filter((k) => model.startsWith(`${k}-`))
    .sort((a, b) => b.length - a.length)[0];
  return key ? MODEL_PRICES[key] : undefined;
}

/**
 * List-price cost of a call, in cents, read from `MODEL_PRICES`. `model` defaults to
 * `DEFAULT_MODEL` (every route currently uses it) and falls back to it for an id the table
 * doesn't recognize, so a mis-tagged job traces at Opus 5 prices rather than throwing.
 */
export function tokensToCostCents(
  u: {
    tokensIn: number;
    tokensOut: number;
    cacheReadTokens: number;
    /** Tokens written to the cache this call (0 when nothing new was cached). */
    cacheWriteTokens?: number;
  },
  model: string = DEFAULT_MODEL,
  opts: { batch?: boolean; cacheTtl?: "5m" | "1h" } = {},
): number {
  const price = priceFor(model) ?? MODEL_PRICES[DEFAULT_MODEL];
  if (!price) throw new Error("MODEL_PRICES is missing DEFAULT_MODEL");
  const batchDiscount = opts.batch ? 0.5 : 1;
  const cacheWriteRate =
    (opts.cacheTtl === "1h" ? price.cacheWrite1hPerMTok : price.cacheWrite5mPerMTok) *
    batchDiscount;
  // MODEL_PRICES rates are already cents per million tokens, so this division yields cents.
  const cents =
    (u.tokensIn * (opts.batch ? price.batchInputPerMTok : price.inputPerMTok) +
      u.tokensOut * (opts.batch ? price.batchOutputPerMTok : price.outputPerMTok) +
      u.cacheReadTokens * price.cacheReadPerMTok * batchDiscount +
      (u.cacheWriteTokens ?? 0) * cacheWriteRate) /
    1_000_000;
  return Math.round(cents);
}
