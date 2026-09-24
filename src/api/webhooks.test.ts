import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { withSystem } from "../db/client";
import { webhookDeliveries } from "../db/schema";
import { signEtsyWebhook } from "../integrations/channels/etsy";
import { MOCK_ETSY_WEBHOOK_SECRET } from "../integrations/channels/etsy/webhooks";
import { signShopifyBody } from "../integrations/channels/shopify";
import { getJob, queues } from "../lib/queues";
import { app } from "./app";

/*
 * The webhook route: verify first, then dedupe on the channel's delivery id in
 * webhook_deliveries, then enqueue. Nothing is written or enqueued for a bad signature.
 */

const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const shopifyJob = getJob("channels.shopify.webhook");
const etsyJob = getJob("channels.etsy.webhook");
const created: string[] = [];

afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  // Don't leave test jobs for a worker to pick up.
  for (const id of created) await (await queues.sync.getJob(id))?.remove();
});

function shopify(body: string, extra: Record<string, string> = {}) {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-shopify-topic": "orders/cancelled",
      "x-shopify-shop-domain": "t12-nowhere.myshopify.com",
      "x-shopify-hmac-sha256": signShopifyBody(body),
      ...extra,
    },
    body,
  };
}

function etsy(body: string, id: string, extra: Record<string, string> = {}) {
  const ts = Math.floor(Date.now() / 1000);
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "webhook-id": id,
      "webhook-timestamp": String(ts),
      "webhook-signature": signEtsyWebhook(id, ts, body, MOCK_ETSY_WEBHOOK_SECRET),
      ...extra,
    },
    body,
  };
}

async function deliveries(channel: "shopify" | "etsy", deliveryId: string) {
  return withSystem((tx) =>
    tx
      .select()
      .from(webhookDeliveries)
      .where(
        and(eq(webhookDeliveries.channel, channel), eq(webhookDeliveries.deliveryId, deliveryId)),
      ),
  );
}

async function queued(jobId: string) {
  return (await queues.sync.getJob(jobId)) ?? null;
}

