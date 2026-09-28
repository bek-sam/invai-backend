import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystem, withTenant } from "../../db/client";
import { buyerPii, channelConnections, orderItems, shipments } from "../../db/schema";
import { encryptJson } from "../../lib/crypto";
import * as outbox from "../../lib/outbox";
import * as svc from "../../modules/shipping/service";
import {
  createCompany,
  createLocation,
  createOrder,
  createUser,
  tenantContext,
} from "../../test/fixtures";
import type { CarrierAdapter } from "../carriers";
import * as carriersModule from "../carriers";
import * as channels from "./index";
import { resetShopifyThrottle, setShopifySleep } from "./shopify/client";
import { SHOPIFY_API_VERSION } from "./shopify/common";
import { shopifyLive } from "./shopify/live";
import type { ChannelConn } from "./types";

/*
 * T-20-3 (B-71) AC3, Shopify: the real Admin GraphQL adapter with `fetch` answering in
 * Shopify's recorded shapes (seed-like data, no PII). The orders poll survives a 429 and pages
 * on `pageInfo`; every call is a POST to the shop's graphql.json carrying the access-token
 * header (its value is never asserted). Tracking goes through the real service: fulfillment
 * orders are read first, `fulfillmentCreate` notifies the buyer once, and a crash after Shopify
 * accepted it is finished by the read-back (nothing left to fulfill), never a second email.
 */

vi.mock("./index", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./index")>();
  return { ...actual, getChannelAdapter: vi.fn(actual.getChannelAdapter) };
});
vi.mock("../carriers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../carriers")>();
  return { ...actual, carrierAdapter: vi.fn(actual.carrierAdapter) };
});
vi.mock("../../lib/outbox", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/outbox")>();
  return { ...actual, emit: vi.fn(actual.emit) };
});

const SHOP = `t203-live-${Date.now().toString(36)}.myshopify.com`;
const GRAPHQL = `https://${SHOP}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

type Call = {
  method: string;
  url: string;
  headers: Record<string, string>;
  query: string;
  variables: Record<string, unknown>;
};

const throttle = (available: number) => ({
  cost: {
    requestedQueryCost: 10,
    actualQueryCost: 10,
    throttleStatus: { maximumAvailable: 2000, currentlyAvailable: available, restoreRate: 100 },
  },
});

/** A Shopify order node with one paid line, as the 2026-07 orders query returns it. */
const gqlOrder = (n: number, updatedAt: string) => ({
  id: `gid://shopify/Order/${n}`,
  legacyResourceId: String(n),
  name: `#${n}`,
  createdAt: "2026-09-27T10:00:00Z",
  processedAt: "2026-09-27T10:00:00Z",
  updatedAt,
  cancelledAt: null,
  displayFinancialStatus: "PAID",
  email: "buyer@example.com",
  note: null,
  customer: { firstName: "Test", lastName: "Buyer" },
  shippingAddress: {
    name: "Test Buyer",
    company: null,
    address1: "1 Buyer Way",
    address2: null,
    city: "Brooklyn",
    provinceCode: "NY",
    zip: "11201",
    countryCodeV2: "US",
    phone: null,
  },
  shippingLine: { title: "Standard" },
  subtotalPriceSet: { shopMoney: { amount: "25.00" } },
  totalShippingPriceSet: { shopMoney: { amount: "5.00" } },
  totalTaxSet: { shopMoney: { amount: "2.00" } },
  totalDiscountsSet: { shopMoney: { amount: "0" } },
  totalPriceSet: { shopMoney: { amount: "32.00" } },
  lineItems: {
    pageInfo: { hasNextPage: false, endCursor: null },
    nodes: [
      {
        id: `gid://shopify/LineItem/${n}1`,
        sku: "DB-SAGUARO-BLK-M",
        title: "Saguaro Tee",
        variantTitle: "Black / M",
        quantity: 1,
        currentQuantity: 1,
        product: { legacyResourceId: "77" },
        originalUnitPriceSet: { shopMoney: { amount: "25.00" } },
        customAttributes: [],
      },
    ],
  },
});

