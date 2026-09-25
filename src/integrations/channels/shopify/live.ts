import type { NormalizedOrder } from "@invai/contracts";
import { env } from "../../../env";
import { upstream } from "../../../lib/errors";
import { logger } from "../../../lib/log";
import { type ChannelAdapter, type ChannelConn, normalizeAvailability } from "../types";
import { shopifyGraphql } from "./client";
import {
  cents,
  parseShopifyWebhook,
  SHOPIFY_SCOPES,
  SHOPIFY_WEBHOOK_TOPICS,
  verifyShopifyHmac,
} from "./common";
import { setShopifyAvailability } from "./inventory";

const log = logger("channels.shopify");

/*
 * Shopify Admin GraphQL API (2026-07). Orders are pulled with an `updated_at` watermark plus
 * page cursors, tracking goes through fulfillment orders + `fulfillmentCreate`, availability
 * through `inventorySetQuantities`. Access tokens are offline tokens from the OAuth install.
 */

const ORDERS_QUERY = /* GraphQL */ `
  query Orders($first: Int!, $after: String, $query: String) {
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
        email
        note
        displayFulfillmentStatus
        customer { firstName lastName }
        shippingAddress { name company address1 address2 city provinceCode zip countryCodeV2 phone }
        shippingLine { title }
        subtotalPriceSet { shopMoney { amount } }
        totalShippingPriceSet { shopMoney { amount } }
        totalTaxSet { shopMoney { amount } }
        totalDiscountsSet { shopMoney { amount } }
        totalPriceSet { shopMoney { amount } }
        lineItems(first: 100) {
          nodes {
            id
            sku
            title
            variantTitle
            quantity
            product { legacyResourceId }
            originalUnitPriceSet { shopMoney { amount } }
            customAttributes { key value }
          }
        }
      }
    }
  }
`;

type Money = { shopMoney: { amount: string } } | null;
type GqlOrder = {
  id: string;
  legacyResourceId: string;
  name: string;
  createdAt: string;
  processedAt: string | null;
  updatedAt: string;
  cancelledAt: string | null;
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
  lineItems: {
    nodes: {
      id: string;
      sku: string | null;
      title: string;
      variantTitle: string | null;
      quantity: number;
      product: { legacyResourceId: string } | null;
      originalUnitPriceSet: Money;
      customAttributes: { key: string; value: string | null }[];
    }[];
  };
};

const gid = (id: string) => id.split("/").pop() ?? id;

function gqlOrderToNormalized(o: GqlOrder): NormalizedOrder {
  const a = o.shippingAddress;
  const name =
    a?.name ||
    [o.customer?.firstName, o.customer?.lastName].filter(Boolean).join(" ") ||
    "Shopify customer";
  const title = o.shippingLine?.title ?? null;
  return {
    channel: "shopify",
    channelOrderId: o.legacyResourceId,
    orderNo: o.name,
    placedAt: new Date(o.processedAt ?? o.createdAt).toISOString(),
    shipBy: null,
    isRush: !!title && /rush|express|overnight|priority/i.test(title),
    buyerName: name,
    buyerEmail: o.email && /^[^@\s]+@[^@\s]+$/.test(o.email) ? o.email : null,
    shipTo: a
      ? {
          name,
          company: a.company || null,
          street1: a.address1 ?? "",
          street2: a.address2 || null,
          city: a.city ?? "",
          state: a.provinceCode ?? "",
          zip: a.zip ?? "",
          country: (a.countryCodeV2 ?? "US").slice(0, 2),
          phone: a.phone || null,
          email: null,
        }
      : null,
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
      .filter((li) => li.quantity > 0)
      .map((li) => ({
        channelLineId: gid(li.id),
        channelSku: li.sku ?? "",
        channelListingId: li.product?.legacyResourceId ?? null,
        title: li.title,
        variantTitle: li.variantTitle,
        quantity: li.quantity,
        unitPrice: cents(li.originalUnitPriceSet?.shopMoney.amount),
        personalization: li.customAttributes
          .filter((c) => !c.key.startsWith("_"))
          .map((c) => ({ question: c.key, answer: c.value, fileUrl: null })),
      })),
  };
}

const FULFILLMENT_ORDERS_QUERY = /* GraphQL */ `
  query FulfillmentOrders($id: ID!) {
    order(id: $id) {
      fulfillmentOrders(first: 20) {
        nodes {
          id
          status
          lineItems(first: 100) { nodes { id remainingQuantity lineItem { id } } }
        }
      }
    }
  }
`;

const FULFILLMENT_CREATE = /* GraphQL */ `
  mutation FulfillmentCreate($fulfillment: FulfillmentInput!) {
    fulfillmentCreate(fulfillment: $fulfillment) {
      fulfillment { id status }
      userErrors { field message }
    }
  }
`;

const WEBHOOK_CREATE = /* GraphQL */ `
  mutation WebhookCreate($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
    webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) {
      webhookSubscription { id }
      userErrors { field message }
    }
  }
`;

const SHOP_QUERY = /* GraphQL */ `query { shop { name myshopifyDomain } }`;

const TRACKING_COMPANY: Record<string, string> = {
  usps: "USPS",
  ups: "UPS",
  fedex: "FedEx",
  dhl: "DHL Express",
};

