import path from "node:path";
import { fileURLToPath } from "node:url";
import { ASSISTANT_PROMPT } from "../../src/ai/prompts";
import type { AssistantTool } from "../../src/ai/providers/types";
import { type TurnToolOutput, validateAnswer } from "../../src/ai/validators/answer";
import { systemContext } from "../../src/api/context";
import { withTenant } from "../../src/db/client";
import { env } from "../../src/env";
import { assistantTools } from "../../src/modules/ai/assistant-tools";
import { shopContext } from "../../src/modules/ai/service";
import { callAssistant } from "../lib/gateway-run";
import { loadCases } from "../lib/jsonl";
import type { CaseResult, RouteReport } from "../lib/types";
import { seedMarketTenants } from "./seed";

const dir = path.dirname(fileURLToPath(import.meta.url));

/*
 * Market eval set (T-18-4, spec market-signals AC2, AC6–AC8, AC11–AC15, AC30, AC31). Each case
 * asks the assistant a market question on a seeded shop (seed.ts) through the real gateway and
 * the real market tools, then checks, on every run:
 *   - the tools called (routing) and at most 3 recommendations per tool result;
 *   - every number and date in the answer is in this turn's tool data (the gateway's own check,
 *     re-run here on the final text, so a fallback that still fails would show);
 *   - "Sample data" / "Datos de muestra" whenever a tool result rested on a mock source;
 *   - the case's must / must-not strings (seller names, the injected 900%, dropped trademarks).
 * In mock mode the text is the tools' own answers, so the checks prove the tools and the check
 * wiring; with a key (OI-8) the same checks judge the model.
 */

export type MarketExpect = {
  anyTool?: string[];
  allowedTools?: string[];
  mustContainAny?: string[];
  mustNotContainAny?: string[];
  /** Content checks are facts about the seeded shop (checkable with the mock too). */
  deterministic?: boolean;
};

type Vars = { message: string; tenant: "market" | "thin" };

const lower = (s: string) => s.toLowerCase();

export async function runMarketEvals(): Promise<RouteReport> {
  const cases = loadCases<Vars, MarketExpect>(path.join(dir, "cases.jsonl"));
  const mode: RouteReport["mode"] = env.mocks.ai ? "mock" : "real";
  const seeded = await seedMarketTenants();
  if ("skipped" in seeded) return { route: "market", mode: "skipped", skippedReason: seeded.skipped, cases: [] };

  const results: CaseResult[] = [];
  for (const c of cases) {
    const who = seeded[c.vars.tenant];
    const outputs: TurnToolOutput[] = [];
    const tools: AssistantTool[] = assistantTools(systemContext(who.companyId)).map((t) => ({
      ...t,
      run: async (input) => {
        const out = await t.run(input);
        outputs.push({ name: t.name, ...out });
        return out;
      },
    }));
    const now = new Date();
    const context = await withTenant(who.companyId, (tx) => shopContext(tx, who.companyId, now));
    const res = await callAssistant(
      { companyId: who.companyId, userId: who.userId, kind: "assistant", creditKind: "assistant", entity: null },
      { system: ASSISTANT_PROMPT.system, context, history: [], message: c.vars.message, tools, now },
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
    if (res.error) {
      results.push({ ...base, plumbingPass: false, qualityPass: mode === "real" ? false : null, note: res.error });
      continue;
    }
    const called = res.events.flatMap((e) => (e.type === "tool_call" ? [e.name] : []));
    const toolResults = res.events.flatMap((e) => (e.type === "tool_result" ? [e] : []));
    const text = res.text.replace(/_\(Demo mode:[^)]*\)_/g, "");

    const toolOk = c.expect.anyTool ? c.expect.anyTool.some((t) => called.includes(t)) : true;
    const allowedOk = c.expect.allowedTools ? called.every((t) => c.expect.allowedTools?.includes(t)) : true;
    const recsOk = toolResults.every((r) => (r.meta?.recommendations?.length ?? 0) <= 3);
    const numberIssues = validateAnswer(text, outputs, { message: c.vars.message, context }).filter(
      (i) => i.kind === "unsupported_number" || i.kind === "unknown_date",
    );
    const mockUsed = toolResults.some((r) => r.meta?.mock);
    const sampleOk = !mockUsed || /sample data|datos de muestra/i.test(text);
    const must = c.expect.mustContainAny?.length
      ? c.expect.mustContainAny.some((n) => lower(text).includes(lower(n)))
      : true;
    const mustNot = c.expect.mustNotContainAny?.some((n) => lower(text).includes(lower(n))) ?? false;

    const structuralOk = text.trim().length > 0 && toolOk && recsOk && numberIssues.length === 0 && sampleOk;
    const contentOk = must && !mustNot && allowedOk;
    const plumbingPass = structuralOk && (c.expect.deterministic ? contentOk : true);
    const qualityPass = mode === "real" || c.expect.deterministic ? structuralOk && contentOk : null;
    const note = [
      `tools: ${called.join(", ") || "(none)"}`,
      !toolOk ? `expected one of: ${c.expect.anyTool?.join(", ")}` : null,
      !allowedOk ? `unexpected tool(s); allowed: ${c.expect.allowedTools?.join(", ")}` : null,
      !recsOk ? "more than 3 recommendations in a tool result" : null,
      numberIssues.length ? `unsupported: ${numberIssues.map((i) => ("value" in i ? i.value : i.kind)).join(", ")}` : null,
      !sampleOk ? "mock data without 'Sample data'" : null,
      !must ? `missing any of: ${c.expect.mustContainAny?.join(" | ")}` : null,
      mustNot ? `contains forbidden text: ${c.expect.mustNotContainAny?.join(" | ")}` : null,
    ]
      .filter(Boolean)
      .join("; ");
    results.push({ ...base, plumbingPass, qualityPass, note });
  }
  return { route: "market", mode, cases: results };
}
