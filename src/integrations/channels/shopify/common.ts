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
  // T-27-4: product image push (productUpdate media). Added 2026-10-03: existing shops re-consent.
  "write_products",
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

/*
 * Which orders we produce (T-3-1, B-28/B-63). Only paid money ships: PAID, PARTIALLY_PAID and
 * PARTIALLY_REFUNDED (paid, some refunded; the rest still ships) are imported. PENDING (this is
 * also every cash-on-delivery order), AUTHORIZED and anything unknown are skipped and logged,
 * and a later `orders/paid`/`orders/updated` or the poll imports the order once it is paid.
 * REFUNDED, VOIDED and EXPIRED cancel whatever was imported. Values: REST `financial_status`
 * (lowercase) and GraphQL `displayFinancialStatus` (uppercase).
 * https://shopify.dev/docs/api/admin-graphql/latest/enums/OrderDisplayFinancialStatus
 */
export type PaymentDecision = "import" | "cancel" | "skip";

export function paymentDecision(status: string | null | undefined): PaymentDecision {
  switch ((status ?? "").toLowerCase()) {
    case "paid":
    case "partially_paid":
    case "partially_refunded":
      return "import";
    case "refunded":
    case "voided":
    case "expired":
      return "cancel";
    default:
      return "skip";
  }
}

export type ShopifyAddressParts = {
  name?: string | null;
  company?: string | null;
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  country?: string | null;
  phone?: string | null;
};

const text = (v: string | null | undefined) => (v?.trim() ? v.trim() : null);

/**
 * The ship-to, or null when Shopify withheld it. Without protected customer data Level 2 the
 * address fields come back null with HTTP 200; we never fill them with empty strings, so the order
 * waits for an address instead of reaching a label.
 * https://shopify.dev/docs/apps/launch/protected-customer-data
 */
export function shipToOf(a: ShopifyAddressParts | null | undefined, buyerName: string) {
  if (!a) return null;
  const street1 = text(a.address1);
  const city = text(a.city);
  const zip = text(a.zip);
  const country = text(a.country);
  if (!street1 || !city || !zip || !country) return null;
  return {
    name: text(a.name) ?? buyerName,
    company: text(a.company),
    street1,
    street2: text(a.address2),
    city,
    state: text(a.state) ?? "",
    zip,
    country: country.slice(0, 2).toUpperCase(),
    phone: text(a.phone),
    email: null,
  };
}

/**
 * Display label when Shopify withheld the buyer's name. `NormalizedOrder.buyerName` and
 * `buyer_pii.name` are required strings, so this is a label, not a made-up person.
 */
export const UNKNOWN_BUYER = "Shopify customer";

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
  updated_at?: string | null;
  financial_status?: string | null;
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
    /** Quantity after order edits and removals (what is left to make). */
    current_quantity?: number | null;
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

/** Units still ordered on a line: after edits (`current_quantity`) when Shopify sends it. */
const restQuantity = (li: RestOrder["line_items"][number]) => li.current_quantity ?? li.quantity;

export function restOrderToNormalized(o: RestOrder): NormalizedOrder {
  const a = o.shipping_address;
  const buyerName =
    text(a?.name) ||
    [o.customer?.first_name, o.customer?.last_name].filter((v) => text(v)).join(" ") ||
    UNKNOWN_BUYER;
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
    sourceUpdatedAt: o.updated_at ? new Date(o.updated_at).toISOString() : null,
    shipBy: null,
    isRush: isRushTitle(shippingTitle),
    buyerName,
    buyerEmail: email(o.email ?? o.contact_email),
    shipTo: shipToOf(
      a && {
        name: a.name,
        company: a.company,
        address1: a.address1,
        address2: a.address2,
        city: a.city,
        state: a.province_code ?? a.province,
        zip: a.zip,
        country: a.country_code,
        phone: a.phone,
      },
      buyerName,
    ),
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
      .filter((li) => restQuantity(li) > 0)
      .map((li) => ({
        channelLineId: String(li.id),
        channelSku: li.sku ?? "",
        channelListingId: li.product_id != null ? String(li.product_id) : null,
        title: li.title ?? li.name ?? "",
        variantTitle: li.variant_title || null,
        quantity: restQuantity(li),
        unitPrice: cents(li.price),
        personalization: (li.properties ?? [])
          .filter((p) => p.name && !p.name.startsWith("_"))
          .map((p) => ({ question: p.name, answer: p.value ?? null, fileUrl: null })),
      })),
  };
}

