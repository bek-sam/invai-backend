import { eq } from "drizzle-orm";
import type { CreditKind } from "../../src/ai/credits";
import type { AiJobKind } from "../../src/ai/gateway";
import { runAssistant, runStructured } from "../../src/ai/gateway";
import { MOCK_MODEL } from "../../src/ai/models";
import type { PromptDef } from "../../src/ai/prompts";
import type { AssistantRun, AssistantStreamEvent } from "../../src/ai/providers/types";
import { withTenant } from "../../src/db/client";
import { aiJobs } from "../../src/db/schema";

/*
 * Thin wrapper around the real gateway (gateway.ts is read-only for this card — import only):
 * measures wall latency, then reads the ai_jobs row `finishJob` wrote for the cost/token numbers
 * eval-template.md's metrics table asks for. Never throws: a failed call comes back as a result
 * with `error` set, so one bad case doesn't stop the run.
 */

export type CallMeta = {
  companyId: string;
  userId: string | null;
  kind: AiJobKind;
  creditKind: CreditKind;
  entity?: { type: string; id: string } | null;
};

export type MeteredResult<O> = {
  output: O | null;
  error: string | null;
  model: string;
  latencyMs: number;
  costCents: number;
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
};

async function jobCost(companyId: string, aiJobId: string) {
  const [row] = await withTenant(companyId, (tx) =>
    tx
      .select({
        costCents: aiJobs.costCents,
        tokensIn: aiJobs.tokensIn,
        tokensOut: aiJobs.tokensOut,
        cacheReadTokens: aiJobs.cacheReadTokens,
      })
      .from(aiJobs)
      .where(eq(aiJobs.id, aiJobId)),
  );
  return row ?? { costCents: 0, tokensIn: 0, tokensOut: 0, cacheReadTokens: 0 };
}

export async function callStructured<V, O>(
  meta: CallMeta,
  prompt: PromptDef<V, O>,
  vars: V,
): Promise<MeteredResult<O>> {
  const startedAt = Date.now();
  try {
    const res = await runStructured(meta, prompt, vars);
    const latencyMs = Date.now() - startedAt;
    const cost = await jobCost(meta.companyId, res.aiJobId);
    return { output: res.output, error: null, model: res.model, latencyMs, ...cost };
  } catch (err) {
    return {
      output: null,
      error: (err as Error).message,
      model: MOCK_MODEL,
      latencyMs: Date.now() - startedAt,
      costCents: 0,
      tokensIn: 0,
      tokensOut: 0,
      cacheReadTokens: 0,
    };
  }
}

export type AssistantCallResult = {
  events: AssistantStreamEvent[];
  text: string;
  error: string | null;
  model: string;
  latencyMs: number;
  costCents: number;
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
};

export async function callAssistant(
  meta: CallMeta,
  run: AssistantRun,
): Promise<AssistantCallResult> {
  const startedAt = Date.now();
  const events: AssistantStreamEvent[] = [];
  let text = "";
  try {
    const gen = runAssistant(meta, run);
    let step = await gen.next();
    while (!step.done) {
      events.push(step.value);
      if (step.value.type === "text") text += step.value.text;
      step = await gen.next();
    }
    const latencyMs = Date.now() - startedAt;
    const cost = await jobCost(meta.companyId, step.value.aiJobId);
    return { events, text, error: null, model: step.value.model, latencyMs, ...cost };
  } catch (err) {
    return {
      events,
      text,
      error: (err as Error).message,
      model: MOCK_MODEL,
      latencyMs: Date.now() - startedAt,
      costCents: 0,
      tokensIn: 0,
      tokensOut: 0,
      cacheReadTokens: 0,
    };
  }
}
