import { createHmac, timingSafeEqual } from "node:crypto";
import type { NormalizedOrder } from "@invai/contracts";
import { env } from "../../../env";
import { type HeaderBag, header, type WebhookEvent } from "../types";

export const SHOPIFY_API_VERSION = "2026-07";
export const SHOPIFY_SCOPES = [
  "read_orders",
  "write_orders",
  "read_merchant_managed_fulfillment_orders",
  "write_merchant_managed_fulfillment_orders",
  "read_products",
  "read_inventory",
  "write_inventory",
  "read_locations",
];
export const SHOPIFY_WEBHOOK_TOPICS = [
  "ORDERS_CREATE",
  "ORDERS_UPDATED",
  "ORDERS_CANCELLED",
  "APP_UNINSTALLED",
] as const;

/** Mock mode signs webhooks with a fixed dev secret so local tests can post signed payloads. */
export const MOCK_SHOPIFY_SECRET = "mock-shopify-webhook-secret";

export function shopifySecret(): string {
  return env.SHOPIFY_API_SECRET ?? MOCK_SHOPIFY_SECRET;
}

/** `X-Shopify-Hmac-Sha256` = base64(HMAC-SHA256(app secret, raw body)). */
export function signShopifyBody(body: string, secret = shopifySecret()): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("base64");
}

export function verifyShopifyHmac(headers: HeaderBag, body: string, secret = shopifySecret()) {
  const got = header(headers, "x-shopify-hmac-sha256");
  if (!got) return false;
  const want = signShopifyBody(body, secret);
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * OAuth callback query HMAC: every param except `hmac`, sorted, `k=v` joined with `&`,
 * HMAC-SHA256 hex with the app secret.
 */
export function verifyOAuthQuery(query: Record<string, string>, secret = shopifySecret()) {
  const { hmac, ...rest } = query;
  if (!hmac) return false;
  const message = Object.keys(rest)
    .sort()
    .map((k) => `${k}=${rest[k]}`)
    .join("&");
  const want = createHmac("sha256", secret).update(message).digest("hex");
  const a = Buffer.from(hmac);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const cents = (amount: string | number | null | undefined) =>
  Math.round(Number(amount ?? 0) * 100) || 0;

/* ---- REST webhook payload (orders/create, orders/updated) -> NormalizedOrder ---- */

type RestAddress = {
  name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  company?: string | null;
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  province_code?: string | null;
  province?: string | null;
  zip?: string | null;
  country_code?: string | null;
  phone?: string | null;
};

export type RestOrder = {
  id: number | string;
  admin_graphql_api_id?: string;
  name?: string;
  order_number?: number;
  created_at: string;
  processed_at?: string | null;
  cancelled_at?: string | null;
  email?: string | null;
  contact_email?: string | null;
  note?: string | null;
  tags?: string;
  customer?: { first_name?: string | null; last_name?: string | null } | null;
  shipping_address?: RestAddress | null;
  subtotal_price?: string;
  total_tax?: string;
  total_discounts?: string;
  total_price?: string;
  total_shipping_price_set?: { shop_money?: { amount?: string } };
  shipping_lines?: { title?: string; price?: string }[];
  line_items: {
    id: number | string;
    sku?: string | null;
    title?: string;
    name?: string;
    variant_title?: string | null;
    quantity: number;
    price?: string;
    product_id?: number | string | null;
    variant_id?: number | string | null;
    properties?: { name: string; value: string }[] | null;
  }[];
};

const email = (v: string | null | undefined) =>
  v && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) ? v : null;

const isRushTitle = (t: string | null | undefined) =>
  !!t && /rush|express|overnight|priority/i.test(t);

export function restOrderToNormalized(o: RestOrder): NormalizedOrder {
  const a = o.shipping_address;
  const buyerName =
    a?.name ||
    [o.customer?.first_name, o.customer?.last_name].filter(Boolean).join(" ") ||
    "Shopify customer";
  const shippingTitle = o.shipping_lines?.[0]?.title ?? null;
  const shipping =
    o.total_shipping_price_set?.shop_money?.amount !== undefined
      ? cents(o.total_shipping_price_set.shop_money.amount)
      : (o.shipping_lines ?? []).reduce((s, l) => s + cents(l.price), 0);
  return {
    channel: "shopify",
    channelOrderId: String(o.id),
    orderNo: o.name ?? `#${o.order_number ?? o.id}`,
    placedAt: new Date(o.processed_at ?? o.created_at).toISOString(),
    shipBy: null,
    isRush: isRushTitle(shippingTitle),
    buyerName,
    buyerEmail: email(o.email ?? o.contact_email),
    shipTo: a
      ? {
          name: buyerName,
          company: a.company || null,
          street1: a.address1 ?? "",
          street2: a.address2 || null,
          city: a.city ?? "",
          state: a.province_code ?? a.province ?? "",
          zip: a.zip ?? "",
          country: (a.country_code ?? "US").slice(0, 2).toUpperCase(),
          phone: a.phone || null,
          email: null,
        }
      : null,
    shippingMethod: shippingTitle,
    totals: {
      subtotal: cents(o.subtotal_price),
      shipping,
      tax: cents(o.total_tax),
      discount: cents(o.total_discounts),
      total: cents(o.total_price),
    },
    buyerNote: o.note || null,
    items: o.line_items
      .filter((li) => li.quantity > 0)
      .map((li) => ({
        channelLineId: String(li.id),
        channelSku: li.sku ?? "",
        channelListingId: li.product_id != null ? String(li.product_id) : null,
        title: li.title ?? li.name ?? "",
        variantTitle: li.variant_title || null,
        quantity: li.quantity,
        unitPrice: cents(li.price),
        personalization: (li.properties ?? [])
          .filter((p) => p.name && !p.name.startsWith("_"))
          .map((p) => ({ question: p.name, answer: p.value ?? null, fileUrl: null })),
      })),
  };
}

export function parseShopifyWebhook(headers: HeaderBag, body: string): WebhookEvent {
  const topic = header(headers, "x-shopify-topic") ?? "unknown";
  const shopDomain = header(headers, "x-shopify-shop-domain");
  const payload = JSON.parse(body) as RestOrder & { id: number | string };
  switch (topic) {
    case "orders/create":
    case "orders/updated":
    case "orders/paid":
      if (payload.cancelled_at)
        return { kind: "order_cancelled", topic, shopDomain, channelOrderId: String(payload.id) };
      if (!payload.line_items?.length) return { kind: "ignored", topic, shopDomain };
      return { kind: "order_upsert", topic, shopDomain, order: restOrderToNormalized(payload) };
    case "orders/cancelled":
      return { kind: "order_cancelled", topic, shopDomain, channelOrderId: String(payload.id) };
    case "app/uninstalled":
      return { kind: "uninstalled", topic, shopDomain };
    default:
      return { kind: "ignored", topic, shopDomain };
  }
}
