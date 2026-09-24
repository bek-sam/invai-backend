import { defineConfig } from "tsup";

// Two entries, one per process: dist/server.js (api) and dist/index.js (worker).
// @invai/contracts ships TypeScript source, so it is bundled; every other dependency stays
// external and is loaded from node_modules at runtime.
export default defineConfig({
  entry: { server: "src/api/server.ts", index: "src/worker/index.ts" },
  format: ["esm"],
  target: "node24",
  platform: "node",
  clean: true,
  noExternal: ["@invai/contracts"],
});
