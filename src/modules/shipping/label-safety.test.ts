import { and, eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystem, withTenant } from "../../db/client";
import { buyerPii, labels, orders, shipments } from "../../db/schema";
import type { BuyRequest, CarrierAdapter, PurchasedLabel } from "../../integrations/carriers";
import * as carriersModule from "../../integrations/carriers";
import * as outbox from "../../lib/outbox";
import {
  createCompany,
  createConnection,
  createOrder,
  createUser,
  tenantContext,
} from "../../test/fixtures";
import * as svc from "./service";

/*
 * T-2-5 (B-11, B-71): labels are bought once. The carrier is a fake that counts calls and keeps
 * what it sold (like EasyPost's shipment records); the outbox `emit` can be made to fail once to
 * simulate a commit failure after the carrier charged.
 */

vi.mock("../../integrations/carriers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../integrations/carriers")>();
  return { ...actual, carrierAdapter: vi.fn(actual.carrierAdapter) };
});
vi.mock("../../lib/outbox", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/outbox")>();
  return { ...actual, emit: vi.fn(actual.emit) };
});

type Fake = CarrierAdapter & {
  sold: Map<string, PurchasedLabel>;
  calls: { rate: number; buy: number; lookup: number; void: number };
  failNextBuy: carriersModule.CarrierError | null;
  onRate: (() => Promise<void>) | null;
  onBuy: ((req: BuyRequest) => Promise<void>) | null;
};

function fakeCarrier(): Fake {
  const fake: Fake = {
    provider: "easypost",
    sold: new Map(),
    calls: { rate: 0, buy: 0, lookup: 0, void: 0 },
    failNextBuy: null,
    onRate: null,
    onBuy: null,
    async rate(req) {
      fake.calls.rate += 1;
      await fake.onRate?.();
      return {
        carrierShipmentId: `shp_fake_${req.shipmentId.slice(0, 8)}_${fake.calls.rate}`,
        rates: [
          {
            rateId: `rate_${fake.calls.rate}_ga`,
            carrier: "usps",
            service: "GroundAdvantage",
            serviceLabel: "USPS Ground Advantage",
            rateCents: 512,
            deliveryDays: 3,
            estimatedDeliveryAt: null,
          },
          {
            rateId: `rate_${fake.calls.rate}_pm`,
            carrier: "usps",
            service: "Priority",
            serviceLabel: "USPS Priority Mail",
            rateCents: 910,
            deliveryDays: 2,
            estimatedDeliveryAt: null,
          },
        ],
      };
    },
    async buy(req) {
      fake.calls.buy += 1;
      await fake.onBuy?.(req);
      const failure = fake.failNextBuy;
      fake.failNextBuy = null;
      if (failure?.outcome === "not_done") throw failure;
      if (fake.sold.has(req.carrierShipmentId))
        throw new carriersModule.CarrierError("fake", "upstream", "already bought", "not_done");
      const n = fake.sold.size + fake.calls.buy;
      const label: PurchasedLabel = {
        trackingCode: `9400FAKE${req.shipmentId.replace(/-/g, "").slice(0, 10)}${n}`,
        trackingUrl: null,
        labelKey: carriersModule.labelObjectKey(req.companyId, req.carrierShipmentId),
        carrierLabelId: `pl_${req.carrierShipmentId}`,
        postageCents: req.rate.rateCents,
      };
      fake.sold.set(req.carrierShipmentId, label);
      // An "unknown" failure: the carrier charged, but the answer was lost.
      if (failure) throw failure;
      return label;
    },
    async lookup({ carrierShipmentId }) {
      fake.calls.lookup += 1;
      return { label: fake.sold.get(carrierShipmentId) ?? null, refundStatus: null };
    },
    async void() {
      fake.calls.void += 1;
      return { ok: true, pending: false };
    },
  };
  return fake;
}

