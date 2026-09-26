import { and, eq, sql } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystem, withTenant } from "../../db/client";
import { alerts, buyerPii, carrierWebhookEvents, orderItems, shipments } from "../../db/schema";
import type {
  CarrierAdapter,
  PurchasedLabel,
  TrackerStatus,
  TrackingAdapter,
} from "../../integrations/carriers";
import * as carriersModule from "../../integrations/carriers";
import { CarrierError } from "../../integrations/carriers";
import { parseEasypostEvent, signEasypostBody } from "../../integrations/carriers/easypost/webhook";
import type { ChannelAdapter } from "../../integrations/channels";
import * as channelsModule from "../../integrations/channels";
import { redis, runJobInline } from "../../lib/queues";
import {
  createCompany,
  createConnection,
  createLocation,
  createOrder,
  createUser,
  tenantContext,
} from "../../test/fixtures";
import {
  findStuckIntents,
  mockTrackingJob,
  pollTrackerJob,
  processCarrierEvent,
  purgeCarrierWebhookEvents,
  pushTrackingJob,
  recordCarrierEvent,
  retryStuckIntent,
  STUCK_ALERT_AFTER,
  trackerPollSweepJob,
} from "./jobs";
import * as svc from "./service";

/*
 * T-3-2: EasyPost tracker events move shipments forward only (in_transit ships CSV-channel
 * units, delivered, return/failure -> exception), an older event never moves a shipment back, the
 * mock timer and the daily poll use the same state function, and the stuck-intent sweep retries
 * buy/void/push intents through the service's read-back paths, alerting after repeated failures.
 * The carrier and Shopify are fakes that count calls.
 */

vi.mock("../../integrations/carriers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../integrations/carriers")>();
  return {
    ...actual,
    carrierAdapter: vi.fn(actual.carrierAdapter),
    carrierTracking: vi.fn(actual.carrierTracking),
  };
});
vi.mock("../../integrations/channels", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../integrations/channels")>();
  return { ...actual, getChannelAdapter: vi.fn(actual.getChannelAdapter) };
});

import { shopifyAdapter } from "../../integrations/channels/shopify";

const realGetChannelAdapter = vi
  .mocked(channelsModule.getChannelAdapter)
  .getMockImplementation() as typeof channelsModule.getChannelAdapter;

type FakeCarrier = CarrierAdapter & {
  sold: Map<string, PurchasedLabel & { refundStatus: string | null }>;
  calls: { buy: number; void: number; lookup: number };
  /** Buy "succeeds at the carrier" but the call fails as if it timed out. */
  loseBuyResponse: boolean;
  failBuy: boolean;
  failLookup: boolean;
};

function fakeCarrier(): FakeCarrier {
  const fake: FakeCarrier = {
    provider: "easypost",
    sold: new Map(),
    calls: { buy: 0, void: 0, lookup: 0 },
    loseBuyResponse: false,
    failBuy: false,
    failLookup: false,
    async rate(req) {
      return {
        carrierShipmentId: `shp_t32_${req.shipmentId.replace(/-/g, "")}`,
        rates: [
          {
            rateId: `rate_${req.shipmentId.slice(0, 8)}`,
            carrier: "usps",
            service: "GroundAdvantage",
            serviceLabel: "USPS Ground Advantage",
            rateCents: 512,
            deliveryDays: 3,
            estimatedDeliveryAt: null,
          },
        ],
      };
    },
    async buy(req) {
      fake.calls.buy += 1;
      if (fake.failBuy) throw new CarrierError("easypost", "upstream", "timeout", "unknown");
      const label = {
        trackingCode: `9400T32${req.carrierShipmentId.slice(-14)}`,
        trackingUrl: null,
        labelKey: carriersModule.labelObjectKey(req.companyId, req.carrierShipmentId),
        carrierLabelId: `pl_${fake.calls.buy}`,
        postageCents: req.rate.rateCents,
      };
      fake.sold.set(req.carrierShipmentId, { ...label, refundStatus: null });
      if (fake.loseBuyResponse)
        throw new CarrierError("easypost", "upstream", "socket hang up", "unknown");
      return label;
    },
    async lookup({ carrierShipmentId }) {
      fake.calls.lookup += 1;
      if (fake.failLookup) throw new CarrierError("easypost", "upstream", "timeout", "unknown");
      const r = fake.sold.get(carrierShipmentId);
      return { label: r ?? null, refundStatus: r?.refundStatus ?? null };
    },
    async void({ carrierShipmentId }) {
      fake.calls.void += 1;
      const r = fake.sold.get(carrierShipmentId);
      if (r) r.refundStatus = "submitted";
      return { ok: true, pending: true };
    },
  };
  return fake;
}

