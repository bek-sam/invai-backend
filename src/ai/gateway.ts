import { eq } from "drizzle-orm";
import { withTenant } from "../db/client";
import { aiJobs } from "../db/schema";
import { env } from "../env";
import { upstream } from "../lib/errors";
import { logger } from "../lib/log";
import { assertCredits, type CreditKind, chargeCredits } from "./credits";
import { tokensToCostCents, tokensToCredits } from "./models";
import { stripPiiDeep } from "./pii";
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
} from "./providers/types";

/**
 * AI gateway. Every Claude call goes through here so it is metered per company (ai_jobs +
 * ai_credit_ledger), validated against its schema, logged, and free of buyer personal data.
 * The mock provider is used automatically when ANTHROPIC_API_KEY is missing (`env.mocks.ai`).
 * See invai-docs/architecture.md section 8.
 */

const log = logger("ai.gateway");

export type AiJobKind = (typeof aiJobs.$inferInsert)["kind"];

export function aiProvider(): AiProvider {
  return env.mocks.ai ? mockProvider : anthropicProvider;
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
      .set({ status: "failed", error: (err as Error).message, finishedAt: new Date() })
      .where(eq(aiJobs.id, aiJobId)),
  ).catch((e) => log.error("could not mark ai job failed", { error: (e as Error).message }));
}

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
        costCents: env.mocks.ai ? 0 : tokensToCostCents(result.usage),
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
  return credits;
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
  const provider = aiProvider();
  const clean = stripPiiDeep(vars);
  const aiJobId = await startJob(
    meta,
    { prompt: promptRef(prompt), vars: clean as Record<string, unknown> },
    provider,
  );
  try {
    const res = await provider.structured(prompt, clean);
    const credits = await finishJob(meta, aiJobId, res, res.output as Record<string, unknown>);
    return { output: res.output, credits, model: res.model, aiJobId };
  } catch (err) {
    await failJob(meta.companyId, aiJobId, err);
    log.warn("structured call failed", { prompt: prompt.id, error: (err as Error).message });
    throw toApiError(err);
  }
}

/**
 * The tool-using assistant, streamed. Yields text deltas and tool events; returns usage and the
 * credits charged. Throws CREDITS_EXHAUSTED before any model call when the balance is empty.
 */
export async function* runAssistant(
  meta: CallMeta,
  run: AssistantRun,
): AsyncGenerator<AssistantStreamEvent, { credits: number; model: string; aiJobId: string }> {
  const provider = aiProvider();
  const aiJobId = await startJob(meta, { message: run.message.slice(0, 500) }, provider);
  let text = "";
  try {
    const gen = provider.assistant({ ...run, message: run.message });
    let step = await gen.next();
    while (!step.done) {
      if (step.value.type === "text") text += step.value.text;
      yield step.value;
      step = await gen.next();
    }
    const credits = await finishJob(meta, aiJobId, step.value, { text: text.slice(0, 4000) });
    return { credits, model: step.value.model, aiJobId };
  } catch (err) {
    await failJob(meta.companyId, aiJobId, err);
    throw err;
  }
}

export { AiOutputError, AiRefusalError };
