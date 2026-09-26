import { writeFileSync } from "node:fs";
import { closeDb } from "../src/db/client";
import { env } from "../src/env";
import { closeQueues } from "../src/lib/queues";
import { runAssistantEvals } from "./assistant/run";
import type { EvalTenant } from "./lib/fixtures";
import { createEvalTenant } from "./lib/fixtures";
import { printOverall, printRoute, type RouteSummary } from "./lib/report";
import type { RouteReport } from "./lib/types";
import { runListingCopy } from "./listing_copy/run";
import { runPersonalizationCheck } from "./personalization_check/run";
import { runTrademarkJudge } from "./trademark_judge/run";

/*
 * Eval harness entry point (T-8-5, B-48; invai-docs/decisions/0007-ai-model-policy.md). One eval
 * set per AI route, run through the real gateway (src/ai/gateway.ts) against a throwaway tenant.
 *
 * Mode: with no ANTHROPIC_API_KEY (CI, and any local run without one), env.mocks.ai is true and
 * every call goes to the mock provider automatically (gateway.ts's aiProvider()) — this run then
 * checks the plumbing (schema-valid output, correct cardinality, the gateway/validator wiring)
 * rather than model quality, which a fixed mock can't demonstrate either way. With a key it calls
 * the real model and scores against each case's `expect`.
 *
 * Usage: `pnpm evals` (all routes) or `pnpm evals listing_copy trademark_judge` (a subset).
 * `--json <path>` also writes the route summaries as JSON (used to regenerate `evals/baseline.json`).
 */

const ROUTES: Record<string, (tenant: EvalTenant) => Promise<RouteReport>> = {
  listing_copy: runListingCopy,
  trademark_judge: runTrademarkJudge,
  assistant: runAssistantEvals,
  personalization_check: runPersonalizationCheck,
};

/** Always closes the db pool and the redis client — ioredis/pg keep an open handle that stops
 *  the process from exiting on its own, so every return path (including an early bad-arg exit)
 *  has to go through this, not just the happy path at the bottom of `main`. */
async function closeResources() {
  await closeQueues().catch(() => undefined);
  await closeDb().catch(() => undefined);
}

function jsonArg(argv: string[]): string | null {
  const i = argv.indexOf("--json");
  return i >= 0 ? (argv[i + 1] ?? null) : null;
}

async function main() {
  const argv = process.argv.slice(2);
  const jsonOut = jsonArg(argv);
  const requested = argv.filter((a, i) => !a.startsWith("-") && argv[i - 1] !== "--json");
  const names = requested.length ? requested : Object.keys(ROUTES);
  for (const n of names) {
    if (!(n in ROUTES)) {
      console.error(`Unknown route "${n}". Known routes: ${Object.keys(ROUTES).join(", ")}`);
      process.exitCode = 1;
      return;
    }
  }

  console.log(`AI eval harness — mode: ${env.mocks.ai ? "mock (no ANTHROPIC_API_KEY)" : "real"}`);
  const tenant = await createEvalTenant();
  console.log(`Eval tenant (companyId): ${tenant.companyId}`);

  const summaries: RouteSummary[] = [];
  let plumbingFailed = false;
  for (const name of names) {
    const report = await ROUTES[name]?.(tenant);
    if (!report) continue;
    const summary = printRoute(report);
    summaries.push(summary);
    if (report.mode !== "skipped" && summary.plumbingPass < summary.cases) plumbingFailed = true;
  }
  printOverall(summaries);

  if (jsonOut) {
    writeFileSync(
      jsonOut,
      `${JSON.stringify({ generatedAt: new Date().toISOString(), mode: env.mocks.ai ? "mock" : "real", routes: summaries }, null, 2)}\n`,
    );
    console.log(`\nWrote ${jsonOut}`);
  }

  if (plumbingFailed) {
    console.error(
      "\nOne or more routes have plumbing failures (schema/structure, not model quality) — see above.",
    );
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(closeResources);