const from = {
  name: "Desert Bloom",
  company: null,
  street1: "100 Main St",
  street2: null,
  city: "Phoenix",
  state: "AZ",
  zip: "85004",
  country: "US",
  phone: null,
  email: null,
};

let companyId: string;
let ctx: ReturnType<typeof tenantContext>;
let etsyConn: string;
let shopifyConn: string;
let carrier: FakeCarrier;
let shopifyCalls: number;
let shopifyFails: boolean;

beforeAll(async () => {
  companyId = (await createCompany()).id;
  const owner = await createUser(companyId, "owner");
  ctx = tenantContext(companyId, owner.id, "owner");
  await createLocation(companyId);
  etsyConn = (await createConnection(companyId, "etsy")).id;
  shopifyConn = (await createConnection(companyId, "shopify")).id;
  await withTenant(companyId, (tx) => svc.updateSettings(tx, ctx, { fromAddress: from }));
});

beforeEach(() => {
  carrier = fakeCarrier();
  shopifyCalls = 0;
  shopifyFails = false;
  vi.mocked(carriersModule.carrierAdapter).mockImplementation(async () => carrier);
  vi.mocked(channelsModule.getChannelAdapter).mockImplementation(async (kind, provider, scope) => {
    if (kind !== "shopify") return realGetChannelAdapter(kind, provider, scope);
    const shopify: ChannelAdapter = {
      ...shopifyAdapter("mock"),
      async pushTracking() {
        shopifyCalls += 1;
        if (shopifyFails) throw new Error("shopify 502");
        return { status: "pushed", externalId: `ful_${shopifyCalls}`, message: null };
      },
    };
    return shopify;
  });
});

async function order(channel: "etsy" | "shopify") {
  const { order, items } = await createOrder(
    companyId,
    channel === "etsy" ? etsyConn : shopifyConn,
    { units: 2, state: "packed", channel },
  );
  await withSystem((tx) =>
    tx.insert(buyerPii).values({
      companyId,
      orderId: order.id,
      name: "Test Buyer",
      street1: "1 Buyer Way",
      city: "Brooklyn",
      state: "NY",
      zip: "11201",
    }),
  );
  return { order, items };
}

/** A labeled Etsy (CSV-only) shipment: no tracking push, units stay packed until the scan. */
async function labeled(channel: "etsy" | "shopify" = "etsy") {
  const { order: o, items } = await order(channel);
  const quote = await svc.rateOrder(ctx, { orderId: o.id });
  const s = await svc.buyLabel(ctx, {
    shipmentId: quote.shipmentId,
    rateId: quote.rates[0]?.rateId as string,
  });
  return { order: o, items, shipment: await row(s.id) };
}

const row = async (id: string) => {
  const [r] = await withSystem((tx) => tx.select().from(shipments).where(eq(shipments.id, id)));
  if (!r) throw new Error("shipment missing");
  return r;
};
const unitStates = async (orderId: string) =>
  (
    await withSystem((tx) =>
      tx
        .select({ state: orderItems.state })
        .from(orderItems)
        .where(eq(orderItems.orderId, orderId)),
    )
  ).map((r) => r.state);

let evtN = 0;
/** A signed EasyPost tracker event, run through the same parse the route uses. */
async function deliver(
  s: { carrierShipmentId: string | null; trackingCode: string | null },
  status: TrackerStatus,
  at: string,
) {
  const eventId = `evt_t32_${Date.now().toString(36)}_${evtN++}`;
  const body = JSON.stringify({
    id: eventId,
    object: "Event",
    description: "tracker.updated",
    mode: "test",
    result: {
      id: `trk_${s.carrierShipmentId}`,
      object: "Tracker",
      tracking_code: s.trackingCode,
      status,
      shipment_id: s.carrierShipmentId,
      tracking_details: [{ status, datetime: at }],
    },
  });
  expect(signEasypostBody(body)).toMatch(/^hmac-sha256-hex=/);
  const e = parseEasypostEvent(body);
  if (!e?.tracker) throw new Error("no tracker");
  expect(await recordCarrierEvent(e.id)).toBe(true);
  const out = await processCarrierEvent({
    eventId: e.id,
    description: e.description,
    tracker: {
      ...e.tracker,
      occurredAt: e.tracker.occurredAt.toISOString(),
      deliveredAt: e.tracker.deliveredAt?.toISOString() ?? null,
    },
  });
  const [rec] = await withSystem((tx) =>
    tx.select().from(carrierWebhookEvents).where(eq(carrierWebhookEvents.eventId, e.id)),
  );
  return { out, rec };
}

