import { and, eq, isNull, lt } from "drizzle-orm";
import { z } from "zod";
import { withSystem, withTenant } from "../../db/client";
import { webhookDeliveries } from "../../db/schema";
import { env } from "../../env";
import { errorData, logger } from "../../lib/log";
import { defineJob, LIVE_JOB_STATES, queues, safeJobId } from "../../lib/queues";
import { warnOverduePrivacyRequests } from "../privacy/service";
import { raiseAlert } from "../today/service";
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

/**
 * Stable per-connection delay in [0, spreadMs) (T-12-3, B-20): every poll tick used to enqueue
 * every connection's sync job at once, so a shop with many connections hit the sync queue (and
 * whatever it calls) in one spike every 10 minutes. A deterministic hash of the connection id
 * spreads them across the window instead -- the same connection always lands at the same offset
 * (stable, not random per run), so two ticks don't line different connections up together either.
 */
export function pollJitterMs(connectionId: string, spreadMs = POLL_EVERY_MS): number {
  let h = 2166136261; // FNV-1a offset basis
  for (let i = 0; i < connectionId.length; i++) {
    h ^= connectionId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % spreadMs;
}

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
        { jobId: `poll-${c.id}-${bucket}`, delay: pollJitterMs(c.id) },
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

/** A delivery still `received` this long after it arrived lost its job (T-12-1). */
export const WEBHOOK_STUCK_MS = 60 * 60_000;
export const WEBHOOK_STUCK_SWEEP_EVERY_MS = 15 * 60_000;
export const STUCK_WEBHOOK_DETAIL = "stuck at received: its processing job was lost";

/**
 * Flags deliveries left at `received` past WEBHOOK_STUCK_MS whose job is no longer live (the
 * enqueue failed and the process crashed before forgetting the record, or the job was removed).
 * Each row is flagged once: `detail` is set, so the next sweep skips it. The row keeps its status
 * (a late job still finishes it normally). Rows only learn their company when processed, so the
 * usual case is an operator signal (error log); a row that already knows its company also raises
 * a `sync_broken` alert for that shop.
 */
export async function flagStuckWebhookDeliveries(now = new Date()) {
  const cutoff = new Date(now.getTime() - WEBHOOK_STUCK_MS);
  const stuck = await withSystem((tx) =>
    tx
      .select()
      .from(webhookDeliveries)
      .where(
        and(
          eq(webhookDeliveries.status, "received"),
          lt(webhookDeliveries.receivedAt, cutoff),
          isNull(webhookDeliveries.detail),
        ),
      )
      .limit(200),
  );
  let flagged = 0;
  let alerted = 0;
  for (const row of stuck) {
    const job = await queues.sync.getJob(safeJobId(`webhook-${row.channel}-${row.deliveryId}`));
    const state = job ? await job.getState() : null;
    if (state && (LIVE_JOB_STATES as readonly string[]).includes(state)) continue;
    const [marked] = await withSystem((tx) =>
      tx
        .update(webhookDeliveries)
        .set({ detail: STUCK_WEBHOOK_DETAIL })
        .where(
          and(
            eq(webhookDeliveries.id, row.id),
            eq(webhookDeliveries.status, "received"),
            isNull(webhookDeliveries.detail),
          ),
        )
        .returning({ id: webhookDeliveries.id }),
    );
    if (!marked) continue;
    flagged++;
    log.error("webhook delivery stuck at received", {
      companyId: row.companyId,
      channel: row.channel,
      deliveryId: row.deliveryId,
      receivedAt: row.receivedAt.toISOString(),
    });
    const companyId = row.companyId;
    if (companyId) {
      await withTenant(companyId, (tx) =>
        raiseAlert(tx, companyId, {
          kind: "sync_broken",
          severity: "warning",
          title: "A store update wasn't processed",
          message:
            "An order update from your store arrived but wasn't processed. Run a sync on the connection to pick it up.",
          dedupeKey: `webhook_stuck:${row.id}`,
          data: { channel: row.channel, deliveryId: row.deliveryId },
        }),
      );
      alerted++;
    }
  }
  return { flagged, alerted };
}

/** Every 15 minutes: flag deliveries stuck at `received`. */
export const stuckWebhookDeliveriesJob = defineJob({
  queue: "sync",
  name: "channels.webhookDeliveries.stuck",
  input: z.object({}).passthrough(),
  options: { attempts: 1 },
  handler: async () => flagStuckWebhookDeliveries(),
});

/**
 * Daily: drop webhook delivery records past their retention (7 days). Stuck ones are flagged
 * first, so none is purged before it was reported.
 */
export const purgeWebhookDeliveriesJob = defineJob({
  queue: "sync",
  name: "channels.webhookDeliveries.purge",
  input: z.object({}).passthrough(),
  handler: async () => ({
    stuck: await flagStuckWebhookDeliveries(),
    ...(await purgeWebhookDeliveries()),
  }),
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
    "channels-webhook-deliveries-stuck",
    { every: WEBHOOK_STUCK_SWEEP_EVERY_MS },
    { name: stuckWebhookDeliveriesJob.name, data: {} },
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
