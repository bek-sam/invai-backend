import { CHANNELS } from "@invai/contracts";
import { Hono } from "hono";
import { logger } from "../lib/log";
import { getJob } from "../lib/queues";

const log = logger("webhooks");

/**
 * Marketplace webhooks: `POST /webhooks/:channel`. The channel module registers a job named
 * `channels.<channel>.webhook` (see modules/channels/jobs.ts) that verifies the signature with
 * the adapter and processes the payload; this handler only records and enqueues so the
 * marketplace gets a fast 202. Polling catches anything a webhook misses.
 */
export const webhooks = new Hono();

webhooks.post("/:channel", async (c) => {
  const channel = c.req.param("channel");
  if (!(CHANNELS as readonly string[]).includes(channel))
    return c.json({ error: "unknown channel" }, 404);
  const job = getJob(`channels.${channel}.webhook`);
  if (!job) {
    log.warn("webhook received but no handler registered", { channel });
    return c.body(null, 202);
  }
  const body = await c.req.text();
  const headers = Object.fromEntries(c.req.raw.headers);
  const deliveryId =
    headers["x-shopify-webhook-id"] ?? headers["x-etsy-delivery-id"] ?? crypto.randomUUID();
  await job.enqueue(
    { channel, body, headers, receivedAt: new Date().toISOString() },
    {
      jobId: `webhook-${channel}-${deliveryId}`,
    },
  );
  return c.body(null, 202);
});

/** Shopify OAuth callback lands here; the channels module handles it via the same job pattern. */
webhooks.get("/shopify/oauth", async (c) => {
  const job = getJob("channels.shopify.oauthCallback");
  if (!job) return c.text("Shopify OAuth is not configured", 501);
  const query = Object.fromEntries(new URL(c.req.url).searchParams);
  await job.enqueue({ query }, { jobId: `shopify-oauth-${query.state ?? crypto.randomUUID()}` });
  return c.redirect(`${c.req.header("origin") ?? ""}/channels?connected=shopify`);
});
