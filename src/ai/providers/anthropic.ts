import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat, betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { env } from "../../env";
import { REFUSAL_FALLBACK, ROUTES } from "../models";
import { stripPii } from "../pii";
import { ASSISTANT_PROMPT, type PromptDef } from "../prompts";
import {
  AiOutputError,
  type AiProvider,
  AiRefusalError,
  type AssistantFinal,
  type AssistantRun,
  type AssistantStreamEvent,
  type StructuredResult,
  type TokenUsage,
} from "./types";

/*
 * Claude API provider. Every request: adaptive thinking, per-route effort (models.ts), the stable
 * system prefix cached with cache_control, the server-side refusal fallback, and an explicit
 * `stop_reason` check before any output is read.
 */

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  client ??= new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 2 });
  return client;
}

function usageOf(u: {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}): TokenUsage {
  return {
    tokensIn: u.input_tokens + (u.cache_creation_input_tokens ?? 0),
    tokensOut: u.output_tokens,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
  };
}

function checkStop(
  stopReason: string | null,
  stopDetails: { category?: string | null } | null | undefined,
) {
  if (stopReason === "refusal") throw new AiRefusalError(stopDetails?.category ?? null);
  if (stopReason === "max_tokens") throw new AiOutputError("Model output was cut off (max_tokens)");
}

async function structured<V, O>(prompt: PromptDef<V, O>, vars: V): Promise<StructuredResult<O>> {
  const route = ROUTES[prompt.route];
  const res = await anthropic().beta.messages.parse({
    model: route.model,
    max_tokens: route.maxTokens,
    thinking: { type: "adaptive" },
    output_config: { effort: route.effort, format: betaZodOutputFormat(prompt.schema) },
    system: [{ type: "text", text: prompt.system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: stripPii(prompt.user(vars)) }],
    betas: [...REFUSAL_FALLBACK.betas],
    fallbacks: REFUSAL_FALLBACK.fallbacks,
  });
  checkStop(res.stop_reason, res.stop_details);
  if (res.parsed_output == null) throw new AiOutputError("Model output did not match the schema");
  return {
    output: res.parsed_output as O,
    usage: usageOf(res.usage),
    model: res.model,
    stopReason: res.stop_reason,
  };
}

async function* assistant(run: AssistantRun): AsyncGenerator<AssistantStreamEvent, AssistantFinal> {
  const route = ROUTES.assistant;
  const pending: AssistantStreamEvent[] = [];
  const tools = run.tools.map((t) =>
    betaZodTool({
      name: t.name,
      description: t.description,
      inputSchema: t.input,
      run: async (input) => {
        pending.push({ type: "tool_call", name: t.name, input: input as Record<string, unknown> });
        const out = await t.run(input as Record<string, unknown>);
        pending.push({ type: "tool_result", name: t.name, summary: out.summary });
        return JSON.stringify(out.data);
      },
    }),
  );
  const runner = anthropic().beta.messages.toolRunner({
    model: route.model,
    max_tokens: route.maxTokens,
    max_iterations: 8,
    stream: true,
    thinking: { type: "adaptive" },
    output_config: { effort: route.effort },
    system: [{ type: "text", text: ASSISTANT_PROMPT.system, cache_control: { type: "ephemeral" } }],
    messages: [
      ...run.history.map((m) => ({ role: m.role, content: stripPii(m.text) })),
      {
        role: "user" as const,
        content: `${stripPii(run.message)}\n\n(Current time: ${run.now.toISOString()})`,
      },
    ],
    tools,
    betas: [...REFUSAL_FALLBACK.betas],
    fallbacks: REFUSAL_FALLBACK.fallbacks,
  });

  const total: TokenUsage = { tokensIn: 0, tokensOut: 0, cacheReadTokens: 0 };
  let last: { model: string; stopReason: string | null } = { model: route.model, stopReason: null };
  for await (const stream of runner) {
    while (pending.length) yield pending.shift() as AssistantStreamEvent;
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        yield { type: "text", text: event.delta.text };
      }
    }
    const message = await stream.finalMessage();
    const u = usageOf(message.usage);
    total.tokensIn += u.tokensIn;
    total.tokensOut += u.tokensOut;
    total.cacheReadTokens += u.cacheReadTokens;
    last = { model: message.model, stopReason: message.stop_reason };
    checkStop(message.stop_reason, message.stop_details);
  }
  while (pending.length) yield pending.shift() as AssistantStreamEvent;
  return { usage: total, model: last.model, stopReason: last.stopReason };
}

export const anthropicProvider: AiProvider = { name: "anthropic", structured, assistant };
