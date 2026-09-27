import { writeFileSync } from "node:fs";
import { closeDb } from "../../src/db/client";
import { env } from "../../src/env";
import { closeQueues } from "../../src/lib/queues";
import { printOverall, printRoute } from "../lib/report";
import { runMarketEvals } from "./run";

/*
 * Entry point for the market eval set: `tsx evals/market/main.ts [--json <path>]`. Kept separate
 * until `evals/run.ts` registers the route (a one-line change outside T-18-4's card, requested
 * from the tech lead). Same output as `pnpm evals`, so the summary merges into baseline.json.
 */

async function main() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--json");
  const jsonOut = i >= 0 ? (argv[i + 1] ?? null) : null;
  console.log(`AI eval harness (market) — mode: ${env.mocks.ai ? "mock (no ANTHROPIC_API_KEY)" : "real"}`);
  const report = await runMarketEvals();
  if (report.mode === "skipped") console.log(`market: skipped — ${report.skippedReason}`);
  const summary = printRoute(report);
  printOverall([summary]);
  if (jsonOut)
    writeFileSync(
      jsonOut,
      `${JSON.stringify({ generatedAt: new Date().toISOString(), mode: env.mocks.ai ? "mock" : "real", routes: [summary] }, null, 2)}\n`,
    );
  if (report.mode !== "skipped" && summary.plumbingPass < summary.cases) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeQueues().catch(() => undefined);
    await closeDb().catch(() => undefined);
  });
