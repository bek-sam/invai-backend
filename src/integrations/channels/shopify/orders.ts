import type { NormalizedOrder } from "@invai/contracts";
import { logger } from "../../../lib/log";
import type { ChannelConn, FetchOrdersResult } from "../types";
import { shopifyGraphql } from "./client";
import { cents, paymentDecision, shipToOf, UNKNOWN_BUYER } from "./common";

const log = logger("channels.shopify.orders");

/*
 * Order poll (Admin GraphQL 2026-07), the reconciliation backstop for webhooks.
 * - Filters on `updated_at` only and decides by `displayFinancialStatus` in code (`paymentDecision`),
 *   so refunds, voids and cancels made after import come through too.
 *   https://shopify.dev/docs/api/admin-graphql/2026-07/queries/orders
 * - Sorted by UPDATED_AT ascending; the cursor is the newest `updatedAt` seen, re-read with a
 *   one-minute overlap (import is idempotent). A run stops after MAX_PAGES; the next poll goes on
 *   from the watermark, so a large backlog drains over several polls instead of one huge run.
 * - Line items: the first LINES_INLINE come with the order; longer orders page the rest.
 *   Quantities are `currentQuantity` (after edits and removals), not the original `quantity`.
 * - Query cost stays under the 1,000-point single-query cap: 10 orders x 25 lines ~ 600 points.
 */

const ORDERS_PER_PAGE = 10;
const LINES_INLINE = 25;
const LINES_PAGE = 100;
const MAX_PAGES = 50;
const ORDERS_COST = 650;
const LINES_COST = 250;

const LINE_FIELDS = /* GraphQL */ `
  id
  sku
  title
  variantTitle
  quantity
  currentQuantity
  product { legacyResourceId }
  originalUnitPriceSet { shopMoney { amount } }
  customAttributes { key value }
`;

const ORDERS_QUERY = /* GraphQL */ `
  query Orders($first: Int!, $after: String, $query: String, $lines: Int!) {
    orders(first: $first, after: $after, query: $query, sortKey: UPDATED_AT) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        legacyResourceId
        name
        createdAt
        processedAt
        updatedAt
        cancelledAt
        displayFinancialStatus
        email
        note
        customer { firstName lastName }
        shippingAddress { name company address1 address2 city provinceCode zip countryCodeV2 phone }
        shippingLine { title }
        subtotalPriceSet { shopMoney { amount } }
        totalShippingPriceSet { shopMoney { amount } }
        totalTaxSet { shopMoney { amount } }
        totalDiscountsSet { shopMoney { amount } }
        totalPriceSet { shopMoney { amount } }
        lineItems(first: $lines) {
          pageInfo { hasNextPage endCursor }
          nodes { ${LINE_FIELDS} }
        }
      }
    }
  }
`;

const ORDER_LINES_QUERY = /* GraphQL */ `
  query OrderLines($id: ID!, $first: Int!, $after: String) {
    order(id: $id) {
      lineItems(first: $first, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { ${LINE_FIELDS} }
      }
    }
  }
`;

type Money = { shopMoney: { amount: string } } | null;
type PageInfo = { hasNextPage: boolean; endCursor: string | null };

export type GqlLine = {
  id: string;
  sku: string | null;
  title: string;
  variantTitle: string | null;
  quantity: number;
  currentQuantity: number | null;
  product: { legacyResourceId: string } | null;
  originalUnitPriceSet: Money;
  customAttributes: { key: string; value: string | null }[];
};

export type GqlOrder = {
  id: string;
  legacyResourceId: string;
  name: string;
  createdAt: string;
  processedAt: string | null;
  updatedAt: string;
  cancelledAt: string | null;
  displayFinancialStatus: string | null;
  email: string | null;
  note: string | null;
  customer: { firstName: string | null; lastName: string | null } | null;
  shippingAddress: {
    name: string | null;
    company: string | null;
    address1: string | null;
    address2: string | null;
    city: string | null;
    provinceCode: string | null;
    zip: string | null;
    countryCodeV2: string | null;
    phone: string | null;
  } | null;
  shippingLine: { title: string } | null;
  subtotalPriceSet: Money;
  totalShippingPriceSet: Money;
  totalTaxSet: Money;
  totalDiscountsSet: Money;
  totalPriceSet: Money;
  lineItems: { pageInfo?: PageInfo; nodes: GqlLine[] };
};

export const gid = (id: string) => id.split("/").pop() ?? id;

const lineQuantity = (li: GqlLine) => li.currentQuantity ?? li.quantity;

