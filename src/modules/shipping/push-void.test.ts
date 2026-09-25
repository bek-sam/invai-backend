import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystem, withTenant } from "../../db/client";
import { buyerPii, labels, orderItems, shipments } from "../../db/schema";
import type { CarrierAdapter, PurchasedLabel } from "../../integrations/carriers";
import * as carriersModule from "../../integrations/carriers";
import type { ChannelAdapter, TrackingPush } from "../../integrations/channels";
import * as channelsModule from "../../integrations/channels";
import * as outbox from "../../lib/outbox";
import {
  createCompany,
  createConnection,
  createLocation,
  createOrder,
  createUser,
  tenantContext,
} from "../../test/fixtures";
import { cancelOrder, holdOrder, releaseOrder } from "../orders/service";
import * as svc from "./service";

/*
 * T-2-5 (B-44, B-62, B-67, B-71): tracking is pushed once, outside any transaction, and never
 * for a cancelled or held unit; cancelling after a label voids it; CSV-only channels ship on the
 * carrier's scan, so their labels can be voided until then. Carrier and Shopify are fakes that
 * count calls; the outbox `emit` can fail once to simulate a commit failure.
 */

vi.mock("../../integrations/carriers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../integrations/carriers")>();
  return { ...actual, carrierAdapter: vi.fn(actual.carrierAdapter) };
});
vi.mock("../../integrations/channels", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../integrations/channels")>();
  return { ...actual, getChannelAdapter: vi.fn(actual.getChannelAdapter) };
});
vi.mock("../../lib/outbox", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/outbox")>();
  return { ...actual, emit: vi.fn(actual.emit) };
});

import { shopifyAdapter } from "../../integrations/channels/shopify";

const realGetChannelAdapter = vi
  .mocked(channelsModule.getChannelAdapter)
  .getMockImplementation() as typeof channelsModule.getChannelAdapter;

type FakeCarrier = CarrierAdapter & {
  sold: Map<string, PurchasedLabel & { refundStatus: string | null }>;
  calls: { buy: number; void: number; lookup: number };
};

