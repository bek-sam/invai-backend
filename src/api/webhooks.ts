import { Hono } from "hono";
import { queues } from "../lib/queues";

/**
 * Marketplace webhooks. Verify the signature with the channel adapter, enqueue, return fast.
 * Polling jobs catch anything a webhook misses.
 */
export const webhooks = new Hono();

webhooks.post("/:channel", async (c) => {
  const channel = c.req.param("channel");
  const body = await c.req.text();
  // TODO: adapter.verifyWebhook(headers, body) before enqueueing
  await queues.sync.add("webhook", {
    channel,
    body,
    headers: Object.fromEntries(c.req.raw.headers),
  });
  return c.body(null, 202);
});
