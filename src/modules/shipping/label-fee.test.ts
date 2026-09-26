import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystem, withTenant } from "../../db/client";
import { buyerPii, labels, shipments } from "../../db/schema";
import type { CarrierAdapter, PurchasedLabel } from "../../integrations/carriers";
import * as carriersModule from "../../integrations/carriers";
import {
  createCompany,
  createConnection,
  createOrder,
  createUser,
  tenantContext,
} from "../../test/fixtures";
import { changePlan, currentUsage, PLAN_CATALOG } from "../billing/service";
import * as svc from "./service";

/*
 * T-7-3 (B-69, B-40): the per-label fee written onto the label and shipment rows comes from the
 * company's plan (`PLAN_CATALOG.labelFeeCents`), not the old flat `LABEL_FEE_CENTS` constant --
 * so different plans are charged their own fee, and billing usage (which sums the same
 * `labels.labelFeeCents` column) always agrees with what a label was actually charged.
 */

vi.mock("../../integrations/carriers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../integrations/carriers")>();
  return { ...actual, carrierAdapter: vi.fn(actual.carrierAdapter) };
});

function fakeCarrier(): CarrierAdapter {
  let n = 0;
  const sold = new Map<string, PurchasedLabel>();
  return {
    provider: "easypost",
    async rate(req) {
      n += 1;
      return {
        carrierShipmentId: `shp_fee_${req.shipmentId.slice(0, 8)}_${n}`,
        rates: [
          {
            rateId: `rate_fee_${n}`,
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
      const label: PurchasedLabel = {
        trackingCode: `9400FEE${req.shipmentId.replace(/-/g, "").slice(0, 12)}${n}`,
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

const address = {
  name: "Fee Co",
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

async function packedOrder(companyId: string, connectionId: string) {
  const { order, items } = await createOrder(companyId, connectionId, {
    units: 1,
    state: "packed",
  });
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

describe("label fee follows the plan (T-7-3)", () => {
  let companyId: string;
  let ctx: ReturnType<typeof tenantContext>;
  let connectionId: string;

  beforeAll(async () => {
    companyId = (await createCompany()).id;
    const owner = await createUser(companyId, "owner");
    ctx = tenantContext(companyId, owner.id, "owner");
    connectionId = (await createConnection(companyId, "csv")).id;
    await withTenant(companyId, (tx) => svc.updateSettings(tx, ctx, { fromAddress: address }));
  });

  beforeEach(() => {
    vi.mocked(carriersModule.carrierAdapter).mockImplementation(async () => fakeCarrier());
  });

  it.each(["starter", "growth", "pro", "scale"] as const)(
    "charges the %s plan's own labelFeeCents on the label and shipment rows",
    async (key) => {
      await withTenant(companyId, (tx) => changePlan(tx, ctx, key));
      const expected = PLAN_CATALOG.find((p) => p.key === key)?.labelFeeCents;
      expect(expected).toBeGreaterThan(0);

      const { order } = await packedOrder(companyId, connectionId);
      const quote = await svc.rateOrder(ctx, { orderId: order.id });
      const rateId = quote.rates[0]?.rateId as string;
      const shipment = await svc.buyLabel(ctx, { shipmentId: quote.shipmentId, rateId });
      expect(shipment.labelFee).toBe(expected);

      const [shipmentRow] = await withSystem((tx) =>
        tx.select().from(shipments).where(eq(shipments.id, shipment.id)),
      );
      expect(shipmentRow?.labelFeeCents).toBe(expected);

      const [labelRow] = await withSystem((tx) =>
        tx.select().from(labels).where(eq(labels.shipmentId, shipment.id)),
      );
      expect(labelRow?.labelFeeCents).toBe(expected);
    },
  );

  it("bills the exact fee it charged (billing usage matches the label row)", async () => {
    await withTenant(companyId, (tx) => changePlan(tx, ctx, "growth"));
    const growthFee = PLAN_CATALOG.find((p) => p.key === "growth")?.labelFeeCents as number;
    const before = await withTenant(companyId, (tx) => currentUsage(tx, companyId));

    const { order } = await packedOrder(companyId, connectionId);
    const quote = await svc.rateOrder(ctx, { orderId: order.id });
    const rateId = quote.rates[0]?.rateId as string;
    await svc.buyLabel(ctx, { shipmentId: quote.shipmentId, rateId });

    const after = await withTenant(companyId, (tx) => currentUsage(tx, companyId));
    expect(after.labelFees - before.labelFees).toBe(growthFee);
    expect(after.labelsBought - before.labelsBought).toBe(1);
  });
});
