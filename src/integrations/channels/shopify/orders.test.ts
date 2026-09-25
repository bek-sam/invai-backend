import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelConn } from "../types";
import { resetShopifyThrottle, setShopifySleep, shopifyGraphql, throttleWaitMs } from "./client";
import { parseShopifyWebhook, paymentDecision, restOrderToNormalized } from "./common";
import { shopifyLive } from "./live";
import type { GqlLine, GqlOrder } from "./orders";

const conn: ChannelConn = {
  id: "00000000-0000-4000-8000-000000000001",
  companyId: "00000000-0000-4000-8000-000000000002",
  channel: "shopify",
  name: "Test",
  mode: "api",
  provider: "live",
  externalShopId: "t31-orders.myshopify.com",
  cursor: "2026-09-20T00:00:00Z",
  credentials: { accessToken: "shpat_test" },
};

type Call = { query: string; variables: Record<string, unknown> };

const throttle = (available: number, restoreRate = 100, requested = 10) => ({
  cost: {
    requestedQueryCost: requested,
    actualQueryCost: requested,
    throttleStatus: { maximumAvailable: 2000, currentlyAvailable: available, restoreRate },
  },
});

function stub(handler: (call: Call, n: number) => { status?: number; body: unknown }) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const call = JSON.parse(String(init.body)) as Call;
      calls.push(call);
      const r = handler(call, calls.length);
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
    }),
  );
  return calls;
}

const line = (n: number, over: Partial<GqlLine> = {}): GqlLine => ({
  id: `gid://shopify/LineItem/${n}`,
  sku: `SKU-${n}`,
  title: "Tee",
  variantTitle: "Black / M",
  quantity: 1,
  currentQuantity: 1,
  product: { legacyResourceId: "77" },
  originalUnitPriceSet: { shopMoney: { amount: "25.00" } },
  customAttributes: [],
  ...over,
});

const order = (id: number, over: Partial<GqlOrder> = {}): GqlOrder => ({
  id: `gid://shopify/Order/${id}`,
  legacyResourceId: String(id),
  name: `#${id}`,
  createdAt: "2026-09-21T10:00:00Z",
  processedAt: "2026-09-21T10:00:00Z",
  updatedAt: `2026-09-21T10:00:${String(id % 60).padStart(2, "0")}Z`,
  cancelledAt: null,
  displayFinancialStatus: "PAID",
  email: "buyer@example.com",
  note: null,
  customer: { firstName: "Test", lastName: "Buyer" },
  shippingAddress: {
    name: "Test Buyer",
    company: null,
    address1: "1 Main St",
    address2: null,
    city: "Phoenix",
    provinceCode: "AZ",
    zip: "85001",
    countryCodeV2: "US",
    phone: null,
  },
  shippingLine: { title: "Standard" },
  subtotalPriceSet: { shopMoney: { amount: "25.00" } },
  totalShippingPriceSet: { shopMoney: { amount: "5.00" } },
  totalTaxSet: { shopMoney: { amount: "2.00" } },
  totalDiscountsSet: { shopMoney: { amount: "0" } },
  totalPriceSet: { shopMoney: { amount: "32.00" } },
  lineItems: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [line(1)] },
  ...over,
});

const ordersPage = (nodes: GqlOrder[], hasNextPage = false, endCursor: string | null = null) => ({
  body: {
    data: { orders: { pageInfo: { hasNextPage, endCursor }, nodes } },
    extensions: throttle(1900, 100, 600),
  },
});

let waits: number[] = [];
let restoreSleep: () => void;
beforeEach(() => {
  waits = [];
  resetShopifyThrottle();
  restoreSleep = setShopifySleep(async (ms) => {
    waits.push(ms);
  });
});
afterEach(() => {
  restoreSleep();
  vi.unstubAllGlobals();
});

