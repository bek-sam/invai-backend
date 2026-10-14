import { runInScratch, safeErrorText } from "./lib/scratch-db";

/*
 * Launcher for `pnpm evals` (T-53-2, B-460, architect rulings A9-A16). Nothing here may statically
 * import a module that reaches `src/env.ts` or the db client: the scratch database must be created
 * and `DATABASE_URL`, `MIGRATION_DATABASE_URL` and `REDIS_URL` pointed at it BEFORE they load.
 * The run itself lives in `evals/main.ts`, loaded by the dynamic import below. Arguments, output
 * and exit codes are unchanged; only where the run writes changes.
 */

let closeResources: (() => Promise<void>) | undefined;

runInScratch(
  async () => {
    const main = await import("./main");
    closeResources = main.closeResources;
    await main.runEvalsAndClose(process.argv.slice(2));
  },
  { applyEnv: true, onSignalCleanup: async () => closeResources?.() },
).catch((err) => {
  console.error(`evals failed: ${safeErrorText(err)}`);
  process.exitCode = 1;
});
