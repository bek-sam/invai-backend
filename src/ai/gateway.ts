import { ORPCError } from "@orpc/server";
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
import { ASSISTANT_PROMPT, type PromptDef, promptRef } from "./prompts";
import { anthropicProvider } from "./providers/anthropic";
import { mockProvider } from "./providers/mock";
import { openaiProvider } from "./providers/openai";
import {
  AiOutputError,
  type AiProvider,
  AiRefusalError,
  type AssistantFinal,
  type AssistantRun,
  type AssistantStreamEvent,
  type AssistantTool,
  type ProviderAssistantEvent,
} from "./providers/types";
import {
  describeIssues,
  fallbackAnswer,
  MARKET_TOOL_NAMES,
  type TurnToolOutput,
  validateAnswer,
} from "./validators/answer";

/**
 * AI gateway. Every model call goes through here so it is metered per company (ai_jobs +
 * ai_credit_ledger), validated against its schema, logged, and free of buyer personal data.
 * Provider order (decision 0021): Anthropic when ANTHROPIC_API_KEY is set, else OpenAI when
 * OPENAI_API_KEY is set, else the mock (`env.mocks.ai`).
 * See invai-docs/architecture.md section 8.
 */

const log = logger("ai.gateway");

export type AiJobKind = (typeof aiJobs.$inferInsert)["kind"];

/**
 * A sample workspace (T-6-5's `isSampleWorkspace`) never reaches the real model, even when
 * an AI key is set: it always gets the mock provider, so it can never spend the platform's key. See `finishJob` for why the cost check also no longer trusts
 * `env.mocks.ai` alone.
 */
export async function aiProvider(companyId: string): Promise<AiProvider> {
  if (env.mocks.ai) return mockProvider;
  return (await isSampleWorkspace(companyId)) ? mockProvider : realProvider();
}

/**
 * The real provider when AI keys exist: Anthropic wins, OpenAI only without an Anthropic key.
 * With neither key `env.mocks.ai` is true and this isn't reached (tests that clear the flag by
 * hand still get Anthropic, as before decision 0021).
 */
function realProvider(): AiProvider {
  return !env.ANTHROPIC_API_KEY && env.OPENAI_API_KEY ? openaiProvider : anthropicProvider;
}

/** The name shown in an UPSTREAM_FAILED error. */
const PROVIDER_LABEL: Record<AiProvider["name"], string> = {
  anthropic: "Claude",
  openai: "OpenAI",
  mock: "AI",
};

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

function toApiError(err: unknown, provider: AiProvider): unknown {
  const label = PROVIDER_LABEL[provider.name];
  if (err instanceof AiRefusalError) return upstream(label, err.message);
  if (err instanceof AiOutputError) return upstream(label, err.message);
  return err;
}

async function finishJob(
  meta: CallMeta,
  aiJobId: string,
  result: { usage: AssistantFinal["usage"]; model: string; stopReason: string | null },
  output: Record<string, unknown>,
  /** Cents this run already added to the spend counters round by round (T-P7-5). */
  alreadyRecordedCents = 0,
) {
  const credits = tokensToCredits(result.usage);
  // A sample workspace's calls also come back with `model === MOCK_MODEL` (aiProvider() above),
  // so this stays 0 for them regardless of env.mocks.ai, and the spend counters never move.
  // Priced by the model that answered (the niche route runs on Haiku, B-45 price table).
  const costCents = result.model === MOCK_MODEL ? 0 : tokensToCostCents(result.usage, result.model);
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
  // After the commit: a Valkey side effect never runs inside the DB transaction. Only what the
  // rounds have not recorded yet, so the counters end at exactly `costCents` for the run.
  await recordSpend(meta.companyId, Math.max(0, costCents - alreadyRecordedCents));
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
    throw toApiError(err, provider);
  }
}

