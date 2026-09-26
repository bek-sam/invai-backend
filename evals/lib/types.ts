/** Shared types for the eval harness (T-8-5, B-48). See invai-docs/decisions/0007. */

export type EvalCase<V = unknown, E = unknown> = {
  id: string;
  tags: string[];
  vars: V;
  expect: E;
};

/** One case's outcome. `qualityPass` is null when quality can't be meaningfully judged this run
 * (mock mode: the mock is a fixed heuristic, not the model under test). `plumbingPass` is what
 * gates the script's exit code — it never depends on model quality, only on the call completing,
 * returning schema-valid output and satisfying structural (non-quality) checks. */
export type CaseResult = {
  id: string;
  tags: string[];
  plumbingPass: boolean;
  qualityPass: boolean | null;
  note: string;
  costCents: number;
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  model: string;
};

export type RouteReport = {
  route: string;
  mode: "mock" | "real" | "skipped";
  skippedReason?: string;
  cases: CaseResult[];
};

export function cacheHitRate(cases: CaseResult[]): number {
  const tokensIn = cases.reduce((a, c) => a + c.tokensIn, 0);
  const cacheRead = cases.reduce((a, c) => a + c.cacheReadTokens, 0);
  return tokensIn > 0 ? cacheRead / tokensIn : 0;
}
