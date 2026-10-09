import { defineConfig } from "tsup";

// The five entry points of the image (architect A1, wave 24; T-30-2), each at its own path so
// `node dist/<entry>.js` is what SST runs:
//   dist/api/server.js              the API
//   dist/worker/index.js            the worker
//   dist/db/bootstrap-cli.js        release step 1: create/update the app role
//   dist/db/migrate-cli.js          release step 2: migrations from ../../drizzle (= <app>/drizzle)
//   dist/db/reference-seed-cli.js   release step 3: plans and trademark marks
// Shared code lands in dist/chunk-*.js; nothing that resolves files relative to itself may live
// there (see `migrationsFolderFrom` in src/db/migrate.ts). No module with an argv-guarded main
// block (reset.ts, seed/index.ts) may be imported by an entry.
// @invai/contracts ships TypeScript source, so it is bundled; every other dependency stays
// external and is loaded from node_modules at runtime.
export default defineConfig({
  entry: {
    "api/server": "src/api/server.ts",
    "worker/index": "src/worker/index.ts",
    "db/bootstrap-cli": "src/db/bootstrap-cli.ts",
    "db/migrate-cli": "src/db/migrate-cli.ts",
    "db/reference-seed-cli": "src/db/reference-seed-cli.ts",
  },
  format: ["esm"],
  target: "node24",
  platform: "node",
  clean: true,
  noExternal: ["@invai/contracts"],
});
