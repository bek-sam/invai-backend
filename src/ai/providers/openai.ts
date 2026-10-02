import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type {
  FunctionTool,
  Response,
  ResponseCreateParamsBase,
  ResponseInputItem,
  ResponseUsage,
} from "openai/resources/responses/responses";
import { z } from "zod";
import { env } from "../../env";
import { logger } from "../../lib/log";
import { OPENAI_ROUTES } from "../models";
import { stripPii } from "../pii";
import { ASSISTANT_MAX_ITERATIONS, type PromptDef } from "../prompts";
import {
  AiOutputError,
  type AiProvider,
  AiRefusalError,
  type AssistantFinal,
  type AssistantRun,
  type AssistantTool,
  type ImageInput,
  type ProviderAssistantEvent,
  type StructuredResult,
  type TokenUsage,
} from "./types";

/*
 * OpenAI provider (decision 0021), used when ANTHROPIC_API_KEY is unset and OPENAI_API_KEY is set.
 * Responses API, per-route model and reasoning effort (models.ts OPENAI_ROUTES), `store: false`
 * on every request (nothing kept at OpenAI for later retrieval), the prompt's Zod schema sent as a
 * strict JSON schema and the answer parsed with that same schema, and the response status checked
 * before any output is read. Stop reasons are mapped onto the Anthropic vocabulary the gateway and
 * `ai_jobs.stop_reason` already use: end_turn, tool_use, max_tokens, refusal.
 *
 * PII: the gateway scrubs vars (stripPiiDeep) and the assistant run (scrubAssistantRun) before
 * they reach here; the user text is scrubbed once more below, as the Anthropic provider does.
 */

const log = logger("ai.openai");

let defaultClient: OpenAI | null = null;
function openai(): OpenAI {
  // The SDK would fall back to process.env.OPENAI_API_KEY (filled from .env outside production)
  // when env drops the key under test; only env's resolved key may build a client (S-49).
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");
  defaultClient ??= new OpenAI({ apiKey, maxRetries: 2, timeout: 120_000 });
  return defaultClient;
}

/**
 * OpenAI counts cached tokens inside `input_tokens`; InvAI's TokenUsage keeps them apart (as the
 * Anthropic usage block does), so tokensIn is the uncached part. Cache writes stay in tokensIn at
 * the input rate, like the Anthropic provider does with cache creation.
 */
export function usageOf(u: ResponseUsage | null | undefined): TokenUsage {
  const cached = u?.input_tokens_details?.cached_tokens ?? 0;
  return {
    tokensIn: Math.max(0, (u?.input_tokens ?? 0) - cached),
    tokensOut: u?.output_tokens ?? 0,
    cacheReadTokens: cached,
  };
}

type OutputItem = Response["output"][number];
type FunctionCall = Extract<OutputItem, { type: "function_call" }>;

function refusalOf(res: Response): string | null {
  for (const item of res.output) {
    if (item.type !== "message") continue;
    for (const c of item.content) if (c.type === "refusal") return c.refusal;
  }
  return null;
}

function outputText(res: Response): string {
  return res.output
    .flatMap((item) =>
      item.type === "message"
        ? item.content.flatMap((c) => (c.type === "output_text" ? [c.text] : []))
        : [],
    )
    .join("");
}

/** The InvAI stop reason for a finished response (see the header comment). */
export function stopReasonOf(res: Response): string {
  if (refusalOf(res) != null) return "refusal";
  if (res.status === "incomplete") {
    const why = res.incomplete_details?.reason;
    if (why === "content_filter") return "refusal";
    return "max_tokens";
  }
  if (res.output.some((i) => i.type === "function_call")) return "tool_use";
  return "end_turn";
}

/** Throws before any output is read: a refusal, a content filter stop, a cut-off, a failure. */
function checkStop(res: Response) {
  if (res.status === "failed") {
    throw new AiOutputError(`Model call failed${res.error?.code ? ` (${res.error.code})` : ""}`);
  }
  if (res.status === "incomplete" && res.incomplete_details?.reason === "content_filter") {
    throw new AiRefusalError("content_filter");
  }
  if (refusalOf(res) != null) throw new AiRefusalError(null);
  if (res.status === "incomplete") {
    throw new AiOutputError("Model output was cut off (max_output_tokens)");
  }
}

/** The output items a stateless (`store: false`) request must send back on the next round. */
function replayable(output: OutputItem[]): ResponseInputItem[] {
  return output.filter(
    (i): i is Extract<OutputItem, { type: "message" | "function_call" | "reasoning" }> =>
      i.type === "message" || i.type === "function_call" || i.type === "reasoning",
  ) as ResponseInputItem[];
}

/** A tool's parameters as JSON schema. Not strict: the tool's own Zod schema validates input. */
function toolDef(t: AssistantTool): FunctionTool {
  const { $schema: _s, ...parameters } = z.toJSONSchema(t.input) as Record<string, unknown>;
  return { type: "function", name: t.name, description: t.description, parameters, strict: false };
}

