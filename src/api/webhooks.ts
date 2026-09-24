import { CHANNELS, type Channel } from "@invai/contracts";
import { Hono } from "hono";
import { env } from "../env";
import { webhookDeliveryId } from "../integrations/channels";
import { header } from "../integrations/channels/types";
import { errorData, logger } from "../lib/log";
import { getJob } from "../lib/queues";
import {
  completeShopifyOAuth,
  forgetWebhookDelivery,
  recordWebhookDelivery,
  verifyWebhook,
} from "../modules/channels/sync";

const log = logger("webhooks");

/**
 * Marketplace webhooks, one route for every channel:
 *   1. verify the signature on the raw body (401 when it doesn't match; nothing is written),
 *   2. read the channel's delivery id (400 when missing; never a made-up id),
 *   3. record it in `webhook_deliveries` (unique per channel; a redelivery gets 200 and stops),
 *   4. enqueue `channels.<channel>.webhook` and answer 200 fast; the worker does the work.
 * Shopify dedupes on X-Shopify-Webhook-Id, Etsy on webhook-id. Polling catches anything a
 * webhook misses. Channels without webhooks never verify, so they get 401.
 */
export const webhooks = new Hono();

webhooks.post("/:channel", async (c) => {
  const param = c.req.param("channel");
  if (!(CHANNELS as readonly string[]).includes(param))
    return c.json({ error: "unknown channel" }, 404);
  const channel = param as Channel;
  const body = await c.req.text();
  const headers = Object.fromEntries(c.req.raw.headers);
  if (!(await verifyWebhook(channel, headers, body))) {
    log.warn("webhook with a bad signature", {
      channel,
      topic: header(headers, "x-shopify-topic"),
    });
    return c.json({ error: "invalid signature" }, 401);
  }
  const deliveryId = webhookDeliveryId(channel, headers);
  if (!deliveryId) {
    log.warn("signed webhook without a delivery id; rejected", { channel });
    return c.json({ error: "missing delivery id" }, 400);
  }
  const job = getJob(`channels.${channel}.webhook`);
  if (!job) {
    log.warn("webhook received but no handler registered", { channel });
    return c.json({ error: "no handler" }, 503);
  }
  if (!(await recordWebhookDelivery(channel, deliveryId))) {
    log.info("duplicate webhook delivery acknowledged", { channel, deliveryId });
    return c.json({ ok: true, duplicate: true }, 200);
  }
  try {
    await job.enqueue(
      { channel, body, headers, receivedAt: new Date().toISOString() },
      { jobId: `webhook-${channel}-${deliveryId}` },
    );
  } catch (err) {
    // Not queued: forget the delivery so the channel's retry is processed, and ask for one.
    log.error("could not enqueue webhook", { channel, deliveryId, ...errorData(err) });
    await forgetWebhookDelivery(channel, deliveryId).catch(() => {});
    return c.json({ error: "try again" }, 503);
  }
  return c.json({ ok: true }, 200);
});

/** Shopify OAuth install callback: finishes the pending connection, then back to the web app. */
async function oauthCallback(c: import("hono").Context) {
  const query = Object.fromEntries(new URL(c.req.url).searchParams);
  const back = new URL("/settings/channels", env.WEB_ORIGIN);
  try {
    const res = await completeShopifyOAuth(query);
    back.searchParams.set("connected", "shopify");
    back.searchParams.set("connectionId", res.connectionId);
  } catch (err) {
    log.warn("shopify oauth callback failed", errorData(err));
    back.searchParams.set(
      "error",
      err instanceof Error ? err.message : "Shopify connection failed",
    );
  }
  return c.redirect(back.toString());
}

webhooks.get("/shopify/oauth/callback", oauthCallback);
webhooks.get("/shopify/oauth", oauthCallback);