describe("webhook route", () => {
  it("has handlers for Shopify and Etsy", () => {
    expect(shopifyJob).toBeDefined();
    expect(etsyJob).toBeDefined();
  });

  it("an unsigned or badly signed Shopify webhook gets 401 and nothing is written or enqueued", async () => {
    const spy = vi.spyOn(shopifyJob as NonNullable<typeof shopifyJob>, "enqueue");
    const id = `t12-${uniq()}`;
    const body = JSON.stringify({ id: 1 });
    const { "x-shopify-hmac-sha256": _sig, ...unsigned } = shopify(body).headers;
    const bad = await app.request("/webhooks/shopify", {
      ...shopify(body, { "x-shopify-webhook-id": id }),
      body: JSON.stringify({ id: 2 }),
    });
    expect(bad.status).toBe(401);
    const none = await app.request("/webhooks/shopify", {
      method: "POST",
      headers: { ...unsigned, "x-shopify-webhook-id": id },
      body,
    });
    expect(none.status).toBe(401);
    expect(spy).not.toHaveBeenCalled();
    expect(await deliveries("shopify", id)).toHaveLength(0);
    expect(await queued(`webhook-shopify-${id}`)).toBeNull();
  });

  it("an unsigned or badly signed Etsy webhook gets 401 and nothing is written or enqueued", async () => {
    const spy = vi.spyOn(etsyJob as NonNullable<typeof etsyJob>, "enqueue");
    const id = `msg_${uniq()}`;
    const body = JSON.stringify({ event_type: "ORDER_PAID", shop_id: 1 });
    const bad = await app.request("/webhooks/etsy", {
      ...etsy(body, id),
      body: JSON.stringify({ event_type: "ORDER_PAID", shop_id: 2 }),
    });
    expect(bad.status).toBe(401);
    const none = await app.request("/webhooks/etsy", {
      method: "POST",
      headers: { "content-type": "application/json", "webhook-id": id },
      body,
    });
    expect(none.status).toBe(401);
    // A Shopify-style signature is not an Etsy signature.
    const wrongScheme = await app.request("/webhooks/etsy", {
      ...shopify(body),
      headers: { ...shopify(body).headers, "webhook-id": id },
    });
    expect(wrongScheme.status).toBe(401);
    expect(spy).not.toHaveBeenCalled();
    expect(await deliveries("etsy", id)).toHaveLength(0);
  });

  it("channels without webhooks refuse everything; unknown channels are 404", async () => {
    for (const channel of ["amazon", "tiktok", "walmart", "csv"]) {
      const res = await app.request(`/webhooks/${channel}`, shopify("{}"));
      expect(res.status, channel).toBe(401);
    }
    expect((await app.request("/webhooks/myspace", shopify("{}"))).status).toBe(404);
  });

  it("a signed Shopify webhook without X-Shopify-Webhook-Id is rejected, never given a made-up id", async () => {
    const spy = vi.spyOn(shopifyJob as NonNullable<typeof shopifyJob>, "enqueue");
    const body = JSON.stringify({ id: 3 });
    const res = await app.request(
      "/webhooks/shopify",
      shopify(body, { "x-shopify-event-id": `evt-${uniq()}` }),
    );
    expect(res.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it("a signed Shopify delivery is recorded and enqueued once; the redelivery gets 200 and nothing", async () => {
    const spy = vi.spyOn(shopifyJob as NonNullable<typeof shopifyJob>, "enqueue");
    const id = `t12-${uniq()}`;
    const body = JSON.stringify({ id: 4 });
    const first = await app.request(
      "/webhooks/shopify",
      shopify(body, { "x-shopify-webhook-id": id }),
    );
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true });
    created.push(`webhook-shopify-${id}`);
    const again = await app.request(
      "/webhooks/shopify",
      shopify(body, { "x-shopify-webhook-id": id }),
    );
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true, duplicate: true });
    expect(spy).toHaveBeenCalledTimes(1);
    const rows = await deliveries("shopify", id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("received");
    const job = await queued(`webhook-shopify-${id}`);
    expect(job?.data).toMatchObject({ channel: "shopify", body });
  });

  it("a signed Etsy delivery is deduplicated on webhook-id", async () => {
    const spy = vi.spyOn(etsyJob as NonNullable<typeof etsyJob>, "enqueue");
    const id = `msg_${uniq()}`;
    const body = JSON.stringify({
      event_type: "ORDER_PAID",
      resource_url: "https://openapi.etsy.com/v3/application/shops/1/receipts/2",
      shop_id: 1,
    });
    expect((await app.request("/webhooks/etsy", etsy(body, id))).status).toBe(200);
    created.push(`webhook-etsy-${id}`);
    // Etsy retries with the same webhook-id and a fresh timestamp and signature.
    const retry = await app.request("/webhooks/etsy", etsy(body, id));
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ ok: true, duplicate: true });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await deliveries("etsy", id)).toHaveLength(1);
    expect(await queued(`webhook-etsy-${id}`)).not.toBeNull();
  });

  it("when the job can't be enqueued the delivery is forgotten and the channel is asked to retry", async () => {
    vi.spyOn(shopifyJob as NonNullable<typeof shopifyJob>, "enqueue").mockRejectedValueOnce(
      new Error("redis down"),
    );
    const id = `t12-${uniq()}`;
    const body = JSON.stringify({ id: 5 });
    const res = await app.request(
      "/webhooks/shopify",
      shopify(body, { "x-shopify-webhook-id": id }),
    );
    expect(res.status).toBe(503);
    expect(await deliveries("shopify", id)).toHaveLength(0);
    const retry = await app.request(
      "/webhooks/shopify",
      shopify(body, { "x-shopify-webhook-id": id }),
    );
    expect(retry.status).toBe(200);
    created.push(`webhook-shopify-${id}`);
    expect(await deliveries("shopify", id)).toHaveLength(1);
  });
});
