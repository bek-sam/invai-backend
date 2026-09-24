import { describe, expect, it } from "vitest";
import { webhookDeliveryId } from "..";
import { mockEtsyReceipt } from ".";
import {
  MOCK_ETSY_WEBHOOK_SECRET,
  parseEtsyWebhook,
  signEtsyWebhook,
  verifyEtsyWebhook,
} from "./webhooks";

const SECRET = MOCK_ETSY_WEBHOOK_SECRET;
const OTHER = `whsec_${Buffer.from("a-rotated-etsy-secret").toString("base64")}`;
const body = JSON.stringify({
  event_type: "ORDER_PAID",
  resource_url: "https://openapi.etsy.com/v3/application/shops/555/receipts/4242",
  shop_id: 555,
});

function signed(opts: { ts?: number; id?: string; secret?: string; body?: string } = {}) {
  const ts = opts.ts ?? Math.floor(Date.now() / 1000);
  const id = opts.id ?? "msg_2mVb8LcXk";
  return {
    "webhook-id": id,
    "webhook-timestamp": String(ts),
    "webhook-signature": signEtsyWebhook(id, ts, opts.body ?? body, opts.secret ?? SECRET),
  };
}

describe("Etsy Standard Webhooks verification", () => {
  it("accepts a correctly signed delivery", () => {
    expect(verifyEtsyWebhook(signed(), body, SECRET)).toBe(true);
  });

  it("accepts when any one of several signatures matches (secret rotation)", () => {
    const h = signed();
    const other = signed({ secret: OTHER })["webhook-signature"];
    expect(
      verifyEtsyWebhook(
        { ...h, "webhook-signature": `${other} ${h["webhook-signature"]}` },
        body,
        SECRET,
      ),
    ).toBe(true);
    expect(verifyEtsyWebhook({ ...h, "webhook-signature": `v1,AAAA ${other}` }, body, SECRET)).toBe(
      false,
    );
  });

  it("rejects a changed body, id, secret or signature version", () => {
    const h = signed();
    expect(verifyEtsyWebhook(h, `${body} `, SECRET)).toBe(false);
    expect(verifyEtsyWebhook({ ...h, "webhook-id": "msg_other" }, body, SECRET)).toBe(false);
    expect(verifyEtsyWebhook(h, body, OTHER)).toBe(false);
    const v2 = h["webhook-signature"].replace(/^v1,/, "v2,");
    expect(verifyEtsyWebhook({ ...h, "webhook-signature": v2 }, body, SECRET)).toBe(false);
  });

  it("rejects missing headers and timestamps more than 5 minutes off", () => {
    const h = signed();
    for (const drop of ["webhook-id", "webhook-timestamp", "webhook-signature"] as const) {
      const { [drop]: _gone, ...rest } = h;
      expect(verifyEtsyWebhook(rest, body, SECRET), drop).toBe(false);
    }
    const now = Math.floor(Date.now() / 1000);
    expect(verifyEtsyWebhook(signed({ ts: now - 290 }), body, SECRET)).toBe(true);
    expect(verifyEtsyWebhook(signed({ ts: now - 301 }), body, SECRET)).toBe(false);
    expect(verifyEtsyWebhook(signed({ ts: now + 301 }), body, SECRET)).toBe(false);
    expect(verifyEtsyWebhook({ ...h, "webhook-timestamp": "soon" }, body, SECRET)).toBe(false);
  });

  it("checks the timestamp against when the delivery reached us (queued retries)", () => {
    const tenMinutesAgo = Math.floor(Date.now() / 1000) - 600;
    const h = signed({ ts: tenMinutesAgo });
    expect(verifyEtsyWebhook(h, body, SECRET)).toBe(false);
    expect(verifyEtsyWebhook(h, body, SECRET, new Date(tenMinutesAgo * 1000 + 2_000))).toBe(true);
  });

  it("reads the delivery id from webhook-id only", () => {
    expect(webhookDeliveryId("etsy", signed())).toBe("msg_2mVb8LcXk");
    expect(webhookDeliveryId("etsy", { "x-etsy-delivery-id": "x" })).toBeNull();
    expect(webhookDeliveryId("etsy", { "webhook-id": "has space" })).toBeNull();
    expect(webhookDeliveryId("etsy", { "webhook-id": "x".repeat(201) })).toBeNull();
  });
});

describe("Etsy webhook payloads", () => {
  it("turns order events (either case) into a receipt reference", () => {
    expect(parseEtsyWebhook(body)).toEqual({
      kind: "order_ref",
      topic: "ORDER_PAID",
      shopDomain: "555",
      channelOrderId: "4242",
    });
    const canceled = JSON.stringify({
      event_type: "order.canceled",
      resource_url: "https://openapi.etsy.com/v3/application/shops/555/receipts/77",
      shop_id: "555",
    });
    expect(parseEtsyWebhook(canceled)).toMatchObject({ kind: "order_ref", channelOrderId: "77" });
  });

  it("ignores other events, receipts of another shop and unreadable bodies", () => {
    expect(
      parseEtsyWebhook(JSON.stringify({ event_type: "LISTING_UPDATED", shop_id: 555 })).kind,
    ).toBe("ignored");
    const foreign = JSON.stringify({
      event_type: "ORDER_PAID",
      resource_url: "https://openapi.etsy.com/v3/application/shops/999/receipts/1",
      shop_id: 555,
    });
    expect(parseEtsyWebhook(foreign).kind).toBe("ignored");
    expect(parseEtsyWebhook("{not json").kind).toBe("ignored");
  });

  it("the mock store answers a receipt by id, deterministically", () => {
    const a = mockEtsyReceipt("4242");
    expect(a.order?.channel).toBe("etsy");
    expect(a.order?.channelOrderId).toBe("4242");
    expect(a.cancelled).toBe(false);
    expect(mockEtsyReceipt("4242").order?.items).toEqual(a.order?.items);
    expect(mockEtsyReceipt("4240").cancelled).toBe(true);
  });
});
