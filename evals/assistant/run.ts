import path from "node:path";
import { fileURLToPath } from "node:url";
import { ASSISTANT_PROMPT } from "../../src/ai/prompts";
import { systemContext } from "../../src/api/context";
import { withTenant } from "../../src/db/client";
import { env } from "../../src/env";
import { assistantTools } from "../../src/modules/ai/assistant-tools";
import { shopContext } from "../../src/modules/ai/service";
import type { EvalTenant } from "../lib/fixtures";
import { callAssistant } from "../lib/gateway-run";
import { loadCases } from "../lib/jsonl";
import type { CaseResult, RouteReport } from "../lib/types";
import { createSeededEvalTenant } from "./seed";

const dir = path.dirname(fileURLToPath(import.meta.url));

/*
 * assistant tools: the eval tenant starts empty (fixtures.ts) on purpose. The mock provider
 * (providers/mock.ts mockAssistant) still runs the *real* company-scoped tools against the *real*
 * database — it just skips the model call — so its answer for a zero-order, zero-stock shop is a
 * genuine, deterministic fact ("0 orders were placed…"), not a canned fixture. That makes
 * `mustContainAny`/`mustNotContainAny` meaningful in mock mode too for `deterministic: true`
 * cases; only the two refusal cases (asking it to change data, asking about buyer PII) need a
 * real model — the mock has no refusal logic at all, it just answers from whatever tools its
 * regex-based planner picked (see planAssistantCalls).
 */

export type AssistantExpect = {
  /** At least one of these tools must be called. */
  anyTool?: string[];
  /** No tool outside this list may be called (`[]` — the injection set — means no tool at all). */
  allowedTools?: string[];
  mustContainAny?: string[];
  mustNotContainAny?: string[];
  /** True: the content checks above are a fact about the (empty) eval tenant, checkable in mock
   *  mode too, so they gate `plumbingPass`. False (default): they're a model-quality question,
   *  only meaningful with a real key. */
  deterministic?: boolean;
};

function containsAny(text: string, needles: string[] | undefined): boolean | null {
  if (!needles?.length) return null;
  const hay = text.toLowerCase();
  return needles.some((n) => hay.includes(n.toLowerCase()));
}

export async function runAssistantEvals(tenant: EvalTenant): Promise<RouteReport> {
  const cases = loadCases<
    {
      message: string;
      tenant?: "seeded";
      /** Earlier turns, as service.ts `ask` builds them (assistant turns start with the tool line). */
      history?: { role: "user" | "assistant"; text: string }[];
    },
    AssistantExpect
  >(
    path.join(dir, "cases.jsonl"),
  );
  const mode: RouteReport["mode"] = env.mocks.ai ? "mock" : "real";
  // Cases with `vars.tenant: "seeded"` run against a second tenant with a small known business
  // (seed.ts, T-17-2): the analyst tools need real numbers, and the empty tenant must stay empty
  // for the zero-state cases above.
  const seeded = cases.some((c) => c.vars.tenant === "seeded")
    ? await createSeededEvalTenant()
    : null;
  const results: CaseResult[] = [];

  for (const c of cases) {
    const who = c.vars.tenant === "seeded" && seeded ? seeded : tenant;
    const tools = assistantTools(systemContext(who.companyId));
    const now = new Date();
    const context = await withTenant(who.companyId, (tx) => shopContext(tx, who.companyId, now));
    const res = await callAssistant(
      {
        companyId: who.companyId,
        userId: who.userId,
        kind: "assistant",
        creditKind: "assistant",
        entity: null,
      },
      {
        system: ASSISTANT_PROMPT.system,
        context,
        history: c.vars.history ?? [],
        message: c.vars.message,
        tools,
        now,
      },
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
      results.push({
        ...base,
        plumbingPass: false,
        qualityPass: mode === "real" ? false : null,
        note: res.error,
      });
      continue;
    }

    const gotToolNames = res.events
      .filter(
        (e): e is { type: "tool_call"; name: string; input: Record<string, unknown> } =>
          e.type === "tool_call",
      )
      .map((e) => e.name);
    const toolOk = c.expect.anyTool ? c.expect.anyTool.some((t) => gotToolNames.includes(t)) : true;
    // Only meaningful with a real model: the mock's regex planner (planAssistantCalls) picks a
    // default pair of tools for anything it doesn't recognize, including an injection string used
    // as the message — that's a mock-only artifact, not a prompt-injection failure, so it never
    // gates `plumbingPass` (see `deterministic` below). A real model must not let injected fake
    // tool-call syntax ("<tool_use>...", a fake "Assistant:" turn) add a tool call of its own.
    const allowedTools = c.expect.allowedTools;
    const toolsAllowedOk = allowedTools
      ? gotToolNames.every((t) => allowedTools.includes(t))
      : true;
    const hasText = res.text.trim().length > 0;
    const mustContain = containsAny(res.text, c.expect.mustContainAny);
    const mustNotContain = containsAny(res.text, c.expect.mustNotContainAny);
    const contentOk = (mustContain ?? true) && !(mustNotContain ?? false) && toolsAllowedOk;

    const structuralOk = hasText && toolOk;
    const plumbingPass = structuralOk && (c.expect.deterministic ? contentOk : true);
    const qualityPass =
      mode === "real" || c.expect.deterministic ? structuralOk && contentOk : null;

    const note = [
      `tools: ${gotToolNames.join(", ") || "(none)"}`,
      !toolOk ? `expected one of: ${c.expect.anyTool?.join(", ")}` : null,
      !toolsAllowedOk
        ? `unexpected tool call(s), allowed: [${allowedTools?.join(", ") ?? ""}]`
        : null,
      mustContain === false ? `missing any of: ${c.expect.mustContainAny?.join(" | ")}` : null,
      mustNotContain === true
        ? `contains forbidden text: ${c.expect.mustNotContainAny?.join(" | ")}`
        : null,
    ]
      .filter(Boolean)
      .join("; ");

    results.push({ ...base, plumbingPass, qualityPass, note });
  }

  return { route: "assistant", mode, cases: results };
}