export function gqlOrderToNormalized(o: GqlOrder): NormalizedOrder {
  const a = o.shippingAddress;
  const buyerName =
    a?.name?.trim() ||
    [o.customer?.firstName, o.customer?.lastName].filter((v) => v?.trim()).join(" ") ||
    UNKNOWN_BUYER;
  const title = o.shippingLine?.title ?? null;
  return {
    channel: "shopify",
    channelOrderId: o.legacyResourceId,
    orderNo: o.name,
    placedAt: new Date(o.processedAt ?? o.createdAt).toISOString(),
    sourceUpdatedAt: new Date(o.updatedAt).toISOString(),
    shipBy: null,
    isRush: !!title && /rush|express|overnight|priority/i.test(title),
    buyerName,
    buyerEmail: o.email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(o.email) ? o.email : null,
    shipTo: shipToOf(
      a && {
        name: a.name,
        company: a.company,
        address1: a.address1,
        address2: a.address2,
        city: a.city,
        state: a.provinceCode,
        zip: a.zip,
        country: a.countryCodeV2,
        phone: a.phone,
      },
      buyerName,
    ),
    shippingMethod: title,
    totals: {
      subtotal: cents(o.subtotalPriceSet?.shopMoney.amount),
      shipping: cents(o.totalShippingPriceSet?.shopMoney.amount),
      tax: cents(o.totalTaxSet?.shopMoney.amount),
      discount: cents(o.totalDiscountsSet?.shopMoney.amount),
      total: cents(o.totalPriceSet?.shopMoney.amount),
    },
    buyerNote: o.note || null,
    items: o.lineItems.nodes
      .filter((li) => lineQuantity(li) > 0)
      .map((li) => ({
        channelLineId: gid(li.id),
        channelSku: li.sku ?? "",
        channelListingId: li.product?.legacyResourceId ?? null,
        title: li.title,
        variantTitle: li.variantTitle,
        quantity: lineQuantity(li),
        unitPrice: cents(li.originalUnitPriceSet?.shopMoney.amount),
        personalization: li.customAttributes
          .filter((c) => !c.key.startsWith("_"))
          .map((c) => ({ question: c.key, answer: c.value, fileUrl: null })),
      })),
  };
}

/** Every line of an order: the inline first page, then the rest page by page. */
async function allLines(conn: ChannelConn, o: GqlOrder): Promise<GqlLine[]> {
  const lines = [...o.lineItems.nodes];
  let page = o.lineItems.pageInfo;
  while (page?.hasNextPage) {
    const data = await shopifyGraphql<{
      order: { lineItems: { pageInfo: PageInfo; nodes: GqlLine[] } } | null;
    }>(
      conn,
      ORDER_LINES_QUERY,
      { id: o.id, first: LINES_PAGE, after: page.endCursor },
      { cost: LINES_COST },
    );
    if (!data.order) break;
    lines.push(...data.order.lineItems.nodes);
    page = data.order.lineItems.pageInfo;
  }
  return lines;
}

export async function fetchShopifyOrders(conn: ChannelConn): Promise<FetchOrdersResult> {
  // Overlap by a minute; the first sync looks back 7 days (60 are readable without read_all_orders).
  const since = conn.cursor
    ? new Date(new Date(conn.cursor).getTime() - 60_000)
    : new Date(Date.now() - 7 * 86400_000);
  const query = `updated_at:>'${since.toISOString()}'`;
  const orders: NormalizedOrder[] = [];
  const cancelled: string[] = [];
  const skipped: { id: string; status: string | null }[] = [];
  let after: string | null = null;
  let watermark = conn.cursor;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data: { orders: { pageInfo: PageInfo; nodes: GqlOrder[] } } = await shopifyGraphql(
      conn,
      ORDERS_QUERY,
      { first: ORDERS_PER_PAGE, after, query, lines: LINES_INLINE },
      { cost: ORDERS_COST },
    );
    for (const o of data.orders.nodes) {
      if (!watermark || o.updatedAt > watermark) watermark = o.updatedAt;
      const decision = o.cancelledAt ? "cancel" : paymentDecision(o.displayFinancialStatus);
      if (decision === "cancel") cancelled.push(o.legacyResourceId);
      else if (decision === "skip")
        skipped.push({ id: o.legacyResourceId, status: o.displayFinancialStatus });
      else {
        const full = { ...o, lineItems: { nodes: await allLines(conn, o) } };
        const n = gqlOrderToNormalized(full);
        if (n.items.length) orders.push(n);
      }
    }
    if (!data.orders.pageInfo.hasNextPage) break;
    after = data.orders.pageInfo.endCursor;
  }
  if (skipped.length)
    log.info("unpaid Shopify orders skipped", {
      connectionId: conn.id,
      count: skipped.length,
      orders: skipped.slice(0, 20),
    });
  return { orders, cancelledChannelOrderIds: cancelled, nextCursor: watermark };
}
