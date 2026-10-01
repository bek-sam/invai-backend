import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    globalSetup: ["src/test/global-setup.ts"],
    // setup-env.ts must run first: it reads the per-run DATABASE_URL/MIGRATION_DATABASE_URL/
    // REDIS_URL global-setup.ts claimed (T-P1-1) via Vitest's provide()/inject() channel and
    // sets process.env before anything else — including setup.ts's own imports — reads env.ts.
    setupFiles: ["src/test/setup-env.ts", "src/test/setup.ts"],
    // Every test file shares one test database; run files one at a time.
    fileParallelism: false,
    env: { NODE_ENV: "test" },
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