const address = {
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

describe("label buy safety", () => {
  let companyId: string;
  let ctx: ReturnType<typeof tenantContext>;
  let connectionId: string;
  let fake: Fake;

  beforeAll(async () => {
    companyId = (await createCompany()).id;
    const owner = await createUser(companyId, "owner");
    ctx = tenantContext(companyId, owner.id, "owner");
    connectionId = (await createConnection(companyId, "csv")).id;
    await withTenant(companyId, (tx) => svc.updateSettings(tx, ctx, { fromAddress: address }));
  });

  beforeEach(() => {
    fake = fakeCarrier();
    vi.mocked(carriersModule.carrierAdapter).mockImplementation(() => fake);
    vi.mocked(outbox.emit).mockClear();
  });

  /** A packed order with a ship-to address. */
  async function packedOrder(units = 1) {
    const { order, items } = await createOrder(companyId, connectionId, { units, state: "packed" });
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

  async function row(id: string) {
    const [r] = await withSystem((tx) => tx.select().from(shipments).where(eq(shipments.id, id)));
    if (!r) throw new Error("shipment missing");
    return r;
  }

  async function labelRows(shipmentId: string) {
    return withSystem((tx) => tx.select().from(labels).where(eq(labels.shipmentId, shipmentId)));
  }

  async function rated(units = 1) {
    const { order, items } = await packedOrder(units);
    const quote = await svc.rateOrder(ctx, { orderId: order.id });
    const rateId = quote.rates[0]?.rateId as string;
    return { order, items, quote, rateId, shipmentId: quote.shipmentId };
  }

  describe("rateOrder", () => {
    it("calls the carrier with no row locked, then stores the quotes", async () => {
      const { order } = await packedOrder();
      fake.onRate = async () => {
        // Neither the order nor its shipment is locked while the carrier is called.
        await withTenant(companyId, async (tx) => {
          await tx
            .select()
            .from(orders)
            .where(eq(orders.id, order.id))
            .for("update", { noWait: true });
          await tx
            .select()
            .from(shipments)
            .where(eq(shipments.orderId, order.id))
            .for("update", { noWait: true });
        });
      };
      const quote = await svc.rateOrder(ctx, { orderId: order.id });
      expect(fake.calls.rate).toBe(1);
      expect(quote.rates.map((r) => r.rate)).toEqual([512, 910]);
      const s = await row(quote.shipmentId);
      expect(s).toMatchObject({
        status: "rated",
        carrierShipmentId: expect.stringMatching(/^shp_fake_/),
      });
      expect(s.rateQuotes).toHaveLength(2);
    });

    it("rating again reuses the open shipment", async () => {
      const { order } = await packedOrder();
      const a = await svc.rateOrder(ctx, { orderId: order.id });
      const b = await svc.rateOrder(ctx, { orderId: order.id });
      expect(b.shipmentId).toBe(a.shipmentId);
      expect((await row(b.shipmentId)).carrierShipmentId).toMatch(/_2$/);
    });

    it("won't rate an order that already has a label or a buy in flight", async () => {
      const { order, shipmentId, rateId } = await rated();
      await svc.buyLabel(ctx, { shipmentId, rateId });
      await expect(svc.rateOrder(ctx, { orderId: order.id })).rejects.toMatchObject({
        code: "CONFLICT",
      });

      const other = await rated();
      await withSystem((tx) =>
        tx
          .update(shipments)
          .set({ status: "buying", buyAttemptedAt: new Date() })
          .where(eq(shipments.id, other.shipmentId)),
      );
      await expect(svc.rateOrder(ctx, { orderId: other.order.id })).rejects.toMatchObject({
        code: "CONFLICT",
      });
      expect(fake.calls.rate).toBe(2);
    });

    it("doesn't overwrite the quotes of a shipment whose buy started meanwhile", async () => {
      const { order, shipmentId } = await rated();
      fake.onRate = async () => {
        await withSystem((tx) =>
          tx.update(shipments).set({ status: "buying" }).where(eq(shipments.id, shipmentId)),
        );
      };
      const before = (await row(shipmentId)).carrierShipmentId;
      await expect(svc.rateOrder(ctx, { orderId: order.id })).rejects.toMatchObject({
        code: "CONFLICT",
      });
      expect((await row(shipmentId)).carrierShipmentId).toBe(before);
    });
  });

  describe("buyLabel", () => {
    it("records intent, buys outside any transaction, then records one label", async () => {
      const { shipmentId, rateId, items } = await rated();
      fake.onBuy = async () => {
        // The shipment is committed as `buying` and not locked while the carrier is called.
        const [locked] = await withTenant(companyId, (tx) =>
          tx
            .select()
            .from(shipments)
            .where(eq(shipments.id, shipmentId))
            .for("update", { noWait: true }),
        );
        expect(locked).toMatchObject({ status: "buying", selectedRateId: rateId });
        expect(locked?.buyAttemptedAt).toBeInstanceOf(Date);
        // The API doesn't expose the internal state.
        const api = await withTenant(companyId, (tx) => svc.getShipment(tx, ctx, shipmentId));
        expect(api.status).toBe("rated");
      };
      const bought = await svc.buyLabel(ctx, { shipmentId, rateId });
      expect(bought).toMatchObject({
        status: "labeled",
        postage: 512,
        orderItemIds: [items[0]?.id],
      });
      expect((await row(shipmentId)).buyAttemptedAt).toBeNull();
      const rows = await labelRows(shipmentId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: "purchased", postageCents: 512 });
    });

    it("buying twice charges once and returns the stored label", async () => {
      const { shipmentId, rateId } = await rated();
      const first = await svc.buyLabel(ctx, { shipmentId, rateId });
      const again = await svc.buyLabel(ctx, { shipmentId, rateId });
      expect(fake.calls.buy).toBe(1);
      expect(again.trackingCode).toBe(first.trackingCode);
      expect(await labelRows(shipmentId)).toHaveLength(1);
    });

    it("a commit failure after the carrier charged never buys twice on retry", async () => {
      const { shipmentId, rateId } = await rated();
      vi.mocked(outbox.emit).mockImplementationOnce(async () => {
        throw new Error("simulated commit failure");
      });
      await expect(svc.buyLabel(ctx, { shipmentId, rateId })).rejects.toThrow(
        /simulated commit failure/,
      );
      expect(fake.calls.buy).toBe(1);
      const stuck = await row(shipmentId);
      expect(stuck).toMatchObject({ status: "buying", buyAttemptedAt: null, trackingCode: null });
      expect(await labelRows(shipmentId)).toHaveLength(0);

      const retried = await svc.buyLabel(ctx, { shipmentId, rateId });
      expect(fake.calls.lookup).toBe(1);
      expect(fake.calls.buy).toBe(1);
      expect(retried.status).toBe("labeled");
      expect(retried.trackingCode).toBe(fake.sold.values().next().value?.trackingCode);
      expect(await labelRows(shipmentId)).toHaveLength(1);
    });

    it("a crash mid-call blocks a retry while in flight, then reads back before buying", async () => {
      const { shipmentId, rateId } = await rated();
      const carrierShipmentId = (await row(shipmentId)).carrierShipmentId as string;
      // As if the process died after tx 1 committed and the carrier sold the label.
      fake.sold.set(carrierShipmentId, {
        trackingCode: `9400EARLIER${shipmentId.slice(0, 8)}`,
        trackingUrl: null,
        labelKey: carriersModule.labelObjectKey(companyId, carrierShipmentId),
        carrierLabelId: "pl_earlier",
        postageCents: 512,
      });
      await withSystem((tx) =>
        tx
          .update(shipments)
          .set({ status: "buying", selectedRateId: rateId, buyAttemptedAt: new Date() })
          .where(eq(shipments.id, shipmentId)),
      );
      await expect(svc.buyLabel(ctx, { shipmentId, rateId })).rejects.toMatchObject({
        code: "CONFLICT",
      });

      await withSystem((tx) =>
        tx
          .update(shipments)
          .set({ buyAttemptedAt: new Date(Date.now() - svc.BUY_IN_FLIGHT_MS - 1000) })
          .where(eq(shipments.id, shipmentId)),
      );
      const resumed = await svc.buyLabel(ctx, { shipmentId, rateId });
      expect(fake.calls.buy).toBe(0);
      expect(resumed).toMatchObject({
        status: "labeled",
        trackingCode: `9400EARLIER${shipmentId.slice(0, 8)}`,
      });
    });

    it("a stale buying shipment the carrier never sold is bought once", async () => {
      const { shipmentId, rateId } = await rated();
      await withSystem((tx) =>
        tx
          .update(shipments)
          .set({ status: "buying", selectedRateId: rateId, buyAttemptedAt: null })
          .where(eq(shipments.id, shipmentId)),
      );
      const resumed = await svc.buyLabel(ctx, { shipmentId, rateId });
      expect(fake.calls.lookup).toBe(1);
      expect(fake.calls.buy).toBe(1);
      expect(resumed.status).toBe("labeled");
    });

    it("a clear refusal goes back to rated", async () => {
      const { shipmentId, rateId } = await rated();
      fake.failNextBuy = new carriersModule.CarrierError("fake", "rate_expired", "rate expired");
      await expect(svc.buyLabel(ctx, { shipmentId, rateId })).rejects.toMatchObject({
        code: "RATE_EXPIRED",
      });
      expect(await row(shipmentId)).toMatchObject({ status: "rated", buyAttemptedAt: null });
    });

    it("an unknown outcome stays buying and the retry reads back instead of buying", async () => {
      const { shipmentId, rateId } = await rated();
      fake.failNextBuy = new carriersModule.CarrierError("fake", "upstream", "timeout", "unknown");
      await expect(svc.buyLabel(ctx, { shipmentId, rateId })).rejects.toMatchObject({
        code: "UPSTREAM_FAILED",
      });
      expect(await row(shipmentId)).toMatchObject({ status: "buying", buyAttemptedAt: null });
      const retried = await svc.buyLabel(ctx, { shipmentId, rateId });
      expect(fake.calls.buy).toBe(1);
      expect(fake.calls.lookup).toBe(1);
      expect(retried.status).toBe("labeled");
      expect(await labelRows(shipmentId)).toHaveLength(1);
    });

    it("a different rate while a buy is pending is a conflict", async () => {
      const { shipmentId, rateId, quote } = await rated();
      await withSystem((tx) =>
        tx
          .update(shipments)
          .set({ status: "buying", selectedRateId: rateId, buyAttemptedAt: null })
          .where(eq(shipments.id, shipmentId)),
      );
      await expect(
        svc.buyLabel(ctx, { shipmentId, rateId: quote.rates[1]?.rateId as string }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(fake.calls.buy + fake.calls.lookup).toBe(0);
    });

    it("an expired quote is refused before any carrier call", async () => {
      const { shipmentId, rateId } = await rated();
      await withSystem((tx) =>
        tx
          .update(shipments)
          .set({ ratedAt: new Date(Date.now() - 25 * 3600_000) })
          .where(eq(shipments.id, shipmentId)),
      );
      await expect(svc.buyLabel(ctx, { shipmentId, rateId })).rejects.toMatchObject({
        code: "RATE_EXPIRED",
      });
      expect(fake.calls.buy).toBe(0);
      expect((await row(shipmentId)).status).toBe("rated");
    });

    it("the database holds one purchased label per shipment", async () => {
      const { shipmentId, rateId } = await rated();
      await svc.buyLabel(ctx, { shipmentId, rateId });
      const [first] = await labelRows(shipmentId);
      await expect(
        withSystem((tx) =>
          tx.insert(labels).values({
            companyId,
            shipmentId,
            carrier: "usps",
            service: "GroundAdvantage",
            trackingCode: "9400DUPLICATE",
            labelKey: first?.labelKey as string,
            postageCents: 512,
          }),
        ),
      ).rejects.toThrow();
      const purchased = await withSystem((tx) =>
        tx
          .select()
          .from(labels)
          .where(and(eq(labels.shipmentId, shipmentId), eq(labels.status, "purchased"))),
      );
      expect(purchased).toHaveLength(1);
    });

    it("another company can't buy or read this shipment", async () => {
      const { shipmentId, rateId } = await rated();
      const other = (await createCompany()).id;
      const otherCtx = tenantContext(other, (await createUser(other, "owner")).id, "owner");
      await expect(svc.buyLabel(otherCtx, { shipmentId, rateId })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      expect(fake.calls.buy).toBe(0);
      expect((await row(shipmentId)).status).toBe("rated");
    });
  });
});