/** The user's free text (and earlier turns) may contain pasted buyer data; scrub it too. */
export function scrubAssistantRun(run: AssistantRun): AssistantRun {
  return {
    ...run,
    message: stripPii(sanitizeText(run.message)),
    context: run.context == null ? undefined : stripPii(sanitizeText(run.context)),
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
  const outputs: TurnToolOutput[] = [];
  const clean = scrubAssistantRun({ ...run, tools: recordToolOutputs(run.tools, outputs) });
  const aiJobId = await startJob(
    meta,
    { prompt: promptRef(ASSISTANT_PROMPT), message: clean.message.slice(0, 500) },
    provider,
  );
  let text = "";
  const zero = (): AssistantFinal["usage"] => ({ tokensIn: 0, tokensOut: 0, cacheReadTokens: 0 });
  // Usage of finished passes (the first answer, when a regeneration follows) plus the live one.
  let usageDone = zero();
  let usageSoFar = zero();
  const add = (a: AssistantFinal["usage"], b: AssistantFinal["usage"]) => ({
    tokensIn: a.tokensIn + b.tokensIn,
    tokensOut: a.tokensOut + b.tokensOut,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  });
  const track = (u: AssistantFinal["usage"]) => {
    usageSoFar = add(usageDone, u);
  };
  let gen = provider.assistant(clean, track);
  let settled = false;
  // The ai_jobs row is finished (and charged) by a mid-run stop; the catch must not fail it.
  let jobFinished = false;
  // Spend this run already put on the daily counters, and the model of the last round seen.
  let recordedCents = 0;
  let lastModel: string | null = null;

  /**
   * After each real model round (B-115): record the round's spend at once, so a parallel question
   * sees it, then, when the model wants another round, re-check the daily caps and the credits
   * before the runner may send it. Spend is the cumulative cost minus what is already recorded,
   * never a sum of rounded per-round costs. Credits are charged once in finishJob; here the
   * balance hasn't moved, so the check is "what this run used so far + 1 for the next round".
   */
  const afterRound = async (e: Extract<ProviderAssistantEvent, { type: "round" }>) => {
    usageSoFar = add(usageDone, e.usage);
    if (provider.name === "mock" || e.model === MOCK_MODEL) return;
    lastModel = e.model;
    const cum = tokensToCostCents(usageSoFar, e.model);
    if (cum > recordedCents) {
      await recordSpend(meta.companyId, cum - recordedCents);
      recordedCents = cum;
    }
    if (e.stopReason !== "tool_use" && e.stopReason !== "pause_turn") return;
    await assertSpendAvailable(meta.companyId);
    await withTenant(meta.companyId, (tx) =>
      assertCredits(tx, meta.companyId, tokensToCredits(usageSoFar) + 1),
    );
  };

  /**
   * A cap tripped between rounds: close the provider (the runner's `finally` aborts, no request
   * goes out), finish the job with the usage of the rounds made, then let the caller rethrow.
   */
  const stopMidRun = async (err: unknown) => {
    settled = true;
    const dummy: AssistantFinal = { usage: usageSoFar, model: "", stopReason: null };
    await gen.return(dummy).catch(() => undefined);
    const model = lastModel ?? provider.name;
    const stopReason = stopReasonOf(err);
    const credits = await finishJob(
      meta,
      aiJobId,
      { usage: usageSoFar, model, stopReason },
      { text: sanitizeText(text.slice(0, 4000)) },
      recordedCents,
    );
    jobFinished = true;
    log.warn("assistant stopped between rounds", { companyId: meta.companyId, stopReason });
    onSettle?.({ credits, model, aiJobId });
  };

  try {
    // Answer guard (spec market-signals Step 6): once a market tool is called, the answer text is
    // held back, checked against this turn's tool outputs, regenerated once on a failure and
    // otherwise replaced by the tools' own answers. Other turns stream exactly as before.
    let guarded = false;
    let held = "";
    let step = await gen.next();
    while (!step.done) {
      const e = step.value;
      if (e.type === "round") {
        try {
          await afterRound(e);
        } catch (err) {
          await stopMidRun(err);
          throw err;
        }
        step = await gen.next();
        continue;
      }
      if (e.type === "tool_call" && MARKET_TOOL_NAMES.has(e.name)) guarded = true;
      if (e.type === "text" && guarded) held += e.text;
      else {
        if (e.type === "text") text += e.text;
        yield e;
      }
      step = await gen.next();
    }
    let final = step.value;
    if (guarded) {
      const extra = { message: clean.message, context: clean.context };
      let issues = validateAnswer(held, outputs, extra);
      let outcome: "pass" | "regenerated" | "fallback" = "pass";
      if (issues.length) {
        usageDone = add(usageDone, final.usage);
        const retry = {
          ...clean,
          context: `${clean.context ?? ""}\n\n${describeIssues(issues)}`.trim(),
        };
        const firstIssues = issues.map((i) => i.kind);
        held = "";
        // The regeneration is one more model call: re-check the caps first. If they are spent, or
        // trip between its rounds, the turn ends with the tools' own answer instead of an error.
        let capped = false;
        let capReason = "spend_cap";
        try {
          if (provider.name !== "mock") {
            await assertSpendAvailable(meta.companyId);
            await withTenant(meta.companyId, (tx) =>
              assertCredits(tx, meta.companyId, tokensToCredits(usageDone) + 1),
            );
          }
        } catch (err) {
          if (!isCapError(err)) throw err;
          capped = true;
          capReason = stopReasonOf(err);
        }
        if (!capped) {
          gen = provider.assistant(retry, track);
          let r = await gen.next();
          // The second pass re-reads the same tools; its events stay internal (the UI already has
          // the chips and vote cards from the first pass).
          while (!r.done) {
            if (r.value.type === "round") {
              try {
                await afterRound(r.value);
              } catch (err) {
                if (!isCapError(err)) throw err;
                capped = true;
                capReason = stopReasonOf(err);
                await gen
                  .return({ usage: usageSoFar, model: "", stopReason: null })
                  .catch(() => {});
                break;
              }
            } else if (r.value.type === "text") held += r.value.text;
            r = await gen.next();
          }
          if (!capped && r.done) final = { ...r.value, usage: r.value.usage };
        }
        if (capped) {
          // Usage of the second pass so far (none when it never started) is in usageSoFar.
          final = {
            usage: { tokensIn: 0, tokensOut: 0, cacheReadTokens: 0 },
            model: lastModel ?? final.model,
            stopReason: capReason,
          };
          usageDone = usageSoFar;
          held = "";
        }
        issues = capped ? [] : validateAnswer(held, outputs, extra);
        outcome = capped || issues.length ? "fallback" : "regenerated";
        if (capped || issues.length) held = fallbackAnswer(outputs, clean.message);
        log.warn("assistant answer failed the check", {
          companyId: meta.companyId,
          outcome,
          firstIssues,
          secondIssues: issues.map((i) => i.kind),
          ...(capped ? { skipped: capReason } : {}),
        });
      }
      log.info("assistant answer check", { companyId: meta.companyId, outcome });
      text += held;
      if (held) yield { type: "text", text: held };
    }
    settled = true;
    const usage = add(usageDone, final.usage);
    const credits = await finishJob(
      meta,
      aiJobId,
      { ...final, usage },
      { text: sanitizeText(text.slice(0, 4000)) },
      recordedCents,
    );
    const result = { credits, model: final.model, aiJobId };
    onSettle?.(result);
    return result;
  } catch (err) {
    settled = true;
    if (!jobFinished) await failJob(meta.companyId, aiJobId, err);
    throw err;
  } finally {
    if (!settled) {
      const dummy: AssistantFinal = { usage: usageSoFar, model: "", stopReason: null };
      await gen.return(dummy).catch(() => undefined);
      const model = provider.name === "mock" ? MOCK_MODEL : (lastModel ?? provider.name);
      const credits = await finishJob(
        meta,
        aiJobId,
        { usage: usageSoFar, model, stopReason: "aborted" },
        { text: sanitizeText(text.slice(0, 4000)) },
        recordedCents,
      );
      onSettle?.({ credits, model, aiJobId });
    }
  }
}

/** The two typed stops a between-rounds check can raise (breaker.ts, credits.ts). */
function isCapError(err: unknown): boolean {
  return (
    err instanceof ORPCError &&
    (err.code === "AI_SPEND_CAP_REACHED" || err.code === "CREDITS_EXHAUSTED")
  );
}

/** `ai_jobs.stop_reason` for a run stopped between rounds. */
function stopReasonOf(err: unknown): string {
  return err instanceof ORPCError && err.code === "CREDITS_EXHAUSTED"
    ? "credits_exhausted"
    : "spend_cap";
}

/** Keeps each tool result of the turn (before the data envelope) for the answer check. */
function recordToolOutputs(tools: AssistantTool[], into: TurnToolOutput[]): AssistantTool[] {
  return tools.map((t) => ({
    ...t,
    run: async (input) => {
      const out = await t.run(input);
      into.push({
        name: t.name,
        data: out.data,
        summary: out.summary,
        answer: out.answer,
        meta: out.meta,
        forbiddenTerms: out.forbiddenTerms,
      });
      // Internal only: never sent to the model or the web.
      const { forbiddenTerms: _f, ...rest } = out;
      return rest;
    },
  }));
}

export { AiOutputError, AiRefusalError };
