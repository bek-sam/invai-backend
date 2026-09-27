import type { z } from "zod";
import type { PromptDef } from "../prompts";

export type TokenUsage = { tokensIn: number; tokensOut: number; cacheReadTokens: number };

export type StructuredResult<O> = {
  output: O;
  usage: TokenUsage;
  model: string;
  stopReason: string | null;
};

/** A read-only, company-scoped assistant tool. `run` opens its own tenant transaction. */
export type AssistantTool = {
  name: string;
  description: string;
  input: z.ZodObject;
  run: (input: Record<string, unknown>) => Promise<ToolOutput>;
};

export type ToolOutput = {
  /** JSON-serializable result handed to the model. */
  data: unknown;
  /** One line for the UI (`tool_result` event). */
  summary: string;
  /** A plain-language sentence the mock provider can use in its answer. */
  answer: string;
};

export type AssistantStreamEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; name: string; summary: string };

export type AssistantFinal = { usage: TokenUsage; model: string; stopReason: string | null };

export type AssistantRun = {
  /** The byte-stable, cached system prefix (ASSISTANT_PROMPT.system). Never shop data. */
  system: string;
  /**
   * Per-shop context (time zone, today, connected channels, currency), sent as a second system
   * block after the cached prefix so the prefix stays identical across shops.
   */
  context?: string;
  history: { role: "user" | "assistant"; text: string }[];
  message: string;
  tools: AssistantTool[];
  /** "Today" in the shop's terms, so relative periods resolve deterministically. */
  now: Date;
};

export interface AiProvider {
  name: "anthropic" | "mock";
  structured<V, O>(prompt: PromptDef<V, O>, vars: V): Promise<StructuredResult<O>>;
  /**
   * `onUsage` is called with the running token total after each completed turn (before the final
   * one), so a caller that tears this generator down early (its own caller disconnected) can still
   * charge for what was actually billed instead of nothing.
   */
  assistant(
    run: AssistantRun,
    onUsage?: (usage: TokenUsage) => void,
  ): AsyncGenerator<AssistantStreamEvent, AssistantFinal>;
}

/** The model declined (stop_reason `refusal`, after the server-side fallback also declined). */
export class AiRefusalError extends Error {
  constructor(public category: string | null) {
    super(`The model declined this request${category ? ` (${category})` : ""}`);
  }
}

/** Output did not parse or was cut off (`max_tokens`). */
export class AiOutputError extends Error {}
