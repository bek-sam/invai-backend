import { createHmac, timingSafeEqual } from "node:crypto";
import { type HeaderBag, header, type WebhookEvent } from "../types";

/*
 * Etsy Open API v3 webhooks, which follow Standard Webhooks.
 * Docs: https://developers.etsy.com/documentation/essentials/webhooks (read 2026-09-24),
 * https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md,
 * https://github.com/etsy/open-api/discussions/1509 (real payloads use uppercase event types).
 *
 * - Headers: `webhook-id` (dedupe key), `webhook-timestamp` (unix seconds), `webhook-signature`
 *   (space-separated `v1,<base64>` entries; any match is valid, so secrets can rotate).
 * - Signature: base64(HMAC-SHA256(base64decode(secret minus "whsec_"), `${id}.${ts}.${rawBody}`)).
 * - Payload carries ids only: `{ event_type, resource_url: ".../shops/{shop}/receipts/{receipt}",
 *   shop_id }`. The handler fetches the receipt by id and never trusts the payload.
 * - Retries for about 30 h (0s, 5s, 5m, 30m, 2h, 5h, 10h, 10h).
 */

/** Reject timestamps more than 5 minutes from when the delivery reached us. */
export const ETSY_WEBHOOK_TOLERANCE_SEC = 5 * 60;

/** Mock mode (no ETSY_WEBHOOK_SECRET) signs with this fixed dev secret. Never accepted in production. */
export const MOCK_ETSY_WEBHOOK_SECRET = `whsec_${Buffer.from("invai-mock-etsy-webhook-secret").toString("base64")}`;

/** The portal's signing secret, or null when unset (the mock secret is used instead). */
export function etsyWebhookSecretFromEnv(): string | null {
  return process.env.ETSY_WEBHOOK_SECRET || null;
}

function secretKey(secret: string): Buffer {
  return Buffer.from(secret.startsWith("whsec_") ? secret.slice(6) : secret, "base64");
}

/** The `v1,<base64>` signature for one delivery (used by tests and the local curl check). */
export function signEtsyWebhook(
  webhookId: string,
  timestampSec: number,
  body: string,
  secret: string,
): string {
  const mac = createHmac("sha256", secretKey(secret))
    .update(`${webhookId}.${timestampSec}.${body}`, "utf8")
    .digest("base64");
  return `v1,${mac}`;
}

/** Standard Webhooks verification on the raw body, constant time, with a timestamp tolerance. */
export function verifyEtsyWebhook(
  headers: HeaderBag,
  body: string,
  secret: string,
  receivedAt: Date = new Date(),
): boolean {
  const id = header(headers, "webhook-id");
  const ts = header(headers, "webhook-timestamp");
  const sig = header(headers, "webhook-signature");
  if (!id || !ts || !sig || !/^\d{1,12}$/.test(ts)) return false;
  const skew = Math.abs(receivedAt.getTime() / 1000 - Number(ts));
  if (skew > ETSY_WEBHOOK_TOLERANCE_SEC) return false;
  const want = Buffer.from(signEtsyWebhook(id, Number(ts), body, secret).slice(3), "base64");
  let ok = false;
  for (const entry of sig.split(" ")) {
    const [version, value] = entry.split(",", 2);
    if (version !== "v1" || !value) continue;
    const got = Buffer.from(value, "base64");
    // Check every entry (no early exit) so timing doesn't reveal which one matched.
    if (got.length === want.length && timingSafeEqual(got, want)) ok = true;
  }
  return ok;
}

type EtsyWebhookPayload = {
  event_type?: unknown;
  resource_url?: unknown;
  shop_id?: unknown;
};

const RECEIPT_URL = /\/shops\/(\d+)\/receipts\/(\d+)(?:[/?#]|$)/;

/** Order events name a receipt; everything else is ignored. Event types match in any case. */
export function parseEtsyWebhook(body: string): WebhookEvent {
  let payload: EtsyWebhookPayload;
  try {
    payload = JSON.parse(body) as EtsyWebhookPayload;
  } catch {
    return { kind: "ignored", topic: "unreadable", shopDomain: null };
  }
  const topic = typeof payload.event_type === "string" ? payload.event_type : "unknown";
  const shopId =
    typeof payload.shop_id === "number" || typeof payload.shop_id === "string"
      ? String(payload.shop_id)
      : null;
  const shopDomain = shopId && /^\d+$/.test(shopId) ? shopId : null;
  const normalized = topic.toLowerCase().replace(/_/g, ".");
  if (normalized !== "order.paid" && normalized !== "order.canceled")
    return { kind: "ignored", topic, shopDomain };
  const match = typeof payload.resource_url === "string" && RECEIPT_URL.exec(payload.resource_url);
  // The receipt must belong to the shop the event is routed to.
  if (!match || !shopDomain || match[1] !== shopDomain)
    return { kind: "ignored", topic, shopDomain };
  return { kind: "order_ref", topic, shopDomain, channelOrderId: match[2] as string };
}
