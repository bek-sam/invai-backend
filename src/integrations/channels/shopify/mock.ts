import type { NormalizedOrder } from "@invai/contracts";
import {
  BLANK_STYLES,
  CITIES,
  DESIGNS,
  FIRST_NAMES,
  LAST_NAMES,
  PERSONALIZATION_ANSWERS,
  rng,
  SIZES,
  STREETS,
  TEMPLATES,
} from "../../../db/seed/data";
import { logger } from "../../../lib/log";
import { type ChannelAdapter, normalizeAvailability } from "../types";
import { parseShopifyWebhook, SHOPIFY_WEBHOOK_TOPICS, verifyShopifyHmac } from "./common";

const log = logger("channels.shopify.mock");

/*
 * Mock Shopify store (no SHOPIFY_API_KEY). Every fetch "receives" 1-3 new orders for the demo
 * catalog (SKU scheme `{design}-{style}-{color}-{size}`), occasionally a personalized design or
 * an unknown SKU, so a live demo shows imports landing. Deterministic per sequence number: the
 * cursor is `mock:<n>` and order n always looks the same.
 */

const STYLES = BLANK_STYLES.slice(0, 2);

export function mockShopifyOrder(n: number, now = new Date()): NormalizedOrder {
  const r = rng(0x5eed + n * 7919);
  const first = r.pick(FIRST_NAMES);
  const last = r.pick(LAST_NAMES);
  const city = r.pick(CITIES);
  const lines = r.chance(0.7) ? 1 : 2;
  const items: NormalizedOrder["items"] = [];
  for (let l = 0; l < lines; l++) {
    const design = r.chance(0.12)
      ? r.pick(DESIGNS.filter((d) => d.template !== undefined))
      : r.pick(DESIGNS);
    const style = r.pick(STYLES) ?? BLANK_STYLES[0];
    if (!style) throw new Error("no blank styles");
    const color = r.pick(style.colors);
    const size = r.pick(SIZES);
    const unknown = r.chance(0.06);
    const template = design.template !== undefined ? TEMPLATES[design.template] : undefined;
    const answers = template ? r.pick(PERSONALIZATION_ANSWERS) : null;
    const price = style.styleCode === "CC1717" ? 3600 : 2800;
    items.push({
      channelLineId: String(14_000_000_000 + n * 10 + l),
      channelSku: unknown
        ? `SHOP-${r.int(1000, 9999)}-${color.code}`
        : `${design.code}-${style.styleCode}-${color.code}-${size.code}`,
      channelListingId: String(8_100_000_000 + Number.parseInt(design.code.slice(2), 10)),
      title: `${design.name} Tee`,
      variantTitle: `${color.name} / ${size.size}`,
      quantity: r.chance(0.8) ? 1 : 2,
      unitPrice: price + size.upcharge,
      personalization:
        template && answers
          ? template.slots.map((s) => ({
              question: s.sourceQuestion ?? s.name,
              answer: (answers as Record<string, string>)[s.sourceQuestion ?? s.name] ?? null,
              fileUrl: null,
            }))
          : [],
    });
  }
  const subtotal = items.reduce((s, i) => s + i.unitPrice * i.quantity, 0);
  const shipping = subtotal >= 5000 ? 0 : 599;
  const tax = Math.round(subtotal * 0.086);
  const rush = r.chance(0.08);
  return {
    channel: "shopify",
    channelOrderId: String(6_200_000_000 + n),
    orderNo: `#${3000 + n}`,
    placedAt: new Date(now.getTime() - r.int(1, 20) * 60_000).toISOString(),
    sourceUpdatedAt: null,
    shipBy: null,
    isRush: rush,
    buyerName: `${first} ${last}`,
    buyerEmail: `${first}.${last}.${n}@example.com`.toLowerCase(),
    shipTo: {
      name: `${first} ${last}`,
      company: null,
      street1: `${r.int(100, 9800)} ${r.pick(STREETS)}`,
      street2: r.chance(0.2) ? `Apt ${r.int(1, 40)}` : null,
      city: city.city,
      state: city.state,
      zip: city.zip,
      country: "US",
      phone: null,
      email: null,
    },
    shippingMethod: rush ? "Express" : shipping ? "Standard" : "Free shipping",
    totals: { subtotal, shipping, tax, discount: 0, total: subtotal + shipping + tax },
    buyerNote: r.chance(0.1) ? "Gift, please no receipt" : null,
    items,
  };
}

/** What the mock store has subscribed, per connection (for tests and the local demo). */
const mockSubscriptions = new Map<string, string[]>();

export function mockShopifySubscriptions(connectionId: string): string[] {
  return mockSubscriptions.get(connectionId) ?? [];
}

export const shopifyMock: ChannelAdapter = {
  channel: "shopify",
  pendingApproval: false,

  async fetchOrders(conn) {
    const seq = conn.cursor?.startsWith("mock:") ? Number(conn.cursor.slice(5)) || 0 : 0;
    const count = 1 + ((seq * 31 + 7) % 3);
    const orders = Array.from({ length: count }, (_, i) => mockShopifyOrder(seq + i + 1));
    log.info("mock shopify fetch", { connectionId: conn.id, orders: orders.length });
    return { orders, cancelledChannelOrderIds: [], nextCursor: `mock:${seq + count}` };
  },

  async pushTracking(conn, push) {
    log.info("mock shopify fulfillment", {
      connectionId: conn.id,
      channelOrderId: push.channelOrderId,
      trackingCode: push.trackingCode,
    });
    return {
      status: "pushed",
      externalId: `gid://shopify/Fulfillment/${push.channelOrderId}${push.trackingCode.slice(-4)}`,
      message: null,
    };
  },

  async setAvailability(conn, updates) {
    const list = normalizeAvailability(updates);
    log.info("mock shopify availability", {
      connectionId: conn.id,
      items: list.map((u) => ({ sku: u.channelSku, available: Math.max(0, u.available) })),
    });
    return {
      updated: list.length,
      results: list.map((u) => ({
        listingVariantId: u.listingVariantId,
        status: "set" as const,
        available: Math.max(0, Math.trunc(u.available)),
        message: null,
      })),
    };
  },

  async verifyWebhook(headers, body) {
    return verifyShopifyHmac(headers, body);
  },

  async parseWebhook(headers, body) {
    return parseShopifyWebhook(headers, body);
  },

  async ensureWebhooks(conn) {
    const ids = SHOPIFY_WEBHOOK_TOPICS.map(
      (t, i) => `gid://shopify/WebhookSubscription/mock-${conn.id.slice(0, 8)}-${i}-${t}`,
    );
    mockSubscriptions.set(conn.id, ids);
    log.info("mock shopify webhooks subscribed", { connectionId: conn.id, topics: ids.length });
    return { checkedAt: new Date().toISOString(), subscriptionIds: ids, failures: [] };
  },

  async disconnect(conn) {
    const ids = mockSubscriptions.get(conn.id) ?? conn.credentials?.webhooks?.subscriptionIds ?? [];
    mockSubscriptions.delete(conn.id);
    log.info("mock shopify unsubscribed and uninstalled", {
      connectionId: conn.id,
      unsubscribed: ids.length,
    });
    return { unsubscribed: ids.length, uninstalled: true, errors: [] };
  },
};
