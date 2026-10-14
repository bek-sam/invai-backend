import { runInScratch } from "../lib/scratch-db";

/*
 * Entry point for the market eval set: `tsx evals/market/main.ts [--json <path>]`. The seed writes
 * a company and its orders, so like `pnpm evals` it runs on a scratch database (T-53-2, B-460);
 * no static import below may reach `src/env.ts`. The run itself is `body.ts`.
 */

let close: (() => Promise<void>) | undefined;

runInScratch(
  async () => {
    const body = await import("./body");
    close = body.closeMarketResources;
    await body.runMarketAndClose(process.argv.slice(2));
  },
  { applyEnv: true, onSignalCleanup: async () => close?.() },
).catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