describe("which Shopify orders are imported (paid only)", () => {
  it("decides by financial status", () => {
    for (const s of ["PAID", "paid", "PARTIALLY_PAID", "partially_refunded"])
      expect(paymentDecision(s), s).toBe("import");
    for (const s of ["PENDING", "pending", "AUTHORIZED", null, undefined, "SOMETHING_NEW"])
      expect(paymentDecision(s), String(s)).toBe("skip");
    for (const s of ["REFUNDED", "voided", "EXPIRED"]) expect(paymentDecision(s), s).toBe("cancel");
  });

  it("the poll filters on updated_at only and sorts refunds, voids and cancels in code", async () => {
    const calls = stub(() =>
      ordersPage([
        order(1),
        order(2, { displayFinancialStatus: "PENDING" }),
        order(3, { displayFinancialStatus: "PARTIALLY_REFUNDED" }),
        order(4, { displayFinancialStatus: "REFUNDED" }),
        order(5, { cancelledAt: "2026-09-21T11:00:00Z" }),
        order(6, { displayFinancialStatus: "AUTHORIZED" }),
        order(7, { displayFinancialStatus: "VOIDED" }),
      ]),
    );
    const res = await shopifyLive.fetchOrders(conn);
    expect(calls[0]?.variables.query).toBe("updated_at:>'2026-09-19T23:59:00.000Z'");
    expect(String(calls[0]?.variables.query)).not.toContain("financial_status");
    expect(res.orders.map((o) => o.channelOrderId)).toEqual(["1", "3"]);
    expect(res.cancelledChannelOrderIds).toEqual(["4", "5", "7"]);
    expect(res.nextCursor).toBe("2026-09-21T10:00:07Z");
  });

  it("webhooks import paid orders and skip pending (and cash-on-delivery) ones", () => {
    const rest = (financial_status: string) =>
      JSON.stringify({
        id: 42,
        name: "#1042",
        created_at: "2026-09-21T10:00:00Z",
        financial_status,
        line_items: [{ id: 1, sku: "A", quantity: 1, price: "20.00" }],
      });
    const h = (topic: string) => ({
      "x-shopify-topic": topic,
      "x-shopify-shop-domain": "s.myshopify.com",
    });
    expect(parseShopifyWebhook(h("orders/create"), rest("paid")).kind).toBe("order_upsert");
    expect(parseShopifyWebhook(h("orders/updated"), rest("partially_paid")).kind).toBe(
      "order_upsert",
    );
    const pending = parseShopifyWebhook(h("orders/create"), rest("pending"));
    expect(pending).toMatchObject({ kind: "ignored", reason: expect.stringContaining("not paid") });
    expect(parseShopifyWebhook(h("orders/updated"), rest("refunded")).kind).toBe("order_cancelled");
  });
});

describe("pagination", () => {
  it("pages orders and pages line items beyond the inline 25", async () => {
    const many = Array.from({ length: 130 }, (_, i) => line(i + 1));
    const calls = stub((c) => {
      if (c.query.includes("OrderLines")) {
        const after = c.variables.after as string;
        const from = Number(after);
        const nodes = many.slice(from, from + 100);
        const end = from + nodes.length;
        return {
          body: {
            data: {
              order: {
                lineItems: {
                  pageInfo: { hasNextPage: end < many.length, endCursor: String(end) },
                  nodes,
                },
              },
            },
          },
        };
      }
      if (!c.variables.after)
        return ordersPage(
          [
            order(1, {
              lineItems: {
                pageInfo: { hasNextPage: true, endCursor: "25" },
                nodes: many.slice(0, 25),
              },
            }),
          ],
          true,
          "page-2",
        );
      return ordersPage([order(2)]);
    });
    const res = await shopifyLive.fetchOrders(conn);
    expect(res.orders.map((o) => o.channelOrderId)).toEqual(["1", "2"]);
    expect(res.orders[0]?.items).toHaveLength(130);
    expect(new Set(res.orders[0]?.items.map((i) => i.channelLineId)).size).toBe(130);
    expect(calls.filter((c) => c.query.includes("OrderLines"))).toHaveLength(2);
    expect(calls.filter((c) => c.query.includes("query Orders"))[1]?.variables.after).toBe(
      "page-2",
    );
  });

  it("uses the current quantity after order edits", async () => {
    stub(() =>
      ordersPage([
        order(1, {
          lineItems: {
            nodes: [line(1, { quantity: 3, currentQuantity: 1 }), line(2, { currentQuantity: 0 })],
          },
        }),
      ]),
    );
    const res = await shopifyLive.fetchOrders(conn);
    expect(res.orders[0]?.items.map((i) => [i.channelLineId, i.quantity])).toEqual([["1", 1]]);
  });
});

