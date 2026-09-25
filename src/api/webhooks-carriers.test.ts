import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withSystem } from "../db/client";
import { carrierWebhookEvents } from "../db/schema";
import { signEasypostBody } from "../integrations/carriers/easypost/webhook";
import { easypostEventJob } from "../modules/shipping/jobs";
import { app } from "./app";

/*
 * POST /webhooks/easypost: verify the HMAC first (401, nothing written or enqueued), then dedupe
 * on the EasyPost event id in carrier_webhook_events, then enqueue the normalized event. The
 * queue is stubbed so no test job is left for a worker.
 */

const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

afterEach(() => vi.restoreAllMocks());

function trackerEvent(id: string, status = "in_transit") {
  return JSON.stringify({
    id,
    object: "Event",
    description: "tracker.updated",
    mode: "test",
    result: {
      id: `trk_${id}`,
      object: "Tracker",
      tracking_code: `9400T32${id}`,
      status,
      signed_by: "Somebody Private",
      shipment_id: `shp_${id}`,
      tracking_details: [
        {
          status,
          datetime: "2026-09-24T10:00:00Z",
          tracking_location: { city: "PHOENIX", state: "AZ", zip: "85004" },
        },
      ],
    },
  });
}

const post = (body: string, signature: string | null = signEasypostBody(body)) =>
  app.request("/webhooks/easypost", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(signature ? { "x-hmac-signature": signature } : {}),
    },
    body,
  });

async function rows(eventId: string) {
  return withSystem((tx) =>
    tx
      .select()
      .from(carrierWebhookEvents)
      .where(
        and(
          eq(carrierWebhookEvents.provider, "easypost"),
          eq(carrierWebhookEvents.eventId, eventId),
        ),
      ),
  );
}

describe("EasyPost webhook route", () => {
  it("rejects a missing or wrong signature with 401 before anything is written or enqueued", async () => {
    const spy = vi.spyOn(easypostEventJob, "enqueue");
    const id = `evt_${uniq()}`;
    const body = trackerEvent(id);
    expect((await post(body, null)).status).toBe(401);
    expect((await post(body, signEasypostBody(body, "not-the-secret"))).status).toBe(401);
    expect((await post(`${body} `, signEasypostBody(body))).status).toBe(401);
    expect(spy).not.toHaveBeenCalled();
    expect(await rows(id)).toHaveLength(0);
  });

  it("records the event once, enqueues it normalized, and acknowledges a redelivery", async () => {
    const spy = vi.spyOn(easypostEventJob, "enqueue").mockResolvedValue({} as never);
    const id = `evt_${uniq()}`;
    const body = trackerEvent(id);
    const first = await post(body);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true });
    const again = await post(body);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true, duplicate: true });
    expect(spy).toHaveBeenCalledTimes(1);
    const queued = spy.mock.calls[0]?.[0];
    expect(queued).toMatchObject({
      eventId: id,
      description: "tracker.updated",
      tracker: {
        trackerId: `trk_${id}`,
        carrierShipmentId: `shp_${id}`,
        status: "in_transit",
        occurredAt: "2026-09-24T10:00:00.000Z",
      },
    });
    // Normalized at the edge: no signature name or scan location reaches the queue.
    expect(JSON.stringify(queued)).not.toMatch(/Somebody|PHOENIX|85004/);
    expect(await rows(id)).toEqual([expect.objectContaining({ status: "received" })]);
  });

  it("forgets the event and answers 503 when it can't be queued, so EasyPost retries", async () => {
    vi.spyOn(easypostEventJob, "enqueue").mockRejectedValue(new Error("redis down"));
    const id = `evt_${uniq()}`;
    expect((await post(trackerEvent(id))).status).toBe(503);
    expect(await rows(id)).toHaveLength(0);
  });

  it("rejects a signed body that isn't an event", async () => {
    const body = JSON.stringify({ hello: "world" });
    expect((await post(body)).status).toBe(400);
  });

  it("isn't shadowed by the marketplace route", async () => {
    // `easypost` isn't a channel: without its own route this would be 404 "unknown channel".
    const res = await post(JSON.stringify({ id: "evt_x" }), "hmac-sha256-hex=00");
    expect(res.status).toBe(401);
  });
});
