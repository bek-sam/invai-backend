import { eq, sql } from "drizzle-orm";
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
import { zip3Of, zoneForZip3, zoneForZips } from "./zone";

vi.mock("../../integrations/carriers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../integrations/carriers")>();
  return { ...actual, carrierAdapter: vi.fn(actual.carrierAdapter) };
});

describe("zoneForZip3 (T-A4, AC-A4)", () => {
  it("matches the USPS zone for common pairs from Phoenix", () => {
    expect(zoneForZip3("850", "850")).toBe(1);
    expect(zoneForZip3("850", "852")).toBe(1);
    expect(zoneForZip3("850", "857")).toBe(2); // Tucson ~110 mi
    expect(zoneForZip3("850", "900")).toBe(4); // Los Angeles ~360 mi
    expect(zoneForZip3("850", "980")).toBe(6); // Seattle ~1,110 mi
    expect(zoneForZip3("850", "606")).toBe(7); // Chicago ~1,450 mi
    expect(zoneForZip3("850", "100")).toBe(8); // New York ~2,140 mi
    expect(zoneForZip3("850", "967")).toBe(8); // Honolulu
    expect(zoneForZip3("850", "969")).toBe(9); // Guam
  });

  it("is symmetric and always 1..9 for every civilian ZIP3 pair it knows", () => {
    for (let o = 0; o < 1000; o += 7) {
      for (let d = 0; d < 1000; d += 11) {
        const a = String(o).padStart(3, "0");
        const b = String(d).padStart(3, "0");
        const z = zoneForZip3(a, b);
        expect(z).toBe(zoneForZip3(b, a));
        if (z !== null) {
          expect(Number.isInteger(z)).toBe(true);
          expect(z).toBeGreaterThanOrEqual(1);
          expect(z).toBeLessThanOrEqual(9);
        }
      }
    }
  });

  it("returns null for military, unassigned and malformed ZIP3s", () => {
    expect(zoneForZip3("850", "090")).toBeNull(); // APO AE
    expect(zoneForZip3("340", "850")).toBeNull(); // APO AA
    expect(zoneForZip3("850", "963")).toBeNull(); // APO AP
    expect(zoneForZip3("850", "001")).toBeNull(); // unassigned
    expect(zoneForZip3("850", "8a0")).toBeNull();
    expect(zoneForZip3("85", "850")).toBeNull();
  });
});

describe("zoneForZips", () => {
  it("uses only the first three digits of a 5 or 9 digit ZIP", () => {
    expect(zip3Of("85003")).toBe("850");
    expect(zip3Of(" 10001-1234 ")).toBe("100");
    expect(zip3Of("1000")).toBeNull();
    expect(zip3Of("K1A 0B1")).toBeNull();
    expect(zip3Of(null)).toBeNull();
    expect(zoneForZips("85003", "10001-1234")).toBe(8);
    expect(zoneForZips("85003", "")).toBeNull();
    expect(zoneForZips(undefined, "10001")).toBeNull();
  });
});

