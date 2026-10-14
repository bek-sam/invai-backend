import { writeFileSync } from "node:fs";
import { closeDb } from "../../src/db/client";
import { describeMode, evalMode } from "../lib/mode";
import { env } from "../../src/env";
import { closeQueues } from "../../src/lib/queues";
import { assertEvalEnv } from "../lib/scratch-db";
import { printOverall, printRoute } from "../lib/report";
import { runMarketEvals } from "./run";

/*
 * The market eval body, loaded by `main.ts` (the launcher) once its scratch database is set up (T-53-2). Kept separate
 * until `evals/run.ts` registers the route (a one-line change outside T-18-4's card, requested
 * from the tech lead). Same output as `pnpm evals`, so the summary merges into baseline.json.
 */

export async function runMarketMain(argv: string[]) {
  const i = argv.indexOf("--json");
  const jsonOut = i >= 0 ? (argv[i + 1] ?? null) : null;
  console.log(`AI eval harness (market) — mode: ${describeMode()}`);
  assertEvalEnv(env.DATABASE_URL, env.MIGRATION_DATABASE_URL);
  const report = await runMarketEvals();
  if (report.mode === "skipped") console.log(`market: skipped — ${report.skippedReason}`);
  const summary = printRoute(report);
  printOverall([summary]);
  if (jsonOut)
    writeFileSync(
      jsonOut,
      `${JSON.stringify({ generatedAt: new Date().toISOString(), mode: evalMode(), routes: [summary] }, null, 2)}\n`,
    );
  if (report.mode !== "skipped" && summary.plumbingPass < summary.cases) process.exitCode = 1;
}

export async function closeMarketResources() {
  await closeQueues().catch(() => undefined);
  await closeDb().catch(() => undefined);
}

export async function runMarketAndClose(argv: string[]) {
  try {
    await runMarketMain(argv);
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    await closeMarketResources();
  }
}