describe("EasyPost tracker events", () => {
  it("in_transit on the first scan ships CSV-channel units, then delivered", async () => {
    const { order: o, shipment } = await labeled("etsy");
    expect(shipment.status).toBe("labeled");
    expect(await unitStates(o.id)).toEqual(["packed", "packed"]);

    const t = await deliver(shipment, "in_transit", "2026-09-24T10:00:00Z");
    expect(t.out).toMatchObject({ status: "processed", from: "labeled", to: "in_transit" });
    expect(t.rec).toMatchObject({ status: "processed", companyId });
    expect(await unitStates(o.id)).toEqual(["shipped", "shipped"]);

    const d = await deliver(shipment, "delivered", "2026-09-26T15:00:00Z");
    expect(d.out).toMatchObject({ status: "processed", to: "delivered" });
    const after = await row(shipment.id);
    expect(after.status).toBe("delivered");
    expect(after.deliveredAt?.toISOString()).toBe("2026-09-26T15:00:00.000Z");
    expect(await unitStates(o.id)).toEqual(["delivered", "delivered"]);
  });

  it("out_for_delivery keeps in_transit with the finer status; failure becomes exception", async () => {
    const { shipment } = await labeled("etsy");
    await deliver(shipment, "out_for_delivery", "2026-09-24T10:00:00Z");
    expect(await row(shipment.id)).toMatchObject({
      status: "in_transit",
      trackingStatus: "out_for_delivery",
    });
    const f = await deliver(shipment, "failure", "2026-09-24T18:00:00Z");
    expect(f.out).toMatchObject({ to: "exception" });
    expect(await row(shipment.id)).toMatchObject({
      status: "exception",
      trackingStatus: "failure",
    });
  });

  it("return_to_sender becomes exception", async () => {
    const { shipment } = await labeled("etsy");
    await deliver(shipment, "return_to_sender", "2026-09-24T10:00:00Z");
    expect((await row(shipment.id)).status).toBe("exception");
  });

  it("an older event never moves a shipment back", async () => {
    const { shipment } = await labeled("etsy");
    await deliver(shipment, "delivered", "2026-09-25T12:00:00Z");
    const late = await deliver(shipment, "in_transit", "2026-09-24T09:00:00Z");
    expect(late.out).toMatchObject({ status: "ignored" });
    expect(late.rec).toMatchObject({ status: "ignored" });
    expect((await row(shipment.id)).status).toBe("delivered");

    // Even to a "forward-looking" state: a stale failure after a newer scan is ignored.
    const other = (await labeled("etsy")).shipment;
    await deliver(other, "in_transit", "2026-09-25T12:00:00Z");
    const stale = await deliver(other, "failure", "2026-09-24T12:00:00Z");
    expect(stale.out).toMatchObject({ status: "ignored", reason: expect.stringMatching(/older/) });
    expect((await row(other.id)).status).toBe("in_transit");

    // A later return still applies.
    await deliver(other, "return_to_sender", "2026-09-26T12:00:00Z");
    expect((await row(other.id)).status).toBe("exception");
    // And a delivered shipment never becomes an exception.
    await deliver(shipment, "return_to_sender", "2026-09-27T12:00:00Z");
    expect((await row(shipment.id)).status).toBe("delivered");
  });

  it("ignores trackers with no shipment and pre-transit readings", async () => {
    const none = await deliver(
      { carrierShipmentId: "shp_unknown_t32", trackingCode: "9400NOPE" },
      "in_transit",
      "2026-09-24T10:00:00Z",
    );
    expect(none.out).toMatchObject({ status: "ignored", reason: "no shipment for this tracker" });
    expect(none.rec?.companyId).toBeNull();

    const { shipment } = await labeled("etsy");
    const pre = await deliver(shipment, "pre_transit", "2026-09-24T08:00:00Z");
    expect(pre.out).toMatchObject({ status: "processed", from: "labeled", to: "labeled" });

    const mismatch = await deliver(
      { carrierShipmentId: shipment.carrierShipmentId, trackingCode: "9400SOMEOTHER" },
      "delivered",
      "2026-09-24T10:00:00Z",
    );
    expect(mismatch.out).toMatchObject({ status: "ignored" });
    expect((await row(shipment.id)).status).toBe("labeled");
  });

  it("another company can't see the event rows (RLS) and can't write them (system-only)", async () => {
    const { shipment } = await labeled("etsy");
    const { rec } = await deliver(shipment, "in_transit", "2026-09-24T10:00:00Z");
    const other = (await createCompany()).id;
    const seen = await withTenant(other, (tx) =>
      tx
        .select()
        .from(carrierWebhookEvents)
        .where(eq(carrierWebhookEvents.id, rec?.id as string)),
    );
    expect(seen).toHaveLength(0);
    const own = await withTenant(companyId, (tx) =>
      tx
        .select()
        .from(carrierWebhookEvents)
        .where(eq(carrierWebhookEvents.id, rec?.id as string)),
    );
    expect(own).toHaveLength(1);
    await expect(
      withTenant(companyId, (tx) =>
        tx.insert(carrierWebhookEvents).values({ companyId, provider: "easypost", eventId: "x" }),
      ),
    ).rejects.toThrow();
  });

  it("purges events older than 7 days", async () => {
    await recordCarrierEvent("evt_t32_old");
    await withSystem((tx) =>
      tx
        .update(carrierWebhookEvents)
        .set({ receivedAt: new Date(Date.now() - 8 * 86400_000) })
        .where(eq(carrierWebhookEvents.eventId, "evt_t32_old")),
    );
    expect((await purgeCarrierWebhookEvents()).deleted).toBeGreaterThanOrEqual(1);
  });
});