export const shopifyLive: ChannelAdapter = {
  channel: "shopify",
  pendingApproval: false,

  async fetchOrders(conn) {
    // Cursor = updated_at watermark of the last order seen. Overlap by a minute; import is idempotent.
    const since = conn.cursor
      ? new Date(new Date(conn.cursor).getTime() - 60_000)
      : new Date(Date.now() - 7 * 86400_000);
    const query = `updated_at:>'${since.toISOString()}' AND financial_status:paid`;
    const orders: NormalizedOrder[] = [];
    const cancelled: string[] = [];
    let after: string | null = null;
    let watermark = conn.cursor;
    for (let page = 0; page < 10; page++) {
      const data: {
        orders: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: GqlOrder[] };
      } = await shopifyGraphql(conn, ORDERS_QUERY, { first: 50, after, query });
      for (const o of data.orders.nodes) {
        if (o.cancelledAt) cancelled.push(o.legacyResourceId);
        else if (o.lineItems.nodes.length) orders.push(gqlOrderToNormalized(o));
        if (!watermark || o.updatedAt > watermark) watermark = o.updatedAt;
      }
      if (!data.orders.pageInfo.hasNextPage) break;
      after = data.orders.pageInfo.endCursor;
    }
    return { orders, cancelledChannelOrderIds: cancelled, nextCursor: watermark };
  },

  async pushTracking(conn, push) {
    const data = await shopifyGraphql<{
      order: {
        fulfillmentOrders: {
          nodes: {
            id: string;
            status: string;
            lineItems: {
              nodes: { id: string; remainingQuantity: number; lineItem: { id: string } }[];
            };
          }[];
        };
      } | null;
    }>(conn, FULFILLMENT_ORDERS_QUERY, { id: `gid://shopify/Order/${push.channelOrderId}` });
    if (!data.order) throw upstream("Shopify", `order ${push.channelOrderId} not found`);
    const wanted = new Map(push.items.map((i) => [i.channelLineId, i.quantity]));
    const groups = data.order.fulfillmentOrders.nodes
      .filter((fo) => fo.status === "OPEN" || fo.status === "IN_PROGRESS")
      .map((fo) => ({
        fulfillmentOrderId: fo.id,
        fulfillmentOrderLineItems: fo.lineItems.nodes
          .filter((li) => li.remainingQuantity > 0 && wanted.has(gid(li.lineItem.id)))
          .map((li) => ({
            id: li.id,
            quantity: Math.min(li.remainingQuantity, wanted.get(gid(li.lineItem.id)) ?? 0),
          }))
          .filter((li) => li.quantity > 0),
      }))
      .filter((g) => g.fulfillmentOrderLineItems.length > 0);
    if (groups.length === 0) {
      return { status: "pushed", externalId: null, message: "Nothing left to fulfill on Shopify" };
    }
    const res = await shopifyGraphql<{
      fulfillmentCreate: { fulfillment: { id: string } | null; userErrors: { message: string }[] };
    }>(conn, FULFILLMENT_CREATE, {
      fulfillment: {
        lineItemsByFulfillmentOrder: groups,
        notifyCustomer: true,
        trackingInfo: {
          company: TRACKING_COMPANY[push.carrier.toLowerCase()] ?? push.carrier,
          number: push.trackingCode,
          url: push.trackingUrl ?? undefined,
        },
      },
    });
    if (res.fulfillmentCreate.userErrors.length)
      throw upstream("Shopify", res.fulfillmentCreate.userErrors.map((e) => e.message).join("; "));
    return {
      status: "pushed",
      externalId: res.fulfillmentCreate.fulfillment?.id ?? null,
      message: null,
    };
  },

  async setAvailability(conn, updates, opts) {
    return setShopifyAvailability(conn, normalizeAvailability(updates), opts);
  },

  async verifyWebhook(headers, body) {
    return verifyShopifyHmac(headers, body);
  },

  async parseWebhook(headers, body) {
    return parseShopifyWebhook(headers, body);
  },
};

/* ---- OAuth install ---- */

export function shopifyAuthorizeUrl(shop: string, state: string, redirectUri: string): string {
  const u = new URL(`https://${shop}/admin/oauth/authorize`);
  u.searchParams.set("client_id", env.SHOPIFY_API_KEY ?? "mock");
  u.searchParams.set("scope", SHOPIFY_SCOPES.join(","));
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("state", state);
  return u.toString();
}

export async function exchangeShopifyCode(shop: string, code: string) {
  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_id: env.SHOPIFY_API_KEY,
      client_secret: env.SHOPIFY_API_SECRET,
      code,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw upstream("Shopify", `token exchange failed (${res.status})`);
  const json = (await res.json()) as { access_token: string; scope: string };
  return { accessToken: json.access_token, scopes: json.scope.split(",") };
}

/** After install: shop name + webhook subscriptions pointing at `/webhooks/shopify`. */
export async function finishShopifyInstall(
  conn: Pick<ChannelConn, "externalShopId" | "credentials">,
  webhookUri: string,
) {
  const shop = await shopifyGraphql<{ shop: { name: string } }>(conn, SHOP_QUERY);
  for (const topic of SHOPIFY_WEBHOOK_TOPICS) {
    const res = await shopifyGraphql<{
      webhookSubscriptionCreate: { userErrors: { message: string }[] };
    }>(conn, WEBHOOK_CREATE, { topic, sub: { uri: webhookUri, format: "JSON" } });
    if (res.webhookSubscriptionCreate.userErrors.length)
      log.warn("webhook subscription failed", {
        topic,
        errors: res.webhookSubscriptionCreate.userErrors,
      });
  }
  return { shopName: shop.shop.name };
}
