import { env } from "../../src/env";

/**
 * Which provider an eval run reaches, mirroring the gateway's order (decision 0021): Anthropic
 * when ANTHROPIC_API_KEY is set, else OpenAI, else the mock. The eval tenant is never a sample
 * workspace, so it gets the real provider whenever a key exists and INVAI_PAID_AI=1 was set in
 * the shell (decision 0038); without that opt-in a key in .env is ignored and the mode is mock.
 */
export type EvalMode = "mock" | "anthropic" | "openai";

export function evalMode(): EvalMode {
  if (env.mocks.ai) return "mock";
  return !env.ANTHROPIC_API_KEY && env.OPENAI_API_KEY ? "openai" : "anthropic";
}

/** A line for the harness header. Never prints a key. */
export function describeMode(mode: EvalMode = evalMode()): string {
  if (mode !== "mock") return mode;
  return env.aiKeysLocked
    ? "mock (paid AI is off; set INVAI_PAID_AI=1 in the shell to use the keys in .env)"
    : "mock (no ANTHROPIC_API_KEY or OPENAI_API_KEY)";
}