describe("mock timer and daily poll share the state function", () => {
  it("the mock carrier timer moves labeled -> in_transit -> delivered", async () => {
    const { order: o, shipment } = await labeled("etsy");
    await runJobInline(mockTrackingJob, {
      companyId,
      shipmentId: shipment.id,
      step: "in_transit" as const,
    });
    expect((await row(shipment.id)).status).toBe("in_transit");
    expect(await unitStates(o.id)).toEqual(["shipped", "shipped"]);
    await runJobInline(mockTrackingJob, {
      companyId,
      shipmentId: shipment.id,
      step: "delivered" as const,
    });
    expect((await row(shipment.id)).status).toBe("delivered");
  });

  it("polls shipments stuck in labeled for 3+ days and applies the carrier's tracker", async () => {
    const { shipment } = await labeled("etsy");
    const fresh = (await labeled("etsy")).shipment;
    await withSystem((tx) =>
      tx
        .update(shipments)
        .set({ labeledAt: new Date(Date.now() - 4 * 86400_000) })
        .where(eq(shipments.id, shipment.id)),
    );
    const tracked: string[] = [];
    const tracking: TrackingAdapter = {
      provider: "mock",
      async track(input) {
        tracked.push(input.carrierShipmentId);
        return {
          trackerId: "trk_poll",
          trackingCode: input.trackingCode,
          carrierShipmentId: input.carrierShipmentId,
          status: "delivered",
          statusDetail: null,
          occurredAt: new Date("2026-09-23T12:00:00Z"),
          deliveredAt: new Date("2026-09-23T12:00:00Z"),
        };
      },
    };
    vi.mocked(carriersModule.carrierTracking).mockImplementation(async () => tracking);
    const enqueue = vi.spyOn(pollTrackerJob, "enqueue").mockResolvedValue({} as never);
    const sweep = (await runJobInline(trackerPollSweepJob, {})) as { shipments: number };
    const queuedIds = enqueue.mock.calls.map((c) => c[0].shipmentId);
    expect(queuedIds).toContain(shipment.id);
    expect(queuedIds).not.toContain(fresh.id);
    expect(sweep.shipments).toBeGreaterThanOrEqual(1);
    enqueue.mockRestore();

    await runJobInline(pollTrackerJob, { companyId, shipmentId: shipment.id });
    expect(tracked).toEqual([shipment.carrierShipmentId]);
    expect(await row(shipment.id)).toMatchObject({ status: "delivered" });
  });
});