/** The mandatory compliance topics, declared app-scoped in `shopify.app.toml`. */
export const SHOPIFY_COMPLIANCE_TOPICS = [
  "customers/data_request",
  "customers/redact",
  "shop/redact",
] as const;

export function isShopifyComplianceTopic(topic: string | null | undefined) {
  return (SHOPIFY_COMPLIANCE_TOPICS as readonly string[]).includes(topic ?? "");
}

type CompliancePayload = {
  shop_domain?: string;
  customer?: { id?: number | string | null } | null;
  orders_requested?: (number | string)[] | null;
  orders_to_redact?: (number | string)[] | null;
  data_request?: { id?: number | string | null } | null;
};

/**
 * Compliance payloads carry the customer's email and phone; only ids are kept. The shop comes
 * from the HMAC-signed body (`shop_domain`); a header naming a different shop is refused.
 */
function parseCompliance(
  topic: (typeof SHOPIFY_COMPLIANCE_TOPICS)[number],
  headerShop: string | null,
  p: CompliancePayload,
): WebhookEvent {
  const shopDomain = p.shop_domain ?? null;
  if (!shopDomain || (headerShop && headerShop !== shopDomain))
    return { kind: "ignored", topic, shopDomain, reason: "shop domain missing or mismatched" };
  const ids = (list: (number | string)[] | null | undefined) => (list ?? []).map(String);
  return {
    kind: "privacy",
    topic,
    shopDomain,
    request: {
      topic,
      channelCustomerId: p.customer?.id != null ? String(p.customer.id) : null,
      channelRequestId: p.data_request?.id != null ? String(p.data_request.id) : null,
      channelOrderIds:
        topic === "customers/data_request" ? ids(p.orders_requested) : ids(p.orders_to_redact),
    },
  };
}

export function parseShopifyWebhook(headers: HeaderBag, body: string): WebhookEvent {
  const topic = header(headers, "x-shopify-topic") ?? "unknown";
  const shopDomain = header(headers, "x-shopify-shop-domain");
  if (isShopifyComplianceTopic(topic))
    return parseCompliance(
      topic as (typeof SHOPIFY_COMPLIANCE_TOPICS)[number],
      shopDomain,
      JSON.parse(body) as CompliancePayload,
    );
  const payload = JSON.parse(body) as RestOrder & { id: number | string };
  switch (topic) {
    case "orders/create":
    case "orders/updated":
    case "orders/paid": {
      const channelOrderId = String(payload.id);
      if (payload.cancelled_at)
        return { kind: "order_cancelled", topic, shopDomain, channelOrderId };
      const decision = paymentDecision(payload.financial_status);
      if (decision === "cancel")
        return { kind: "order_cancelled", topic, shopDomain, channelOrderId };
      if (decision === "skip")
        return {
          kind: "ignored",
          topic,
          shopDomain,
          reason: `order ${channelOrderId} not paid (${payload.financial_status ?? "no financial_status"}); skipped`,
        };
      const order = restOrderToNormalized(payload);
      if (!order.items.length)
        return {
          kind: "ignored",
          topic,
          shopDomain,
          reason: `order ${channelOrderId} has no lines`,
        };
      return { kind: "order_upsert", topic, shopDomain, order };
    }
    case "orders/cancelled":
      return { kind: "order_cancelled", topic, shopDomain, channelOrderId: String(payload.id) };
    case "app/uninstalled":
      return { kind: "uninstalled", topic, shopDomain };
    default:
      return { kind: "ignored", topic, shopDomain };
  }
}
