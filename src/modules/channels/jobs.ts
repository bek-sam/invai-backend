import { z } from "zod";
import { env } from "../../env";
import { errorData, logger } from "../../lib/log";
import { defineJob, queues } from "../../lib/queues";
import { pollableConnections, processWebhook, syncConnection } from "./sync";

const log = logger("channels.jobs");

/** Pull orders for one API connection (syncNow, the poller). */
export const syncConnectionJob = defineJob({
  queue: "sync",
  name: "channels.sync",
  input: z.object({ companyId: z.uuid(), connectionId: z.uuid(), jobId: z.uuid().nullish() }),
  jobId: (i) => `sync-${i.connectionId}-${i.jobId ?? "poll"}`,
  options: { attempts: 3, backoff: { type: "exponential", delay: 10_000 } },
  handler: async ({ companyId, connectionId, jobId }) => {
    const res = await syncConnection(companyId, connectionId, jobId);
    return { imported: res.imported };
  },
});

export const POLL_EVERY_MS = 10 * 60_000;

/** Every 10 minutes: one sync job per API connection with auto-import on. */
export const pollChannelsJob = defineJob({
  queue: "sync",
  name: "channels.poll",
  input: z.object({}).passthrough(),
  handler: async () => {
    const conns = await pollableConnections();
    const bucket = Math.floor(Date.now() / POLL_EVERY_MS);
    for (const c of conns) {
      await syncConnectionJob.enqueue(
        { companyId: c.companyId, connectionId: c.id, jobId: null },
        { jobId: `poll-${c.id}-${bucket}` },
      );
    }
    return { connections: conns.length };
  },
});

/** Verified webhooks are processed here so the marketplace gets a fast 200. */
export const shopifyWebhookJob = defineJob({
  queue: "sync",
  name: "channels.shopify.webhook",
  input: z.object({
    channel: z.string(),
    body: z.string(),
    headers: z.record(z.string(), z.string()),
    receivedAt: z.string(),
  }),
  options: { attempts: 5 },
  handler: async ({ body, headers }) => processWebhook("shopify", headers, body),
});

/** Idempotent: registers the 10-minute poll scheduler (safe from API and worker). */
export async function schedulePolling() {
  await queues.sync.upsertJobScheduler(
    "channels-poll",
    { every: POLL_EVERY_MS },
    { name: pollChannelsJob.name, data: {} },
  );
}

if (!env.isTest) {
  schedulePolling().catch((err) =>
    log.warn("could not register the channel poll scheduler", errorData(err)),
  );
}