describe("stuck intent sweep", () => {
  const age = (id: string, minutes = 20) =>
    withSystem((tx) =>
      tx.execute(
        sql`update shipments set updated_at = now() - make_interval(mins => ${minutes}),
          push_attempted_at = case when push_attempted_at is null then null
            else now() - make_interval(mins => ${minutes}) end
          where id = ${id}`,
      ),
    );

  async function rated() {
    const { order: o } = await order("etsy");
    const quote = await svc.rateOrder(ctx, { orderId: o.id });
    return {
      orderId: o.id,
      shipmentId: quote.shipmentId,
      rateId: quote.rates[0]?.rateId as string,
    };
  }

  it("a buy the carrier sold but we never recorded is read back, never bought again", async () => {
    const r = await rated();
    carrier.loseBuyResponse = true;
    await expect(svc.buyLabel(ctx, r)).rejects.toThrow(/couldn't confirm/);
    carrier.loseBuyResponse = false;
    expect((await row(r.shipmentId)).status).toBe("buying");

    expect((await findStuckIntents()).map((i) => i.shipmentId)).not.toContain(r.shipmentId);
    await age(r.shipmentId);
    const stuck = await findStuckIntents();
    expect(stuck).toContainEqual({ shipmentId: r.shipmentId, companyId, kind: "buy" });

    expect(await retryStuckIntent(companyId, r.shipmentId, "buy")).toBe("resolved");
    expect(carrier.calls.buy).toBe(1);
    const s = await row(r.shipmentId);
    expect(s.status).toBe("labeled");
    expect(s.trackingCode).toMatch(/^9400T32/);
  });

  it("a buy the carrier never made goes back to rated without buying", async () => {
    const r = await rated();
    carrier.failBuy = true;
    await expect(svc.buyLabel(ctx, r)).rejects.toThrow();
    carrier.failBuy = false;
    await age(r.shipmentId);
    expect(await retryStuckIntent(companyId, r.shipmentId, "buy")).toBe("resolved");
    expect(carrier.calls.buy).toBe(1);
    expect((await row(r.shipmentId)).status).toBe("rated");
  });

  it("a stuck void is read back and finished", async () => {
    const { shipment } = await labeled("etsy");
    await withSystem((tx) =>
      tx
        .update(shipments)
        .set({ status: "voiding", voidAttemptedAt: null })
        .where(eq(shipments.id, shipment.id)),
    );
    await age(shipment.id);
    expect((await findStuckIntents()).map((i) => i.kind)).toContain("void");
    expect(await retryStuckIntent(companyId, shipment.id, "void")).toBe("resolved");
    expect(carrier.calls.lookup).toBe(1);
    expect(carrier.calls.void).toBe(1);
    expect((await row(shipment.id)).status).toBe("voided");
  });

  it("a stuck push is sent once and its units ship", async () => {
    const { order: o, shipment } = await labeled("shopify");
    await withSystem((tx) =>
      tx
        .update(shipments)
        .set({ trackingPushStatus: "pushing", pushAttemptedAt: new Date() })
        .where(eq(shipments.id, shipment.id)),
    );
    await age(shipment.id);
    expect(await findStuckIntents()).toContainEqual({
      shipmentId: shipment.id,
      companyId,
      kind: "push",
    });
    expect(await retryStuckIntent(companyId, shipment.id, "push")).toBe("resolved");
    expect(shopifyCalls).toBe(1);
    expect((await row(shipment.id)).trackingPushStatus).toBe("pushed");
    expect(await unitStates(o.id)).toEqual(["shipped", "shipped"]);
    // Resolved intents aren't retried again.
    expect(await retryStuckIntent(companyId, shipment.id, "push")).toBe("resolved");
    expect(shopifyCalls).toBe(1);
  });

  it("a failed push goes back to the push job's retry loop", async () => {
    const { shipment } = await labeled("shopify");
    await withSystem((tx) =>
      tx
        .update(shipments)
        .set({ trackingPushStatus: "pushing", pushAttemptedAt: new Date() })
        .where(eq(shipments.id, shipment.id)),
    );
    await age(shipment.id);
    shopifyFails = true;
    const enqueue = vi.spyOn(pushTrackingJob, "enqueue").mockResolvedValue({} as never);
    expect(await retryStuckIntent(companyId, shipment.id, "push")).toBe("failed");
    expect(enqueue).toHaveBeenCalledWith(
      { companyId, shipmentId: shipment.id, attempt: 0 },
      expect.anything(),
    );
    enqueue.mockRestore();
    await redis.del(`stuck-intent:push:${shipment.id}`);
  });

  it(`alerts the shop after ${STUCK_ALERT_AFTER} failed retries`, async () => {
    const r = await rated();
    carrier.loseBuyResponse = true;
    await expect(svc.buyLabel(ctx, r)).rejects.toThrow();
    carrier.loseBuyResponse = false;
    carrier.failLookup = true;
    const results: string[] = [];
    for (let i = 0; i < STUCK_ALERT_AFTER; i++) {
      await age(r.shipmentId);
      results.push(await retryStuckIntent(companyId, r.shipmentId, "buy"));
    }
    expect(results).toEqual(["failed", "failed", "alerted"]);
    expect(carrier.calls.buy).toBe(1);
    const [alert] = await withTenant(companyId, (tx) =>
      tx
        .select()
        .from(alerts)
        .where(
          and(
            eq(alerts.companyId, companyId),
            eq(alerts.dedupeKey, `stuck-intent-buy-${r.shipmentId}`),
          ),
        ),
    );
    expect(alert).toMatchObject({
      entityType: "shipment",
      entityId: r.shipmentId,
      status: "open",
      title: "A label purchase needs a look",
    });

    // Once the carrier answers again, the next retry resolves it and clears the count.
    carrier.failLookup = false;
    expect(await retryStuckIntent(companyId, r.shipmentId, "buy")).toBe("resolved");
    expect((await row(r.shipmentId)).status).toBe("labeled");
    expect(await redis.get(`stuck-intent:buy:${r.shipmentId}`)).toBeNull();
  });

  // T-12-1: every intent kind reaches alertStuck after its retry budget, not only buys.
  const stuckAlert = async (kind: string, shipmentId: string) =>
    (
      await withTenant(companyId, (tx) =>
        tx
          .select()
          .from(alerts)
          .where(
            and(
              eq(alerts.companyId, companyId),
              eq(alerts.dedupeKey, `stuck-intent-${kind}-${shipmentId}`),
            ),
          ),
      )
    )[0];

  it(`a stuck void alerts after ${STUCK_ALERT_AFTER} failed retries`, async () => {
    const { shipment } = await labeled("etsy");
    await withSystem((tx) =>
      tx
        .update(shipments)
        .set({ status: "voiding", voidAttemptedAt: null })
        .where(eq(shipments.id, shipment.id)),
    );
    carrier.failLookup = true;
    const results: string[] = [];
    try {
      for (let i = 0; i < STUCK_ALERT_AFTER; i++) {
        await age(shipment.id);
        results.push(await retryStuckIntent(companyId, shipment.id, "void"));
      }
    } finally {
      carrier.failLookup = false;
    }
    expect(results).toEqual(["failed", "failed", "alerted"]);
    expect(await stuckAlert("void", shipment.id)).toMatchObject({
      entityId: shipment.id,
      title: "A label void needs a look",
    });
    await redis.del(`stuck-intent:void:${shipment.id}`);
  });

  it(`a stuck push alerts after ${STUCK_ALERT_AFTER} failed retries`, async () => {
    const { shipment } = await labeled("shopify");
    await withSystem((tx) =>
      tx
        .update(shipments)
        .set({ trackingPushStatus: "pushing", pushAttemptedAt: new Date() })
        .where(eq(shipments.id, shipment.id)),
    );
    shopifyFails = true;
    const enqueue = vi.spyOn(pushTrackingJob, "enqueue").mockResolvedValue({} as never);
    const results: string[] = [];
    try {
      for (let i = 0; i < STUCK_ALERT_AFTER; i++) {
        await withSystem((tx) =>
          tx
            .update(shipments)
            .set({ trackingPushStatus: "pushing" })
            .where(eq(shipments.id, shipment.id)),
        );
        await age(shipment.id);
        results.push(await retryStuckIntent(companyId, shipment.id, "push"));
      }
    } finally {
      shopifyFails = false;
      enqueue.mockRestore();
    }
    expect(results).toEqual(["failed", "failed", "alerted"]);
    expect(await stuckAlert("push", shipment.id)).toMatchObject({
      entityId: shipment.id,
      title: "Tracking wasn't sent to the channel",
    });
    await redis.del(`stuck-intent:push:${shipment.id}`);
  });
});
