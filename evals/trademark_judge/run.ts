import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TrademarkJudgeVars } from "../../src/ai/prompts";
import { trademarkJudgePrompt } from "../../src/ai/prompts";
import { evalMode } from "../lib/mode";
import type { EvalTenant } from "../lib/fixtures";
import { callStructured } from "../lib/gateway-run";
import { loadCases } from "../lib/jsonl";
import type { CaseResult, RouteReport } from "../lib/types";

const dir = path.dirname(fileURLToPath(import.meta.url));

/*
 * trademark_judge: the mock provider (providers/mock.ts) always answers "possible" for every
 * candidate — a deliberate, documented placeholder (mock.ts's own comment), not a model under
 * test. So expect-match here is a real quality signal only with a key; in mock mode the plumbing
 * check is cardinality (one judgement per candidate) and mark fidelity (the mark string comes
 * back unchanged) — exactly what the gateway and schema are supposed to guarantee regardless of
 * which provider answers.
 */

export type TrademarkExpect = {
  /** Acceptable judgement(s); eval-template.md allows an array ("possible" or "conflict" both ok). */
  judgement: string | string[];
};

export async function runTrademarkJudge(tenant: EvalTenant): Promise<RouteReport> {
  const cases = loadCases<TrademarkJudgeVars, TrademarkExpect>(path.join(dir, "cases.jsonl"));
  const mode: RouteReport["mode"] = evalMode();
  const results: CaseResult[] = [];

  for (const c of cases) {
    const res = await callStructured(
      {
        companyId: tenant.companyId,
        userId: tenant.userId,
        kind: "trademark_check",
        creditKind: "trademark_check",
        entity: null,
      },
      trademarkJudgePrompt,
      c.vars,
    );
    const base = {
      id: c.id,
      tags: c.tags,
      costCents: res.costCents,
      latencyMs: res.latencyMs,
      tokensIn: res.tokensIn,
      tokensOut: res.tokensOut,
      cacheReadTokens: res.cacheReadTokens,
      model: res.model,
    };
    if (res.error || !res.output) {
      results.push({
        ...base,
        plumbingPass: false,
        qualityPass: mode !== "mock" ? false : null,
        note: res.error ?? "no output",
      });
      continue;
    }

    const judgements = res.output.judgements;
    const cardinalityOk = judgements.length === c.vars.candidates.length;
    const marksOk = judgements.every((j, i) => j.mark === c.vars.candidates[i]?.mark);
    const plumbingPass = cardinalityOk && marksOk;

    const expected = Array.isArray(c.expect.judgement) ? c.expect.judgement : [c.expect.judgement];
    const matches = plumbingPass && judgements.every((j) => expected.includes(j.judgement));

    let note = plumbingPass
      ? `judgements: ${judgements.map((j) => j.judgement).join(", ")}`
      : `cardinality/mark mismatch: got ${judgements.length} for ${c.vars.candidates.length} candidates`;
    const qualityPass = mode !== "mock" ? matches : null;
    if (mode === "mock" && !matches)
      note += ` (expect ${expected.join("|")} — mock always answers "possible"; informational)`;

    results.push({ ...base, plumbingPass, qualityPass, note });
  }

  return { route: "trademark_judge", mode, cases: results };
}
