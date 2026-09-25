import { z } from "zod";
import { env } from "../../env";
import { errorData, logger } from "../../lib/log";
import { defineJob, queues } from "../../lib/queues";
import { warnOverduePrivacyRequests } from "../privacy/service";
import { checkWebhookSubscriptions, refreshExpiringTokens } from "./service";
import {
  pollableConnections,
  processWebhook,
  purgeWebhookDeliveries,
  syncConnection,
} from "./sync";

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
    // Expiring access tokens first (1 hour; refreshed when under 20 minutes are left).
    const tokens = await refreshExpiringTokens().catch((err) => {
      log.warn("token refresh sweep failed", errorData(err));
      return null;
    });
    const conns = await pollableConnections();
    const bucket = Math.floor(Date.now() / POLL_EVERY_MS);
    for (const c of conns) {
      await syncConnectionJob.enqueue(
        { companyId: c.companyId, connectionId: c.id, jobId: null },
        { jobId: `poll-${c.id}-${bucket}` },
      );
    }
    return { connections: conns.length, tokens };
  },
});

const webhookInput = z.object({
  channel: z.string(),
  body: z.string(),
  headers: z.record(z.string(), z.string()),
  receivedAt: z.string(),
});

/** Verified webhooks are processed here so the marketplace gets a fast 200. */
export const shopifyWebhookJob = defineJob({
  queue: "sync",
  name: "channels.shopify.webhook",
  input: webhookInput,
  options: { attempts: 5 },
  handler: async ({ body, headers, receivedAt }) =>
    processWebhook("shopify", headers, body, receivedAt),
});

/** Etsy webhooks name a receipt; the handler fetches it by id (Etsy retries for about 30 h). */
export const etsyWebhookJob = defineJob({
  queue: "sync",
  name: "channels.etsy.webhook",
  input: webhookInput,
  options: { attempts: 5 },
  handler: async ({ body, headers, receivedAt }) =>
    processWebhook("etsy", headers, body, receivedAt),
});

/** Daily: drop webhook delivery records past their retention (7 days). */
export const purgeWebhookDeliveriesJob = defineJob({
  queue: "sync",
  name: "channels.webhookDeliveries.purge",
  input: z.object({}).passthrough(),
  handler: async () => purgeWebhookDeliveries(),
});

/**
 * Daily: re-check webhook subscriptions and recreate any the channel dropped, and warn about
 * privacy requests still open after 20 days (T-3-1).
 */
export const checkWebhookSubscriptionsJob = defineJob({
  queue: "sync",
  name: "channels.webhookSubscriptions.check",
  input: z.object({}).passthrough(),
  handler: async () => ({
    ...(await checkWebhookSubscriptions()),
    ...(await warnOverduePrivacyRequests()),
  }),
});

/** Idempotent: registers the 10-minute poll and the nightly delivery purge (API and worker). */
export async function schedulePolling() {
  await queues.sync.upsertJobScheduler(
    "channels-poll",
    { every: POLL_EVERY_MS },
    { name: pollChannelsJob.name, data: {} },
  );
  await queues.sync.upsertJobScheduler(
    "channels-webhook-deliveries-purge",
    { pattern: "45 4 * * *", tz: "UTC" },
    { name: purgeWebhookDeliveriesJob.name, data: {} },
  );
  await queues.sync.upsertJobScheduler(
    "channels-webhook-subscriptions-check",
    { pattern: "15 5 * * *", tz: "UTC" },
    { name: checkWebhookSubscriptionsJob.name, data: {} },
  );
}

if (!env.isTest) {
  schedulePolling().catch((err) =>
    log.warn("could not register the channel poll scheduler", errorData(err)),
  );
}
