import { serve } from "@hono/node-server";
import { env } from "../env";
import { logger } from "../lib/log";
import { ensureBucket } from "../lib/s3";
import { app } from "./app";

const log = logger("api");

if (!env.isProd) {
  await ensureBucket().catch((err) => log.warn("bucket check failed", { error: String(err) }));
}

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  log.info(`invai api listening on :${info.port}`, { mocks: env.mocks });
});
