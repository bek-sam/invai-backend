import { env } from "../../../env";
import { upstream } from "../../../lib/errors";
import {
  type ChannelAdapter,
  type ChannelConn,
  normalizeAvailability,
  type TrackingPush,
  type TrackingPushResult,
} from "../types";
import { ShopifyAuthError, shopifyGraphql } from "./client";
import { parseShopifyWebhook, SHOPIFY_SCOPES, verifyShopifyHmac } from "./common";
import { setShopifyAvailability } from "./inventory";
import { pushShopifyProductImages } from "./media";
import { fetchShopifyOrders, gid } from "./orders";
import { disconnectShopify, ensureShopifyWebhooks } from "./subscriptions";

/*
 * Shopify Admin GraphQL API (2026-07). Orders are pulled with an `updated_at` watermark plus
 * page cursors, tracking goes through fulfillment orders + `fulfillmentCreate`, availability
 * through `inventorySetQuantities`, product images through `productUpdate` media (media.ts). Access tokens are offline tokens from the OAuth install.
 */

const FULFILLMENT_ORDERS_QUERY = /* GraphQL */ `
  query FulfillmentOrders($id: ID!) {
    order(id: $id) {
      fulfillmentOrders(first: 5) {
        nodes {
          id
          status
          lineItems(first: 50) { nodes { id remainingQuantity lineItem { id } } }
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

const SHOP_QUERY = /* GraphQL */ `query { shop { name myshopifyDomain } }`;

/** Shopify refused the token: a clear message for the shop (the raw status stays in logs). */
async function authed<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ShopifyAuthError)
      throw upstream("Shopify", `access denied (${err.status}); reconnect the store`);
    throw err;
  }
}

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
    return authed(() => fetchShopifyOrders(conn));
  },

  async pushTracking(conn, push) {
    return authed(() => pushShopifyTracking(conn, push));
  },

  async setAvailability(conn, updates, opts) {
    return authed(() => setShopifyAvailability(conn, normalizeAvailability(updates), opts));
  },

  async verifyWebhook(headers, body) {
    return verifyShopifyHmac(headers, body);
  },

  async parseWebhook(headers, body) {
    return parseShopifyWebhook(headers, body);
  },

  async ensureWebhooks(conn, uri) {
    return ensureShopifyWebhooks(conn, uri);
  },

  async disconnect(conn, uri) {
    return disconnectShopify(conn, uri);
  },

  async pushProductImages(conn, input) {
    return pushShopifyProductImages(conn, input);
  },
};

async function pushShopifyTracking(
  conn: ChannelConn,
  push: TrackingPush,
): Promise<TrackingPushResult> {
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
  }>(
    conn,
    FULFILLMENT_ORDERS_QUERY,
    { id: `gid://shopify/Order/${push.channelOrderId}` },
    { cost: 550 },
  );
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
}

/* ---- OAuth install ---- */

export function shopifyAuthorizeUrl(shop: string, state: string, redirectUri: string): string {
  const u = new URL(`https://${shop}/admin/oauth/authorize`);
  u.searchParams.set("client_id", env.SHOPIFY_API_KEY ?? "mock");
  u.searchParams.set("scope", SHOPIFY_SCOPES.join(","));
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("state", state);
  return u.toString();
}

/** After install: the shop's name (webhooks are subscribed by `ensureWebhooks`). */
export async function finishShopifyInstall(
  conn: Pick<ChannelConn, "externalShopId" | "credentials">,
) {
  const shop = await shopifyGraphql<{ shop: { name: string } }>(conn, SHOP_QUERY);
  return { shopName: shop.shop.name };
}
