/**
 * The one place model ids and per-route settings live (v1-plan section 2, architecture 8.2).
 * Default: Claude Opus 5 with adaptive thinking, tuned per route with `output_config.effort`.
 * A cheaper model for a bulk route is a one-line change here, after an eval shows equal quality.
 */

export type Effort = "low" | "medium" | "high";

export type AiRoute = "listing_copy" | "trademark_judge" | "assistant";

export type RouteConfig = {
  model: string;
  effort: Effort;
  maxTokens: number;
};

export const DEFAULT_MODEL = "claude-opus-5";

export const ROUTES: Record<AiRoute, RouteConfig> = {
  listing_copy: { model: DEFAULT_MODEL, effort: "medium", maxTokens: 16_000 },
  trademark_judge: { model: DEFAULT_MODEL, effort: "low", maxTokens: 4_000 },
  assistant: { model: DEFAULT_MODEL, effort: "high", maxTokens: 32_000 },
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

/** List price per million tokens for cost traces (Opus 5: $5 in / $25 out, cache read $0.50). */
export function tokensToCostCents(u: {
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
}) {
  const dollars = (u.tokensIn * 5 + u.tokensOut * 25 + u.cacheReadTokens * 0.5) / 1_000_000;
  return Math.round(dollars * 100);
}