describe("throttling follows throttleStatus", () => {
  it("computes the wait from cost, available points and restore rate", () => {
    const s = { maximumAvailable: 1000, currentlyAvailable: 100, restoreRate: 50 };
    expect(throttleWaitMs(s, 50)).toBe(0);
    expect(throttleWaitMs(s, 600)).toBe(10_000);
    expect(throttleWaitMs(null, 600)).toBe(0);
  });

  it("waits before a call the bucket can't cover, then retries a THROTTLED answer", async () => {
    let n = 0;
    stub(() => {
      n++;
      if (n === 1)
        return { body: { data: { shop: { name: "x" } }, extensions: throttle(50, 100) } };
      if (n === 2)
        return {
          body: {
            errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
            extensions: throttle(100, 100, 600),
          },
        };
      return { body: { data: { shop: { name: "x" } }, extensions: throttle(1500, 100) } };
    });
    await shopifyGraphql(conn, "query { shop { name } }");
    await shopifyGraphql(conn, "query { shop { name } }", {}, { cost: 600 });
    // Before call 2: ~50 of 600 points -> ~5.5 s. After THROTTLED: (600 - 100) / 100 = 5 s.
    expect(waits).toHaveLength(2);
    expect(waits[0]).toBeGreaterThan(5000);
    expect(waits[0]).toBeLessThanOrEqual(5500);
    expect(waits[1]).toBe(5000);
    expect(n).toBe(3);
  });

  it("backs off on HTTP 429 and gives up with a clear error, never a tight loop", async () => {
    stub(() => ({ status: 429, body: {} }));
    await expect(shopifyGraphql(conn, "query { shop { name } }")).rejects.toMatchObject({
      code: "UPSTREAM_FAILED",
    });
    expect(waits.length).toBe(5);
    expect(waits.every((w) => w >= 1000)).toBe(true);
  });
});

describe("protected customer data: withheld PII is stored as null", () => {
  it("a poll without Level 2 access gives a null ship-to, email and phone", async () => {
    stub(() =>
      ordersPage([
        order(1, {
          email: null,
          customer: null,
          shippingAddress: {
            name: null,
            company: null,
            address1: null,
            address2: null,
            city: null,
            provinceCode: "AZ",
            zip: null,
            countryCodeV2: "US",
            phone: null,
          },
        }),
      ]),
    );
    const [o] = (await shopifyLive.fetchOrders(conn)).orders;
    expect(o?.shipTo).toBeNull();
    expect(o?.buyerEmail).toBeNull();
    expect(o?.buyerName).toBe("Shopify customer");
  });

  it("a webhook with a partial address never fills the gaps with empty strings", () => {
    const n = restOrderToNormalized({
      id: 1,
      created_at: "2026-09-21T10:00:00Z",
      email: null,
      shipping_address: { address1: null, city: "Phoenix", zip: "85001", country_code: "US" },
      line_items: [{ id: 1, sku: "A", quantity: 1 }],
    });
    expect(n.shipTo).toBeNull();
    expect(n.buyerEmail).toBeNull();
    const full = restOrderToNormalized({
      id: 1,
      created_at: "2026-09-21T10:00:00Z",
      shipping_address: {
        name: "A B",
        address1: "1 Main",
        city: "Phoenix",
        zip: "85001",
        country_code: "us",
        phone: "",
      },
      line_items: [{ id: 1, sku: "A", quantity: 2, current_quantity: 1 }],
    });
    expect(full.shipTo).toMatchObject({ street1: "1 Main", phone: null, company: null });
    expect(full.shipTo?.country).toBe("US");
    expect(full.items[0]?.quantity).toBe(1);
  });
});