/** A carrier that sells every label and counts its buys (no network, no S3). */
function fakeCarrier(counter: { buys: number }): CarrierAdapter {
  let n = 0;
  const sold = new Map<string, PurchasedLabel>();
  return {
    provider: "easypost",
    async rate(req) {
      n += 1;
      return {
        carrierShipmentId: `shp_zone_${req.shipmentId.slice(0, 8)}_${n}`,
        rates: [
          {
            rateId: `rate_zone_${n}`,
            carrier: "usps",
            service: "GroundAdvantage",
            serviceLabel: "USPS Ground Advantage",
            rateCents: 812,
            deliveryDays: 4,
            estimatedDeliveryAt: null,
          },
        ],
      };
    },
    async buy(req) {
      counter.buys += 1;
      const label: PurchasedLabel = {
        trackingCode: `9400ZONE${req.shipmentId.replace(/-/g, "").slice(0, 12)}${n}`,
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

/** The `shipments` columns before T-A4 plus `dest_zone`: nothing that holds a ZIP, address or name. */
const SHIPMENT_COLUMNS = [
  "id",
  "company_id",
  "order_id",
  "order_item_ids",
  "status",
  "carrier",
  "service",
  "tracking_code",
  "tracking_url",
  "tracking_status",
  "label_key",
  "label_format",
  "postage_cents",
  "label_fee_cents",
  "package_preset_id",
  "length_in",
  "width_in",
  "height_in",
  "weight_oz",
  "rate_quotes",
  "selected_rate_id",
  "rated_at",
  "carrier_shipment_id",
  "carrier_label_id",
  "tracking_push_status",
  "tracking_pushed_at",
  "tracking_push_attempts",
  "tracking_push_error",
  "labeled_at",
  "delivered_at",
  "voided_at",
  "created_at",
  "updated_at",
  "buy_attempted_at",
  "void_attempted_at",
  "push_attempted_at",
  "exported_at",
  "dest_zone",
];

describe("label buy stores the destination zone only (T-A4, AC-A4)", () => {
  let companyId: string;
  let connectionId: string;
  let ctx: ReturnType<typeof tenantContext>;
  const counter = { buys: 0 };

  beforeAll(async () => {
    companyId = (await createCompany()).id;
    const owner = await createUser(companyId, "owner");
    ctx = tenantContext(companyId, owner.id, "owner");
    connectionId = (await createConnection(companyId, "csv")).id;
    await withTenant(companyId, (tx) =>
      svc.updateSettings(tx, ctx, {
        fromAddress: {
          name: "Zone Co",
          company: null,
          street1: "1 Main St",
          street2: null,
          city: "Phoenix",
          state: "AZ",
          zip: "85004",
          country: "US",
          phone: null,
          email: null,
        },
      }),
    );
  });

  beforeEach(() => {
    vi.mocked(carriersModule.carrierAdapter).mockImplementation(async () => fakeCarrier(counter));
  });

  async function packedOrderTo(zip: string) {
    const { order } = await createOrder(companyId, connectionId, { units: 1, state: "packed" });
    await withSystem((tx) =>
      tx.insert(buyerPii).values({
        companyId,
        orderId: order.id,
        name: "Test Buyer",
        street1: "1 Buyer Way",
        city: "Brooklyn",
        state: "NY",
        zip,
      }),
    );
    return order;
  }

  it("sets dest_zone 1-9 at purchase, once, and the API shows it", async () => {
    const order = await packedOrderTo("11201-2345");
    const quote = await svc.rateOrder(ctx, { orderId: order.id });
    const rateId = quote.rates[0]?.rateId as string;
    const before = counter.buys;
    const first = await svc.buyLabel(ctx, { shipmentId: quote.shipmentId, rateId });
    const again = await svc.buyLabel(ctx, { shipmentId: quote.shipmentId, rateId });
    expect(counter.buys - before).toBe(1);
    expect(first.destZone).toBe(8); // Phoenix -> Brooklyn
    expect(again.destZone).toBe(8);
    const [row] = await withTenant(companyId, (tx) =>
      tx.select({ destZone: shipments.destZone }).from(shipments).where(eq(shipments.id, first.id)),
    );
    expect(row?.destZone).toBe(8);
  });

  it("an unzoned destination (military) leaves dest_zone null and still buys", async () => {
    const order = await packedOrderTo("09001");
    const quote = await svc.rateOrder(ctx, { orderId: order.id });
    const shipment = await svc.buyLabel(ctx, {
      shipmentId: quote.shipmentId,
      rateId: quote.rates[0]?.rateId as string,
    });
    expect(shipment.status).toBe("labeled");
    expect(shipment.destZone).toBeNull();
  });

  it("shipments has exactly the expected columns: no new ZIP, address or name column", async () => {
    const res = await withSystem((tx) =>
      tx.execute<{ column_name: string }>(
        sql`select column_name from information_schema.columns
            where table_schema = 'public' and table_name = 'shipments' order by ordinal_position`,
      ),
    );
    const cols = res.rows.map((r) => r.column_name);
    expect([...cols].sort()).toEqual([...SHIPMENT_COLUMNS].sort());
    expect(cols.filter((c) => /zip|addr|street|city|name|phone|email/.test(c))).toEqual([]);
  });
});
