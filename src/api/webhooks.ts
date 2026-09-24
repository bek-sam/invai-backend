import { CHANNELS } from "@invai/contracts";
import { Hono } from "hono";
import { env } from "../env";
import { errorData, logger } from "../lib/log";
import { getJob } from "../lib/queues";
import { completeShopifyOAuth, verifyWebhook } from "../modules/channels/sync";

const log = logger("webhooks");

/**
 * Marketplace webhooks. Shopify: the HMAC is verified here on the raw body (401 when it does
 * not match, as Shopify expects), then the payload is enqueued as `channels.shopify.webhook`
 * (idempotent on X-Shopify-Webhook-Id) and processed by the worker, so Shopify gets a fast 200.
 * Polling catches anything a webhook misses. Other channels have no webhooks in v1.
 */
export const webhooks = new Hono();

webhooks.post("/shopify", async (c) => {
  const body = await c.req.text();
  const headers = Object.fromEntries(c.req.raw.headers);
  if (!(await verifyWebhook("shopify", headers, body))) {
    log.warn("shopify webhook with a bad HMAC", { topic: headers["x-shopify-topic"] ?? null });
    return c.json({ error: "invalid hmac" }, 401);
  }
  const job = getJob("channels.shopify.webhook");
  if (!job) return c.body(null, 202);
  const deliveryId =
    headers["x-shopify-webhook-id"] ?? headers["x-shopify-event-id"] ?? crypto.randomUUID();
  await job.enqueue(
    { channel: "shopify", body, headers, receivedAt: new Date().toISOString() },
    { jobId: `webhook-shopify-${deliveryId}` },
  );
  return c.json({ ok: true }, 200);
});

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
  await job.enqueue(
    { channel, body, headers, receivedAt: new Date().toISOString() },
    { jobId: `webhook-${channel}-${headers["x-etsy-delivery-id"] ?? crypto.randomUUID()}` },
  );
  return c.body(null, 202);
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
