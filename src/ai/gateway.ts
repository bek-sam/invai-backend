import { eq } from "drizzle-orm";
import { withTenant } from "../db/client";
import { aiJobs } from "../db/schema";
import { env } from "../env";
import { upstream } from "../lib/errors";
import { logger } from "../lib/log";
import { sanitizeDeep, sanitizeText } from "../lib/text-safety";
import { isSampleWorkspace } from "../modules/tenancy/demo-flag";
import { assertSpendAvailable, recordSpend } from "./breaker";
import { assertCredits, type CreditKind, chargeCredits } from "./credits";
import { MOCK_MODEL, tokensToCostCents, tokensToCredits } from "./models";
import { stripPii, stripPiiDeep } from "./pii";
import { type PromptDef, promptRef } from "./prompts";
import { anthropicProvider } from "./providers/anthropic";
import { mockProvider } from "./providers/mock";
import {
  AiOutputError,
  type AiProvider,
  AiRefusalError,
  type AssistantFinal,
  type AssistantRun,
  type AssistantStreamEvent,
  type AssistantTool,
} from "./providers/types";

/**
 * AI gateway. Every Claude call goes through here so it is metered per company (ai_jobs +
 * ai_credit_ledger), validated against its schema, logged, and free of buyer personal data.
 * The mock provider is used automatically when ANTHROPIC_API_KEY is missing (`env.mocks.ai`).
 * See invai-docs/architecture.md section 8.
 */

const log = logger("ai.gateway");

export type AiJobKind = (typeof aiJobs.$inferInsert)["kind"];

/**
 * A sample workspace (T-6-5's `isSampleWorkspace`) never reaches the real model, even when
 * `ANTHROPIC_API_KEY` is set: it always gets the mock provider, so it can never spend the
 * platform's Anthropic key. See `finishJob` for why the cost check also no longer trusts
 * `env.mocks.ai` alone.
 */
export async function aiProvider(companyId: string): Promise<AiProvider> {
  if (env.mocks.ai) return mockProvider;
  return (await isSampleWorkspace(companyId)) ? mockProvider : anthropicProvider;
}

type CallMeta = {
  companyId: string;
  userId: string | null;
  kind: AiJobKind;
  creditKind: CreditKind;
  entity?: { type: string; id: string } | null;
};

async function startJob(meta: CallMeta, input: Record<string, unknown>, provider: AiProvider) {
  return withTenant(meta.companyId, async (tx) => {
    await assertCredits(tx, meta.companyId);
    const [row] = await tx
      .insert(aiJobs)
      .values({
        companyId: meta.companyId,
        kind: meta.kind,
        status: "running",
        provider: provider.name,
        input,
        entityType: meta.entity?.type ?? null,
        entityId: meta.entity?.id ?? null,
        createdBy: meta.userId,
        startedAt: new Date(),
      })
      .returning({ id: aiJobs.id });
    if (!row) throw new Error("ai_jobs insert failed");
    return row.id;
  });
}

async function failJob(companyId: string, aiJobId: string, err: unknown) {
  await withTenant(companyId, (tx) =>
    tx
      .update(aiJobs)
      .set({
        status: "failed",
        error: sanitizeText(String((err as Error).message)),
        finishedAt: new Date(),
      })
      .where(eq(aiJobs.id, aiJobId)),
  ).catch((e) => log.error("could not mark ai job failed", { error: (e as Error).message }));
}

/*
 * NUL/control-character/lone-surrogate stripping used to live here alone. T-8-6 moved the regex
 * and `sanitizeText`/`sanitizeDeep` into `../lib/text-safety` so the oRPC input boundary and the
 * webhook/CSV order-import pipeline can reuse the exact same logic instead of growing their own
 * copies; both are re-exported here so every existing `from "./gateway"` import keeps working.
 * The gateway still applies them to AI vars and assistant input/output (defense in depth, OI-5).
 */
export { sanitizeDeep, sanitizeText };

function toApiError(err: unknown): unknown {
  if (err instanceof AiRefusalError) return upstream("Claude", err.message);
  if (err instanceof AiOutputError) return upstream("Claude", err.message);
  return err;
}

async function finishJob(
  meta: CallMeta,
  aiJobId: string,
  result: { usage: AssistantFinal["usage"]; model: string; stopReason: string | null },
  output: Record<string, unknown>,
) {
  const credits = tokensToCredits(result.usage);
  // A sample workspace's calls also come back with `model === MOCK_MODEL` (aiProvider() above),
  // so this stays 0 for them regardless of env.mocks.ai, and the spend counters never move.
  const costCents = result.model === MOCK_MODEL ? 0 : tokensToCostCents(result.usage);
  await withTenant(meta.companyId, async (tx) => {
    await tx
      .update(aiJobs)
      .set({
        status: "done",
        model: result.model,
        output,
        tokensIn: result.usage.tokensIn,
        tokensOut: result.usage.tokensOut,
        cacheReadTokens: result.usage.cacheReadTokens,
        costCents,
        credits,
        stopReason: result.stopReason,
        finishedAt: new Date(),
      })
      .where(eq(aiJobs.id, aiJobId));
    await chargeCredits(tx, {
      companyId: meta.companyId,
      kind: meta.creditKind,
      credits,
      model: result.model,
      usage: result.usage,
      aiJobId,
      ref: meta.entity ?? null,
      userId: meta.userId,
    });
  });
  // After the commit: a Valkey side effect never runs inside the DB transaction.
  await recordSpend(meta.companyId, costCents);
  return credits;
}

