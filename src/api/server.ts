import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { env } from "../env";
import { initFieldEncryption } from "../lib/crypto";
import { errorData, logger } from "../lib/log";
import { ensureBucket } from "../lib/s3";
import { withShutdownCap } from "../lib/shutdown-timeout";
import { app } from "./app";
import { beginShutdown } from "./shutdown";

const log = logger("api");

// Fail fast: a missing or wrong field-encryption key stops the start, not the first request.
await initFieldEncryption().catch((err) => {
  log.error("field encryption failed to start", errorData(err));
  process.exit(1);
});

if (!env.isProd) {
  await ensureBucket().catch((err) => log.warn("bucket check failed", { error: String(err) }));
}

// Always a plain node:http Server here (no https/http2 serverOptions passed to serve()).
const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  log.info(`invai api listening on :${info.port}`, { mocks: env.mocks });
}) as Server;

/**
 * Graceful SIGTERM/SIGINT (T-12-2, B-16): stop accepting new connections, let in-flight requests
 * finish, then exit -- bounded by DRAIN_TIMEOUT_MS so a stuck request (or an SSE client that
 * ignores the shutdown event from events.ts) can't hold the process open past a deploy's real
 * stop-timeout budget. `beginShutdown()` also tells `events.ts` to send its SSE clients a retry
 * hint and close, instead of streaming forever.
 */
const DRAIN_TIMEOUT_MS = 10_000;

let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("draining", { signal, capMs: DRAIN_TIMEOUT_MS });
  beginShutdown();
  // Idle keep-alive sockets get no more requests; server.close() below stops the listener itself.
  server.closeIdleConnections();

  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  const closedInTime = await withShutdownCap(closed, DRAIN_TIMEOUT_MS);
  const timedOut = !closedInTime;

  if (timedOut) {
    log.warn("drain window elapsed; forcing remaining connections closed", { signal });
    server.closeAllConnections();
  }
  log.info("exiting", { signal, forced: timedOut });
  process.exit(timedOut ? 1 : 0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
// ADR 0028: a stray rejected promise (a fire-and-forget side effect) is logged and the API keeps
// serving; uncaughtException keeps Node's default (crash, the task restarts).
process.on("unhandledRejection", (reason) => log.error("unhandled rejection", errorData(reason)));
