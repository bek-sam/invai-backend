import { Hono } from "hono";
import {
  acceptedEventMode,
  easypostWebhookSecret,
  parseEasypostEvent,
  verifyEasypostSignature,
} from "../integrations/carriers/easypost/webhook";
import { errorData, logger } from "../lib/log";
import { getJob } from "../lib/queues";
import { forgetCarrierEvent, recordCarrierEvent } from "../modules/shipping/jobs";

const log = logger("webhooks.carriers");

/**
 * EasyPost webhooks, mounted at `/webhooks/easypost` on its own (not under `/webhooks/:channel`):
 *   1. verify `X-Hmac-Signature` on the raw body (401 when it doesn't match; nothing is written),
 *   2. parse the Event and normalize its tracker (400 when it isn't an Event with an id),
 *   3. record the event id in `carrier_webhook_events` (a redelivery gets 200 and stops),
 *   4. enqueue `shipping.easypostEvent` and answer 200 fast (EasyPost allows 7 s); the worker
 *      routes it to the shipment and moves its state.
 * Events from the other EasyPost mode (a test-key event on a production key, or the reverse) are
 * recorded as ignored. The daily tracker poll catches anything a webhook misses.
 */
export const carrierWebhooks = new Hono();

carrierWebhooks.post("/", async (c) => {
  const body = await c.req.text();
  const headers = Object.fromEntries(c.req.raw.headers);
  if (!verifyEasypostSignature(headers, body, easypostWebhookSecret())) {
    log.warn("easypost webhook with a bad or missing signature");
    return c.json({ error: "invalid signature" }, 401);
  }
  const event = parseEasypostEvent(body);
  if (!event) {
    log.warn("signed easypost webhook that isn't an event; rejected");
    return c.json({ error: "not an event" }, 400);
  }
  const mode = acceptedEventMode();
  if (mode && event.mode && event.mode !== mode) {
    await recordCarrierEvent(event.id, { status: "ignored", detail: `${event.mode}-mode event` });
    log.info("easypost event from the other mode ignored", { eventId: event.id });
    return c.json({ ok: true, ignored: true }, 200);
  }
  const job = getJob("shipping.easypostEvent");
  if (!job) {
    log.warn("easypost webhook received but no handler registered");
    return c.json({ error: "no handler" }, 503);
  }
  if (!(await recordCarrierEvent(event.id))) {
    log.info("duplicate easypost event acknowledged", { eventId: event.id });
    return c.json({ ok: true, duplicate: true }, 200);
  }
  try {
    await job.enqueue({
      eventId: event.id,
      description: event.description,
      tracker: event.tracker && {
        ...event.tracker,
        occurredAt: event.tracker.occurredAt.toISOString(),
        deliveredAt: event.tracker.deliveredAt?.toISOString() ?? null,
      },
    });
  } catch (err) {
    // Not queued: forget the event so EasyPost's retry is processed, and ask for one.
    log.error("could not enqueue easypost event", { eventId: event.id, ...errorData(err) });
    await forgetCarrierEvent(event.id).catch(() => {});
    return c.json({ error: "try again" }, 503);
  }
  return c.json({ ok: true }, 200);
});
