import { ORPCError } from "@orpc/server";
import { runStructured } from "../../ai/gateway";
import { nicheClassifierPrompt } from "../../ai/prompts";
import { withTenant } from "../../db/client";
import { logger } from "../../lib/log";
import { checkTrademarks } from "./trademark";

/*
 * Market niche helpers for the market module (T-18-3 calls them; spec market-signals Step 2.2 and
 * 2.3). The mapper tries stems first and calls `classifyDesignNiche` only when nothing matched;
 * every niche label, canonical query and design idea passes `screenMarketTerms` before it is
 * queried or shown.
 */

const log = logger("ai.niche");

export type NicheOption = { key: string; labelEn: string };

export type ClassifyNicheInput = {
  designId: string;
  name: string;
  tags: string[];
  niches: NicheOption[];
};

export type ClassifyNicheResult = { niche: string | null; confidence: number };

/** Most tags sent to the model; design tags are short, but a shop can type many. */
const MAX_TAGS = 20;

/**
 * Suggests one taxonomy niche for a design (the `market_niche` route, Haiku, through the gateway:
 * credits, PII scrub, ai_jobs row and cost). Returns `null` when the shop's AI credits are out or
 * the platform spend cap is reached; never throws for those. A key outside `niches` comes back as
 * `{ niche: null, confidence: 0 }`. Callers keep the suggestion only at `confidence >= 0.7`.
 */
export async function classifyDesignNiche(
  companyId: string,
  input: ClassifyNicheInput,
): Promise<ClassifyNicheResult | null> {
  if (!input.niches.length) return { niche: null, confidence: 0 };
  try {
    const { output } = await runStructured(
      {
        companyId,
        userId: null,
        kind: "market_niche",
        // The contract's CREDIT_KINDS has no market_niche yet; niche sorting is a catalog
        // classification call like SKU suggestions (follow-up for the architect in T-18-4's report).
        creditKind: "sku_suggestion",
        entity: { type: "design", id: input.designId },
      },
      nicheClassifierPrompt,
      {
        name: input.name.slice(0, 200),
        tags: input.tags.slice(0, MAX_TAGS).map((t) => t.slice(0, 60)),
        niches: input.niches,
      },
    );
    const key = output.niche?.trim().toLowerCase() ?? null;
    const known = key != null && input.niches.some((n) => n.key === key);
    if (key != null && !known)
      log.warn("niche model answered a key outside the taxonomy", { companyId });
    const confidence = Math.min(1, Math.max(0, Number(output.confidence) || 0));
    return known ? { niche: key, confidence } : { niche: null, confidence: 0 };
  } catch (err) {
    if (
      err instanceof ORPCError &&
      (err.code === "CREDITS_EXHAUSTED" || err.code === "AI_SPEND_CAP_REACHED")
    ) {
      log.info("niche classification skipped", { companyId, reason: err.code });
      return null;
    }
    if (err instanceof ORPCError && err.code === "UPSTREAM_FAILED") {
      // Refusal or unparseable output: a permanent answer for this design, not a retry.
      log.warn("niche classification failed", { companyId, error: err.message });
      return { niche: null, confidence: 0 };
    }
    throw err;
  }
}

/**
 * Risk score at or above which a market term is dropped: the trademark check's `medium` band
 * (25). A listing at medium needs a human review; a market term has no reviewer, so it is dropped.
 */
export const MARKET_TERM_MAX_RISK = 25;

/**
 * Drops market terms (niche labels, canonical queries, design ideas) whose trademark risk is at or
 * above `MARKET_TERM_MAX_RISK`, using the deterministic class-25 check (no model call). Dropped
 * terms are never returned or logged; only their count is (the spec's log counter).
 */
export async function screenMarketTerms(
  companyId: string,
  terms: string[],
): Promise<{ allowed: string[]; droppedCount: number }> {
  const list = terms.map((t) => t.trim()).filter(Boolean);
  if (!list.length) return { allowed: [], droppedCount: 0 };
  const allowed = await withTenant(companyId, async (tx) => {
    const keep: string[] = [];
    for (const term of list) {
      const tm = await checkTrademarks(
        tx,
        { companyId, userId: null },
        [{ source: "input_text", text: term }],
        { judge: false },
      );
      if (tm.riskScore < MARKET_TERM_MAX_RISK) keep.push(term);
    }
    return keep;
  });
  const droppedCount = list.length - allowed.length;
  if (droppedCount)
    log.info("market terms dropped by the trademark screen", {
      companyId,
      checked: list.length,
      droppedCount,
    });
  return { allowed, droppedCount };
}
