import path from "node:path";
import { fileURLToPath } from "node:url";
import type { EvalTenant } from "../lib/fixtures";
import { loadCases } from "../lib/jsonl";
import type { RouteReport } from "../lib/types";

const dir = path.dirname(fileURLToPath(import.meta.url));

/*
 * personalization_check has no route yet: it's an AI_JOB_KINDS/CREDIT_KINDS entry
 * (src/db/schema/ai.ts) reserved for it, but there is no prompt in src/ai/prompts/index.ts and no
 * entry in ROUTES (src/ai/models.ts) — see backlog B-101 ("sku_suggestion and
 * personalization_check prompts"), still open. T-8-5 is read-only on src/ai, so it can't add the
 * route; it ships the case file now (cases.jsonl, scrubbed synthetic buyer personalization text:
 * profanity, trademarks, emoji/non-Latin scripts, over-length, injection, empty input — the
 * coverage eval-template.md asks for) so B-101 only has to wire the prompt and delete this skip.
 */

export async function runPersonalizationCheck(_tenant: EvalTenant): Promise<RouteReport> {
  const cases = loadCases<Record<string, unknown>, Record<string, unknown>>(
    path.join(dir, "cases.jsonl"),
  );
  return {
    route: "personalization_check",
    mode: "skipped",
    skippedReason: `route not implemented yet (backlog B-101) — ${cases.length} cases staged in evals/personalization_check/cases.jsonl for when it ships`,
    cases: [],
  };
}