function fakeCarrier(): CarrierAdapter {
  return {
    provider: "mock",
    async rate(req) {
      return {
        carrierShipmentId: `shp_t203s_${req.shipmentId.replace(/-/g, "")}`,
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
      return {
        trackingCode: `9400T203S${req.carrierShipmentId.slice(-13)}`,
        trackingUrl: "https://tools.usps.com/go/TrackConfirmAction?tLabels=x",
        labelKey: carriersModule.labelObjectKey(req.companyId, req.carrierShipmentId),
        carrierLabelId: "pl_t203s",
        postageCents: req.rate.rateCents,
      };
    },
    async lookup() {
      return { label: null, refundStatus: null };
    },
    async void() {
      return { ok: true, pending: false };
    },
  };
}

describe("T-20-3 Shopify live adapter over fetch", () => {
  let companyId: string;
  let ctx: ReturnType<typeof tenantContext>;
  let connectionId: string;
  let calls: Call[];
  let restoreSleep: () => void;
  let waits: number[];

  beforeAll(async () => {
    companyId = (await createCompany()).id;
    const owner = await createUser(companyId, "owner");
    ctx = tenantContext(companyId, owner.id, "owner");
    await createLocation(companyId);
    const [conn] = await withSystem((tx) =>
      tx
        .insert(channelConnections)
        .values({
          companyId,
          channel: "shopify",
          name: "Desert Bloom Store",
          status: "connected",
          mode: "api",
          provider: "live",
          externalShopId: SHOP,
          credentials: encryptJson({ accessToken: "shpat-test-token-never-asserted" }),
          settings: {
            autoImport: true,
            processingDays: null,
            riskWindowHours: 24,
            pushTracking: true,
            pushAvailability: false,
          },
        })
        .returning(),
    );
    connectionId = conn?.id as string;
    await withTenant(companyId, (tx) =>
      svc.updateSettings(tx, ctx, {
        fromAddress: {
          name: "Desert Bloom Tees",
          company: null,
          street1: "100 Main St",
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
    vi.mocked(carriersModule.carrierAdapter).mockImplementation(async () => fakeCarrier());
    const real = vi
      .mocked(channels.getChannelAdapter)
      .getMockImplementation() as typeof channels.getChannelAdapter;
    vi.mocked(channels.getChannelAdapter).mockImplementation(async (kind, provider, scope) =>
      kind === "shopify" ? shopifyLive : real(kind, provider, scope),
    );
  });

  beforeEach(() => {
    calls = [];
    waits = [];
    resetShopifyThrottle();
    restoreSleep = setShopifySleep(async (ms) => {
      waits.push(ms);
    });
    vi.mocked(outbox.emit).mockClear();
  });
  afterEach(() => {
    restoreSleep();
    vi.unstubAllGlobals();
  });

  function stubShopify(handler: (call: Call) => { status?: number; body: unknown }) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit = {}) => {
        const headers = Object.fromEntries(
          Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [
            k.toLowerCase(),
            v,
          ]),
        );
        const parsed = init.body
          ? (JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> })
          : { query: "", variables: {} };
        const call: Call = { method: init.method ?? "GET", url, headers, ...parsed };
        calls.push(call);
        const r = handler(call);
        return new Response(JSON.stringify(r.body), {
          status: r.status ?? 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
  }

  /** Every request: POST to the shop's graphql.json, token in the header, nothing in the URL. */
  function expectWellFormed(c: Call) {
    expect(c.method).toBe("POST");
    expect(c.url).toBe(GRAPHQL);
    expect(c.headers["x-shopify-access-token"]).toEqual(expect.any(String));
    expect(c.headers["x-shopify-access-token"]?.length).toBeGreaterThan(0);
    expect(c.headers["content-type"]).toBe("application/json");
    expect(c.url).not.toMatch(/token|shpat/i);
  }

  it("orders poll: backs off on a 429 with throttleStatus, then follows pageInfo across pages", async () => {
    const conn: ChannelConn = {
      id: connectionId,
      companyId,
      channel: "shopify",
      name: "Desert Bloom Store",
      mode: "api",
      provider: "live",
      externalShopId: SHOP,
      cursor: "2026-09-27T00:00:00Z",
      credentials: { accessToken: "shpat-test-token-never-asserted" },
    };
    let n = 0;
    stubShopify((c) => {
      n += 1;
      if (n === 1) return { status: 429, body: {} };
      if (!c.variables.after)
        return {
          body: {
            data: {
              orders: {
                pageInfo: { hasNextPage: true, endCursor: "cursor-page-2" },
                nodes: [
                  gqlOrder(1001, "2026-09-27T10:00:01Z"),
                  gqlOrder(1002, "2026-09-27T10:00:02Z"),
                ],
              },
            },
            extensions: throttle(1900),
          },
        };
      return {
        body: {
          data: {
            orders: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [gqlOrder(1003, "2026-09-27T10:00:03Z")],
            },
          },
          extensions: throttle(1300),
        },
      };
    });
    const res = await shopifyLive.fetchOrders(conn);
    expect(calls).toHaveLength(3);
    for (const c of calls) expectWellFormed(c);
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThanOrEqual(1000);
    expect(calls[1]?.variables.after).toBeNull();
    expect(calls[2]?.variables.after).toBe("cursor-page-2");
    expect(String(calls[1]?.variables.query)).toMatch(/^updated_at:>/);
    expect(res.orders.map((o) => o.channelOrderId)).toEqual(["1001", "1002", "1003"]);
    expect(res.nextCursor).toBe("2026-09-27T10:00:03Z");
  });

  it("tracking push: reads fulfillment orders, creates one fulfillment, and finishes a crashed push by read-back", async () => {
    const { order, items } = await createOrder(companyId, connectionId, {
      units: 1,
      state: "packed",
      channel: "shopify",
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
    const quote = await svc.rateOrder(ctx, { orderId: order.id });
    const shipment = await svc.buyLabel(ctx, {
      shipmentId: quote.shipmentId,
      rateId: quote.rates[0]?.rateId as string,
    });
    expect(shipment.trackingPush.status).toBe("pending");

    let fulfilled = 0;
    const lineId = items[0]?.channelLineId as string;
    stubShopify((c) => {
      if (c.query.includes("query FulfillmentOrders"))
        return {
          body: {
            data: {
              order: {
                fulfillmentOrders: {
                  nodes: [
                    {
                      id: "gid://shopify/FulfillmentOrder/501",
                      status: fulfilled ? "CLOSED" : "OPEN",
                      lineItems: {
                        nodes: [
                          {
                            id: "gid://shopify/FulfillmentOrderLineItem/9001",
                            remainingQuantity: fulfilled ? 0 : 1,
                            lineItem: { id: `gid://shopify/LineItem/${lineId}` },
                          },
                        ],
                      },
                    },
                  ],
                },
              },
            },
            extensions: throttle(1500),
          },
        };
      if (c.query.includes("mutation FulfillmentCreate")) {
        fulfilled += 1;
        return {
          body: {
            data: {
              fulfillmentCreate: {
                fulfillment: {
                  id: `gid://shopify/Fulfillment/${700 + fulfilled}`,
                  status: "SUCCESS",
                },
                userErrors: [],
              },
            },
            extensions: throttle(1400),
          },
        };
      }
      throw new Error(`unexpected Shopify query ${c.query.slice(0, 40)}`);
    });

    // Shopify accepts the fulfillment (and emails the buyer); our commit then fails.
    vi.mocked(outbox.emit).mockImplementationOnce(async () => {
      throw new Error("simulated commit failure");
    });
    expect(await svc.pushTracking(companyId, ctx, shipment.id)).toBe("retry");
    expect(calls.map((c) => c.query.match(/^\s*(query|mutation) (\w+)/)?.[2])).toEqual([
      "FulfillmentOrders",
      "FulfillmentCreate",
    ]);
    for (const c of calls) expectWellFormed(c);
    expect(calls[0]?.variables).toEqual({ id: `gid://shopify/Order/${order.channelOrderId}` });
    expect(calls[1]?.variables).toEqual({
      fulfillment: {
        lineItemsByFulfillmentOrder: [
          {
            fulfillmentOrderId: "gid://shopify/FulfillmentOrder/501",
            fulfillmentOrderLineItems: [
              { id: "gid://shopify/FulfillmentOrderLineItem/9001", quantity: 1 },
            ],
          },
        ],
        notifyCustomer: true,
        trackingInfo: {
          company: "USPS",
          number: shipment.trackingCode,
          url: "https://tools.usps.com/go/TrackConfirmAction?tLabels=x",
        },
      },
    });
    const [stuck] = await withSystem((tx) =>
      tx.select().from(shipments).where(eq(shipments.id, shipment.id)),
    );
    expect(stuck).toMatchObject({ trackingPushStatus: "pushing", pushAttemptedAt: null });

    // Retry: the read-back shows nothing left to fulfill, so no second fulfillmentCreate (no
    // second buyer email) and the push is recorded as done.
    calls = [];
    expect(await svc.pushTracking(companyId, ctx, shipment.id)).toBe("pushed");
    expect(calls.map((c) => c.query.match(/^\s*(query|mutation) (\w+)/)?.[2])).toEqual([
      "FulfillmentOrders",
    ]);
    expect(fulfilled).toBe(1);
    const [done] = await withSystem((tx) =>
      tx.select().from(shipments).where(eq(shipments.id, shipment.id)),
    );
    expect(done).toMatchObject({ trackingPushStatus: "pushed", trackingPushAttempts: 1 });
    const states = (
      await withSystem((tx) =>
        tx
          .select({ state: orderItems.state })
          .from(orderItems)
          .where(eq(orderItems.orderId, order.id)),
      )
    ).map((r) => r.state);
    expect(states).toEqual(["shipped"]);
    // Pushing once more touches nothing.
    calls = [];
    expect(await svc.pushTracking(companyId, ctx, shipment.id)).toBe("skipped");
    expect(calls).toHaveLength(0);
  });

  it("a fulfillmentCreate userError is an upstream failure that leaves the push retryable", async () => {
    const { order, items } = await createOrder(companyId, connectionId, {
      units: 1,
      state: "packed",
      channel: "shopify",
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
    const quote = await svc.rateOrder(ctx, { orderId: order.id });
    const shipment = await svc.buyLabel(ctx, {
      shipmentId: quote.shipmentId,
      rateId: quote.rates[0]?.rateId as string,
    });
    const lineId = items[0]?.channelLineId as string;
    stubShopify((c) =>
      c.query.includes("query FulfillmentOrders")
        ? {
            body: {
              data: {
                order: {
                  fulfillmentOrders: {
                    nodes: [
                      {
                        id: "gid://shopify/FulfillmentOrder/502",
                        status: "OPEN",
                        lineItems: {
                          nodes: [
                            {
                              id: "gid://shopify/FulfillmentOrderLineItem/9002",
                              remainingQuantity: 1,
                              lineItem: { id: `gid://shopify/LineItem/${lineId}` },
                            },
                          ],
                        },
                      },
                    ],
                  },
                },
              },
              extensions: throttle(1500),
            },
          }
        : {
            body: {
              data: {
                fulfillmentCreate: {
                  fulfillment: null,
                  userErrors: [{ field: ["fulfillment"], message: "Tracking company is invalid." }],
                },
              },
              extensions: throttle(1400),
            },
          },
    );
    expect(await svc.pushTracking(companyId, ctx, shipment.id)).toBe("retry");
    const [s] = await withSystem((tx) =>
      tx.select().from(shipments).where(eq(shipments.id, shipment.id)),
    );
    expect(s).toMatchObject({
      trackingPushStatus: "pending",
      trackingPushAttempts: 1,
      trackingPushError: expect.stringMatching(/Tracking company is invalid/),
    });
  });
});