export function createOpenAiProvider(client: () => OpenAI): AiProvider {
  async function structured<V, O>(
    prompt: PromptDef<V, O>,
    vars: V,
    images?: ImageInput[],
  ): Promise<StructuredResult<O>> {
    const route = OPENAI_ROUTES[prompt.route];
    const text = stripPii(prompt.user(vars));
    const res = await client().responses.create({
      model: route.model,
      instructions: prompt.system,
      input: [
        {
          role: "user",
          // Images first, then the text; a text-only route keeps its plain string.
          content: images?.length
            ? [
                ...images.map((img) => ({
                  type: "input_image" as const,
                  detail: "auto" as const,
                  image_url: `data:${img.mediaType};base64,${img.data}`,
                })),
                { type: "input_text" as const, text },
              ]
            : text,
        },
      ],
      max_output_tokens: route.maxTokens,
      reasoning: { effort: route.effort },
      text: { format: zodTextFormat(prompt.schema, prompt.id) },
      prompt_cache_key: `invai:${prompt.id}`,
      store: false,
      stream: false,
    });
    checkStop(res);
    let json: unknown;
    try {
      json = JSON.parse(outputText(res));
    } catch {
      throw new AiOutputError("Model output was not JSON");
    }
    const parsed = prompt.schema.safeParse(json);
    if (!parsed.success) throw new AiOutputError("Model output did not match the schema");
    return {
      output: parsed.data,
      usage: usageOf(res.usage),
      model: res.model,
      stopReason: stopReasonOf(res),
    };
  }

  async function* assistant(
    run: AssistantRun,
    onUsage?: (usage: TokenUsage) => void,
  ): AsyncGenerator<ProviderAssistantEvent, AssistantFinal> {
    const route = OPENAI_ROUTES.assistant;
    const byName = new Map(run.tools.map((t) => [t.name, t]));
    const input: ResponseInputItem[] = [
      // Shop context after the stable instructions, so the cached prefix stays the same for all shops.
      ...(run.context ? [{ role: "developer" as const, content: run.context }] : []),
      ...run.history.map((m) => ({ role: m.role, content: stripPii(m.text) })),
      {
        role: "user" as const,
        content: `${stripPii(run.message)}\n\n(Current time: ${run.now.toISOString()})`,
      },
    ];
    const common: ResponseCreateParamsBase = {
      model: route.model,
      instructions: run.system,
      max_output_tokens: route.maxTokens,
      reasoning: { effort: route.effort },
      tools: run.tools.map(toolDef),
      prompt_cache_key: "invai:assistant",
      include: ["reasoning.encrypted_content"],
      store: false,
    };

    const total: TokenUsage = { tokensIn: 0, tokensOut: 0, cacheReadTokens: 0 };
    let last: { model: string; stopReason: string | null } = {
      model: route.model,
      stopReason: null,
    };
    for (let round = 1; round <= ASSISTANT_MAX_ITERATIONS; round++) {
      // The request goes out only when the gateway pulls this generator after the previous round
      // event, so a spend cap tripped in between stops the run before another call (T-P7-5).
      const stream = await client().responses.create({ ...common, input, stream: true });
      let res: Response | null = null;
      for await (const ev of stream) {
        if (ev.type === "response.output_text.delta") yield { type: "text", text: ev.delta };
        else if (
          ev.type === "response.completed" ||
          ev.type === "response.incomplete" ||
          ev.type === "response.failed"
        ) {
          res = ev.response;
        } else if (ev.type === "error") {
          throw new AiOutputError(`Model stream error${ev.code ? ` (${ev.code})` : ""}`);
        }
      }
      if (!res) throw new AiOutputError("Model stream ended without a response");
      const u = usageOf(res.usage);
      total.tokensIn += u.tokensIn;
      total.tokensOut += u.tokensOut;
      total.cacheReadTokens += u.cacheReadTokens;
      last = { model: res.model, stopReason: stopReasonOf(res) };
      onUsage?.({ ...total });
      checkStop(res);
      yield { type: "round", usage: { ...total }, model: res.model, stopReason: last.stopReason };

      const calls = res.output.filter((i): i is FunctionCall => i.type === "function_call");
      if (!calls.length || round === ASSISTANT_MAX_ITERATIONS) break;
      input.push(...replayable(res.output));
      for (const call of calls) {
        const out = yield* runTool(byName.get(call.name), call);
        input.push({ type: "function_call_output", call_id: call.call_id, output: out });
      }
    }
    return { usage: total, model: last.model, stopReason: last.stopReason };
  }

  return { name: "openai", structured, assistant };
}

/** Runs one tool call: arguments checked against the tool's Zod schema, events for the UI. */
async function* runTool(
  tool: AssistantTool | undefined,
  call: FunctionCall,
): AsyncGenerator<ProviderAssistantEvent, string> {
  if (!tool) return JSON.stringify({ error: `Unknown tool ${call.name}` });
  let args: unknown;
  try {
    args = JSON.parse(call.arguments || "{}");
  } catch {
    return JSON.stringify({ error: "Arguments were not valid JSON" });
  }
  const parsed = tool.input.safeParse(args);
  if (!parsed.success) {
    return JSON.stringify({ error: "Invalid arguments", issues: z.prettifyError(parsed.error) });
  }
  const input = parsed.data as Record<string, unknown>;
  yield { type: "tool_call", name: tool.name, input };
  try {
    const out = await tool.run(input);
    yield { type: "tool_result", name: tool.name, summary: out.summary, meta: out.meta };
    return JSON.stringify(out.data);
  } catch (err) {
    log.warn("assistant tool failed", { tool: tool.name, error: (err as Error).message });
    return JSON.stringify({ error: "The tool failed. Answer without it or try another tool." });
  }
}

export const openaiProvider: AiProvider = createOpenAiProvider(openai);
