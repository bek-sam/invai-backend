import { env } from "../../src/env";

/**
 * Which provider an eval run reaches, mirroring the gateway's order (decision 0021): Anthropic
 * when ANTHROPIC_API_KEY is set, else OpenAI, else the mock. The eval tenant is never a sample
 * workspace, so it gets the real provider whenever a key exists.
 */
export type EvalMode = "mock" | "anthropic" | "openai";

export function evalMode(): EvalMode {
  if (env.mocks.ai) return "mock";
  return !env.ANTHROPIC_API_KEY && env.OPENAI_API_KEY ? "openai" : "anthropic";
}

/** A line for the harness header. Never prints a key. */
export function describeMode(mode: EvalMode = evalMode()): string {
  return mode === "mock" ? "mock (no ANTHROPIC_API_KEY or OPENAI_API_KEY)" : mode;
}