/**
 * The spend breaker (breaker.ts) runs before every real provider call. The mock never spends, so
 * a keyless environment or a sample workspace never reads the counters.
 */
async function assertSpend(meta: CallMeta, provider: AiProvider) {
  if (provider.name !== "mock") await assertSpendAvailable(meta.companyId);
}

/**
 * Assistant tool results are untrusted data (design names, labels, anything a shop typed). Each
 * result goes to the model as a JSON envelope labelled with its source, which the assistant's
 * system prompt (DATA_RULE) says to treat as data only. Applied here, once, for every tool.
 */
export function isolateToolResults(tools: AssistantTool[]): AssistantTool[] {
  return tools.map((t) => ({
    ...t,
    run: async (input) => {
      const out = await t.run(input);
      return { ...out, data: { source: `tool_result:${t.name}`, data: out.data } };
    },
  }));
}

/**
 * One structured call: credits check, PII scrub, provider call with the prompt's schema,
 * `stop_reason` checked by the provider, ai_jobs row + credit ledger entry written.
 */
export async function runStructured<V, O>(
  meta: CallMeta,
  prompt: PromptDef<V, O>,
  vars: V,
): Promise<{ output: O; credits: number; model: string; aiJobId: string }> {
  const provider = await aiProvider(meta.companyId);
  await assertSpend(meta, provider);
  const clean = stripPiiDeep(sanitizeDeep(vars));
  const aiJobId = await startJob(
    meta,
    { prompt: promptRef(prompt), vars: clean as Record<string, unknown> },
    provider,
  );
  try {
    const res = await provider.structured(prompt, clean);
    const output = sanitizeDeep(res.output);
    const credits = await finishJob(meta, aiJobId, res, output as Record<string, unknown>);
    return { output, credits, model: res.model, aiJobId };
  } catch (err) {
    await failJob(meta.companyId, aiJobId, err);
    log.warn("structured call failed", { prompt: prompt.id, error: (err as Error).message });
    throw toApiError(err);
  }
}

/** The user's free text (and earlier turns) may contain pasted buyer data; scrub it too. */
export function scrubAssistantRun(run: AssistantRun): AssistantRun {
  return {
    ...run,
    message: stripPii(sanitizeText(run.message)),
    history: run.history.map((h) => ({ ...h, text: stripPii(sanitizeText(h.text)) })),
    tools: isolateToolResults(run.tools),
  };
}

/**
 * The tool-using assistant, streamed. Yields text deltas and tool events; returns usage and the
 * credits charged. Throws CREDITS_EXHAUSTED before any model call when the balance is empty.
 *
 * `onSettle` fires exactly once, with the real charged credits, however this generator ends:
 * normal completion, a failure, or being torn down early by `.return()` (the caller's own caller
 * — ultimately the HTTP client — disconnected). A manual `while (!step.done)` loop over a nested
 * generator does not close it the way `for await` would, so the disconnect path below closes the
 * provider's generator itself and still finishes (and charges for) the ai_jobs row, instead of
 * leaving it stuck "running" with tokens Anthropic already billed left uncredited. `onSettle`
 * (rather than this generator's own return value) is how that real number reaches a caller that
 * only sees the placeholder it passed to `.return()` — a generator cannot rewrite its own
 * `.return()` value from a `finally` without also risking swallowing a real thrown error.
 */
export async function* runAssistant(
  meta: CallMeta,
  run: AssistantRun,
  onSettle?: (result: { credits: number; model: string; aiJobId: string }) => void,
): AsyncGenerator<AssistantStreamEvent, { credits: number; model: string; aiJobId: string }> {
  const provider = await aiProvider(meta.companyId);
  await assertSpend(meta, provider);
  const clean = scrubAssistantRun(run);
  const aiJobId = await startJob(meta, { message: clean.message.slice(0, 500) }, provider);
  let text = "";
  let usageSoFar: AssistantFinal["usage"] = { tokensIn: 0, tokensOut: 0, cacheReadTokens: 0 };
  const gen = provider.assistant(clean, (u) => {
    usageSoFar = u;
  });
  let settled = false;
  try {
    let step = await gen.next();
    while (!step.done) {
      if (step.value.type === "text") text += step.value.text;
      yield step.value;
      step = await gen.next();
    }
    settled = true;
    const credits = await finishJob(meta, aiJobId, step.value, {
      text: sanitizeText(text.slice(0, 4000)),
    });
    const result = { credits, model: step.value.model, aiJobId };
    onSettle?.(result);
    return result;
  } catch (err) {
    settled = true;
    await failJob(meta.companyId, aiJobId, err);
    throw err;
  } finally {
    if (!settled) {
      const dummy: AssistantFinal = { usage: usageSoFar, model: "", stopReason: null };
      await gen.return(dummy).catch(() => undefined);
      const model = provider.name === "mock" ? MOCK_MODEL : provider.name;
      const credits = await finishJob(
        meta,
        aiJobId,
        { usage: usageSoFar, model, stopReason: "aborted" },
        { text: sanitizeText(text.slice(0, 4000)) },
      );
      onSettle?.({ credits, model, aiJobId });
    }
  }
}

export { AiOutputError, AiRefusalError };
