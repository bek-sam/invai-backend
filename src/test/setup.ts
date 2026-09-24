import { afterAll } from "vitest";
import { closeDb } from "../db/client";
import { closeQueues } from "../lib/queues";

/** Per-file setup: release pools so vitest can exit cleanly. */
afterAll(async () => {
  await closeQueues().catch(() => {});
  await closeDb().catch(() => {});
});
