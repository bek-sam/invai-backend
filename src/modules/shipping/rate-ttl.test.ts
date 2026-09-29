import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystem, withTenant } from "../../db/client";
import { buyerPii, shipments } from "../../db/schema";
import type { CarrierAdapter, PurchasedLabel } from "../../integrations/carriers";
import * as carriersModule from "../../integrations/carriers";
import {
  createCompany,
  createConnection,
  createOrder,
  createUser,
  tenantContext,
} from "../../test/fixtures";
import * as svc from "./service";

/*
 * B-25 rate TTL (T-22-3): every rate carries `expiresAt`; a buy past it re-rates first, buys on
 * the fresh quote when the price is the same, and stops with RATE_EXPIRED when it moved, so no
 * label is bought at a price nobody saw.
 */

vi.mock("../../integrations/carriers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../integrations/carriers")>();
  return { ...actual, carrierAdapter: vi.fn(actual.carrierAdapter) };
});

let priceCents = 512;
const calls = { rate: 0, buy: 0 };

function fakeCarrier(): CarrierAdapter {
  const sold = new Map<string, PurchasedLabel>();
  return {
    provider: "easypost",
    async rate(req) {
      calls.rate += 1;
      const n = calls.rate;
      return {
        carrierShipmentId: `shp_ttl_${req.shipmentId.slice(0, 8)}_${n}`,
        rates: [
          {
            rateId: `rate_ttl_${n}`,
            carrier: "usps",
            service: "GroundAdvantage",
            serviceLabel: "USPS Ground Advantage",
            rateCents: priceCents,
            deliveryDays: 3,
            estimatedDeliveryAt: null,
          },
        ],
      };
    },
    async buy(req) {
      calls.buy += 1;
      const label: PurchasedLabel = {
        trackingCode: `9400TTL${req.carrierShipmentId.replace(/\W/g, "").slice(-14)}`,
        trackingUrl: null,
        labelKey: carriersModule.labelObjectKey(req.companyId, req.carrierShipmentId),
        carrierLabelId: `pl_${req.carrierShipmentId}`,
        postageCents: req.rate.rateCents,
      };
      sold.set(req.carrierShipmentId, label);
      return label;
    },
    async lookup({ carrierShipmentId }) {
      return { label: sold.get(carrierShipmentId) ?? null, refundStatus: null };
    },
    async void() {
      return { ok: true, pending: false };
    },
  };
}

const from = {
  name: "TTL Tees",
  company: null,
  street1: "1 Main St",
  street2: null,
  city: "Phoenix",
  state: "AZ",
  zip: "85004",
  country: "US",
  phone: null,
  email: null,
};

let companyId: string;
let connectionId: string;
let ctx: ReturnType<typeof tenantContext>;
let carrier: CarrierAdapter;

async function packedOrder() {
  const { order } = await createOrder(companyId, connectionId, { units: 1, state: "packed" });
  await withSystem((tx) =>
    tx.insert(buyerPii).values({
      companyId,
      orderId: order.id,
      name: "Riley Park",
      street1: "300 Test Blvd",
      city: "Mesa",
      state: "AZ",
      zip: "85201",
    }),
  );
  return order;
}

/** Make the stored quote a day and a bit old, as if rated yesterday. */
const age = (shipmentId: string) =>
  withSystem((tx) =>
    tx
      .update(shipments)
      .set({ ratedAt: new Date(Date.now() - 25 * 3600_000) })
      .where(eq(shipments.id, shipmentId)),
  );

beforeAll(async () => {
  companyId = (await createCompany()).id;
  const owner = await createUser(companyId, "owner");
  ctx = tenantContext(companyId, owner.id, "owner");
  connectionId = (await createConnection(companyId, "csv")).id;
  await withTenant(companyId, (tx) => svc.updateSettings(tx, ctx, { fromAddress: from }));
});

beforeEach(() => {
  priceCents = 512;
  calls.rate = 0;
  calls.buy = 0;
  carrier = fakeCarrier();
  vi.mocked(carriersModule.carrierAdapter).mockImplementation(async () => carrier);
});

describe("rate TTL (B-25)", () => {
  it("every rate carries expiresAt, one TTL after rating", async () => {
    const order = await packedOrder();
    const r = await svc.rateOrder(ctx, { orderId: order.id });
    const [rate] = r.rates;
    expect(rate?.expiresAt).toBeDefined();
    const ttl = Date.parse(rate?.expiresAt as string) - Date.parse(r.ratedAt);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(carriersModule.RATE_TTL_MS);
  });

  it("an expired quote at the same price is re-rated, then bought once at that price", async () => {
    const order = await packedOrder();
    const r = await svc.rateOrder(ctx, { orderId: order.id });
    await age(r.shipmentId);
    const bought = await svc.buyLabel(ctx, {
      shipmentId: r.shipmentId,
      rateId: r.rates[0]?.rateId as string,
    });
    expect(calls).toEqual({ rate: 2, buy: 1 });
    expect(bought).toMatchObject({ status: "labeled", postage: 512 });
  });

  it("an expired quote whose price moved is not bought: RATE_EXPIRED with the new quote stored", async () => {
    const order = await packedOrder();
    const r = await svc.rateOrder(ctx, { orderId: order.id });
    await age(r.shipmentId);
    priceCents = 634;
    const err = await svc
      .buyLabel(ctx, { shipmentId: r.shipmentId, rateId: r.rates[0]?.rateId as string })
      .catch((e) => e);
    expect(err).toMatchObject({ code: "RATE_EXPIRED", status: 409 });
    expect(err.message).toMatch(/price for this service changed/);
    expect(calls).toEqual({ rate: 2, buy: 0 });
    const [s] = await withTenant(companyId, (tx) =>
      tx.select().from(shipments).where(eq(shipments.id, r.shipmentId)),
    );
    expect(s?.status).toBe("rated");
    expect(s?.rateQuotes.map((q) => q.rate)).toEqual([634]);

    // The shop saw the new price and buys it: one label, at 634.
    const again = await svc.buyLabel(ctx, {
      shipmentId: r.shipmentId,
      rateId: s?.rateQuotes[0]?.rateId as string,
    });
    expect(again).toMatchObject({ status: "labeled", postage: 634 });
    expect(calls.buy).toBe(1);
  });

  it("a fresh quote is bought without re-rating", async () => {
    const order = await packedOrder();
    const r = await svc.rateOrder(ctx, { orderId: order.id });
    await svc.buyLabel(ctx, { shipmentId: r.shipmentId, rateId: r.rates[0]?.rateId as string });
    expect(calls).toEqual({ rate: 1, buy: 1 });
  });
});