function fakeCarrier(): FakeCarrier {
  const fake: FakeCarrier = {
    provider: "easypost",
    sold: new Map(),
    calls: { buy: 0, void: 0, lookup: 0 },
    async rate(req) {
      return {
        carrierShipmentId: `shp_fake_${req.shipmentId.replace(/-/g, "")}_${Date.now()}`,
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
      const label = {
        trackingCode: `9400FAKE${req.carrierShipmentId.slice(-14)}`,
        trackingUrl: null,
        labelKey: carriersModule.labelObjectKey(req.companyId, req.carrierShipmentId),
        carrierLabelId: `pl_${fake.calls.buy}`,
        postageCents: req.rate.rateCents,
      };
      fake.sold.set(req.carrierShipmentId, { ...label, refundStatus: null });
      return label;
    },
    async lookup({ carrierShipmentId }) {
      fake.calls.lookup += 1;
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

/** Shopify-like: fulfills only what is still open, so a repeat notifies nobody. */
type FakeChannel = ChannelAdapter & {
  notified: TrackingPush[];
  calls: number;
  onPush: (() => Promise<void>) | null;
};

function fakeShopify(): FakeChannel {
  const fulfilled = new Set<string>();
  const fake: FakeChannel = {
    ...shopifyAdapter("mock"),
    notified: [],
    calls: 0,
    onPush: null,
    async pushTracking(_conn, push) {
      fake.calls += 1;
      await fake.onPush?.();
      if (fulfilled.has(push.trackingCode))
        return { status: "pushed", externalId: null, message: "Nothing left to fulfill" };
      fulfilled.add(push.trackingCode);
      fake.notified.push(push);
      return { status: "pushed", externalId: `ful_${fake.notified.length}`, message: null };
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

describe("tracking push, cancel and void after a label", () => {
  let companyId: string;
  let ctx: ReturnType<typeof tenantContext>;
  let shopifyConn: string;
  let etsyConn: string;
  let carrier: FakeCarrier;
  let shopify: FakeChannel;

  beforeAll(async () => {
    companyId = (await createCompany()).id;
    const owner = await createUser(companyId, "owner");
    ctx = tenantContext(companyId, owner.id, "owner");
    await createLocation(companyId);
    shopifyConn = (await createConnection(companyId, "shopify")).id;
    etsyConn = (await createConnection(companyId, "etsy")).id;
    await withTenant(companyId, (tx) => svc.updateSettings(tx, ctx, { fromAddress: from }));
  });

  beforeEach(() => {
    carrier = fakeCarrier();
    shopify = fakeShopify();
    vi.mocked(carriersModule.carrierAdapter).mockImplementation(async () => carrier);
    vi.mocked(channelsModule.getChannelAdapter).mockImplementation(async (kind, provider, scope) =>
      kind === "shopify" ? shopify : realGetChannelAdapter(kind, provider, scope),
    );
    vi.mocked(outbox.emit).mockClear();
  });

  async function labeled(channel: "shopify" | "etsy" = "shopify", units = 1) {
    const { order, items } = await createOrder(
      companyId,
      channel === "shopify" ? shopifyConn : etsyConn,
      { units, state: "packed", channel },
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
    const quote = await svc.rateOrder(ctx, { orderId: order.id });
    const shipment = await svc.buyLabel(ctx, {
      shipmentId: quote.shipmentId,
      rateId: quote.rates[0]?.rateId as string,
    });
    return { order, items, shipment };
  }

  const row = async (id: string) => {
    const [r] = await withSystem((tx) => tx.select().from(shipments).where(eq(shipments.id, id)));
    if (!r) throw new Error("shipment missing");
    return r;
  };
  const states = async (orderId: string) =>
    (
      await withSystem((tx) =>
        tx
          .select({ state: orderItems.state })
          .from(orderItems)
          .where(eq(orderItems.orderId, orderId))
          .orderBy(orderItems.unitNo),
      )
    ).map((r) => r.state);
  const push = (id: string) => svc.pushTracking(companyId, ctx, id);

  describe("pushTracking", () => {
    it("pushes with no row locked, once, and ships the units", async () => {
      const { order, shipment } = await labeled();
      expect(await states(order.id)).toEqual(["packed"]);
      shopify.onPush = async () => {
        const [locked] = await withTenant(companyId, (tx) =>
          tx
            .select()
            .from(shipments)
            .where(eq(shipments.id, shipment.id))
            .for("update", { noWait: true }),
        );
        expect(locked).toMatchObject({ trackingPushStatus: "pushing" });
        expect(locked?.pushAttemptedAt).toBeInstanceOf(Date);
      };
      expect(await push(shipment.id)).toBe("pushed");
      expect(await push(shipment.id)).toBe("skipped");
      expect(shopify.calls).toBe(1);
      expect(await row(shipment.id)).toMatchObject({
        trackingPushStatus: "pushed",
        pushAttemptedAt: null,
      });
      expect(await states(order.id)).toEqual(["shipped"]);
    });

    it("a commit failure after the channel took it never notifies the buyer twice", async () => {
      const { shipment } = await labeled();
      vi.mocked(outbox.emit).mockImplementationOnce(async () => {
        throw new Error("simulated commit failure");
      });
      expect(await push(shipment.id)).toBe("retry");
      expect(await row(shipment.id)).toMatchObject({
        trackingPushStatus: "pushing",
        pushAttemptedAt: null,
      });
      expect(await push(shipment.id)).toBe("pushed");
      expect(shopify.calls).toBe(2);
      expect(shopify.notified).toHaveLength(1);
    });

    it("waits while another push is in flight", async () => {
      const { shipment } = await labeled();
      await withSystem((tx) =>
        tx
          .update(shipments)
          .set({ trackingPushStatus: "pushing", pushAttemptedAt: new Date() })
          .where(eq(shipments.id, shipment.id)),
      );
      expect(await push(shipment.id)).toBe("busy");
      expect(shopify.calls).toBe(0);
      const api = await withTenant(companyId, (tx) => svc.getShipment(tx, ctx, shipment.id));
      expect(api.trackingPush.status).toBe("pending");
    });

    it("leaves cancelled units out and never pushes an all-cancelled package", async () => {
      const { shipment, items } = await labeled("shopify", 2);
      await withSystem((tx) =>
        tx
          .update(orderItems)
          .set({ state: "cancelled" })
          .where(eq(orderItems.id, items[0]?.id as string)),
      );
      expect(await push(shipment.id)).toBe("pushed");
      expect(shopify.notified[0]?.items).toEqual([{ channelLineId: "L1", quantity: 1 }]);

      const other = await labeled("shopify", 1);
      await withSystem((tx) =>
        tx
          .update(orderItems)
          .set({ state: "cancelled" })
          .where(eq(orderItems.orderId, other.order.id)),
      );
      expect(await push(other.shipment.id)).toBe("skipped");
      expect(shopify.calls).toBe(1);
      expect((await row(other.shipment.id)).trackingPushStatus).toBe("not_required");
    });

    it("a hold blocks the push until it is released", async () => {
      const { order, shipment } = await labeled();
      await withTenant(companyId, (tx) =>
        holdOrder(tx, ctx, { id: order.id, reason: "buyer_request", note: null }),
      );
      expect(await push(shipment.id)).toBe("held");
      expect(shopify.calls).toBe(0);
      expect((await row(shipment.id)).trackingPushStatus).toBe("pending");
      await withTenant(companyId, (tx) => releaseOrder(tx, ctx, order.id));
      expect(await svc.pushReleasedShipments(ctx, order.id)).toEqual(["pushed"]);
      expect(shopify.calls).toBe(1);
      expect(await states(order.id)).toEqual(["shipped"]);
    });

    it("a hold is refused while tracking is being sent", async () => {
      const { order, shipment } = await labeled();
      await withSystem((tx) =>
        tx
          .update(shipments)
          .set({ trackingPushStatus: "pushing", pushAttemptedAt: new Date() })
          .where(eq(shipments.id, shipment.id)),
      );
      await expect(
        withTenant(companyId, (tx) =>
          holdOrder(tx, ctx, { id: order.id, reason: "buyer_request", note: null }),
        ),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(await states(order.id)).toEqual(["packed"]);
    });
  });

  describe("cancel after a label", () => {
    it("cancelling voids the label and blocks its push", async () => {
      const { order, shipment } = await labeled();
      await withTenant(companyId, (tx) =>
        cancelOrder(tx, ctx, { id: order.id, reason: "buyer_request", note: null }),
      );
      expect((await row(shipment.id)).trackingPushStatus).toBe("not_required");
      expect(await push(shipment.id)).toBe("skipped");
      expect(shopify.calls).toBe(0);

      expect(await svc.voidCancelledLabels(ctx, order.id)).toEqual({
        voided: 1,
        failed: 0,
        retry: false,
      });
      expect(carrier.calls.void).toBe(1);
      expect(await row(shipment.id)).toMatchObject({ status: "voided", trackingCode: null });
      const [label] = await withSystem((tx) =>
        tx.select().from(labels).where(eq(labels.shipmentId, shipment.id)),
      );
      // EasyPost refunds asynchronously: pending until the refund succeeds.
      expect(label?.status).toBe("refund_pending");
      // Running the job again is a no-op.
      await svc.voidCancelledLabels(ctx, order.id);
      expect(carrier.calls.void).toBe(1);
    });

    it("a cancel is refused once tracking was sent, with a clear message", async () => {
      const { order, items, shipment } = await labeled();
      await push(shipment.id);
      await expect(
        withTenant(companyId, (tx) =>
          cancelOrder(tx, ctx, {
            id: order.id,
            reason: "buyer_request",
            note: null,
            orderItemIds: [items[0]?.id as string],
          }),
        ),
      ).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringMatching(/shipped/) });

      const other = await labeled();
      await withSystem((tx) =>
        tx
          .update(shipments)
          .set({ trackingPushStatus: "pushing", pushAttemptedAt: new Date() })
          .where(eq(shipments.id, other.shipment.id)),
      );
      await expect(
        withTenant(companyId, (tx) =>
          cancelOrder(tx, ctx, { id: other.order.id, reason: "buyer_request", note: null }),
        ),
      ).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringMatching(/being sent/) });
      expect(await states(other.order.id)).toEqual(["packed"]);
    });

    it("a cancel during the buy is voided once the buy lands, and never pushed", async () => {
      const { order, items } = await createOrder(companyId, shopifyConn, {
        units: 1,
        state: "packed",
        channel: "shopify",
      });
      await withSystem((tx) =>
        tx.insert(buyerPii).values({
          companyId,
          orderId: order.id,
          name: "B",
          street1: "1 Way",
          city: "Brooklyn",
          state: "NY",
          zip: "11201",
        }),
      );
      const quote = await svc.rateOrder(ctx, { orderId: order.id });
      carrier.buy = (async (req) => {
        // The shop cancels while the carrier is selling the label.
        await withTenant(companyId, (tx) =>
          cancelOrder(tx, ctx, { id: order.id, reason: "buyer_request", note: null }),
        );
        return fakeCarrier().buy.call(carrier, req);
      }) as CarrierAdapter["buy"];
      const s = await svc.buyLabel(ctx, {
        shipmentId: quote.shipmentId,
        rateId: quote.rates[0]?.rateId as string,
      });
      expect(s.status).toBe("labeled");
      expect(s.trackingPush.status).toBe("not_required");
      expect(await push(s.id)).toBe("skipped");
      expect((await svc.voidCancelledLabels(ctx, order.id)).voided).toBe(1);
      expect((await row(s.id)).status).toBe("voided");
      expect(await states(order.id)).toEqual(["cancelled"]);
      expect(items).toHaveLength(1);
    });
  });

  describe("CSV-only channels (Etsy while pending approval)", () => {
    it("aren't counted as pushed: units ship on the carrier scan, and the label voids until then", async () => {
      const a = await labeled("etsy");
      expect(await push(a.shipment.id)).toBe("skipped");
      const r = await row(a.shipment.id);
      expect(r.trackingPushStatus).toBe("not_required");
      expect(r.trackingPushError).toMatch(/manually/i);
      expect(await states(a.order.id)).toEqual(["packed"]);
      const voided = await svc.voidShipment(ctx, { id: a.shipment.id, reason: "wrong box" });
      expect(voided.status).toBe("voided");
      expect(await states(a.order.id)).toEqual(["packed"]);

      const b = await labeled("etsy");
      await push(b.shipment.id);
      await withTenant(companyId, (tx) => svc.markInTransit(tx, ctx, b.shipment.id));
      expect(await states(b.order.id)).toEqual(["shipped"]);
      await expect(svc.voidShipment(ctx, { id: b.shipment.id })).rejects.toMatchObject({
        code: "VOID_REJECTED",
      });
    });
  });

  describe("voidShipment", () => {
    it("a commit failure after the carrier refunded never refunds twice on retry", async () => {
      const { shipment } = await labeled("etsy");
      vi.mocked(outbox.emit).mockImplementationOnce(async () => {
        throw new Error("simulated commit failure");
      });
      await expect(svc.voidShipment(ctx, { id: shipment.id })).rejects.toThrow(/simulated/);
      expect(await row(shipment.id)).toMatchObject({ status: "voiding" });
      const api = await withTenant(companyId, (tx) => svc.getShipment(tx, ctx, shipment.id));
      expect(api.status).toBe("labeled");
      // Still in flight: refused; then read back instead of refunding again.
      await expect(svc.voidShipment(ctx, { id: shipment.id })).rejects.toMatchObject({
        code: "CONFLICT",
      });
      await withSystem((tx) =>
        tx
          .update(shipments)
          .set({ voidAttemptedAt: new Date(Date.now() - svc.VOID_IN_FLIGHT_MS - 1000) })
          .where(eq(shipments.id, shipment.id)),
      );
      const voided = await svc.voidShipment(ctx, { id: shipment.id });
      expect(voided.status).toBe("voided");
      expect(carrier.calls.void).toBe(1);
      expect(carrier.calls.lookup).toBe(1);
    });

    it("a voiding shipment is never pushed", async () => {
      const { shipment } = await labeled();
      await withSystem((tx) =>
        tx
          .update(shipments)
          .set({ status: "voiding", voidAttemptedAt: new Date() })
          .where(eq(shipments.id, shipment.id)),
      );
      expect(await push(shipment.id)).toBe("busy");
      expect(shopify.calls).toBe(0);
    });

    it("another company can't void this label", async () => {
      const { shipment } = await labeled("etsy");
      const other = (await createCompany()).id;
      const otherCtx = tenantContext(other, (await createUser(other, "owner")).id, "owner");
      await expect(svc.voidShipment(otherCtx, { id: shipment.id })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      expect(carrier.calls.void).toBe(0);
    });
  });
});
