import type { NormalizedOrder } from "@invai/contracts";
import { env } from "../../../env";
import { upstream } from "../../../lib/errors";
import { pendingApprovalAdapter } from "../pending";
import { mockShopifyOrder } from "../shopify/mock";
import type { ChannelAdapter, FetchedOrder } from "../types";
import {
  etsyWebhookSecretFromEnv,
  MOCK_ETSY_WEBHOOK_SECRET,
  parseEtsyWebhook,
  verifyEtsyWebhook,
} from "./webhooks";

export {
  ETSY_WEBHOOK_TOLERANCE_SEC,
  MOCK_ETSY_WEBHOOK_SECRET,
  signEtsyWebhook,
  verifyEtsyWebhook,
} from "./webhooks";

/**
 * Etsy Open API v3. Planned calls once the app is approved:
 * GET /v3/application/shops/{shop_id}/receipts?was_paid=true&min_last_modified=... (orders),
 * GET /v3/application/shops/{shop_id}/receipts/{receipt_id} (webhook fetch by id) and
 * POST /v3/application/shops/{shop_id}/receipts/{receipt_id}/tracking (tracking).
 * Webhooks (portal-registered, Standard Webhooks) are verified today: see ./webhooks.ts.
 */
const pending = pendingApprovalAdapter("etsy", "Etsy", {
  orders: "Shop Manager > Settings > Options > Download Data > Orders + Order Items",
  tracking: "Orders & Shipping > Complete order > Add tracking",
});

/** True when no Etsy webhook secret is configured: webhooks verify against the mock secret. */
export function etsyMocked(): boolean {
  return etsyWebhookSecretFromEnv() === null;
}

/**
 * The mock Etsy store's receipt: the demo catalog order for this receipt number, relabelled as
 * Etsy. Deterministic; receipt ids divisible by 10 are cancelled, so cancel events can be tried.
 */
export function mockEtsyReceipt(receiptId: string, now = new Date()): FetchedOrder {
  const n = Number(BigInt(receiptId) % 100_000n);
  const base = mockShopifyOrder(n, now);
  const order: NormalizedOrder = {
    ...base,
    channel: "etsy",
    channelOrderId: receiptId,
    orderNo: receiptId,
    items: base.items.map((item, i) => ({ ...item, channelLineId: `${receiptId}-${i + 1}` })),
  };
  return { order, cancelled: n % 10 === 0 };
}

const etsyLive: ChannelAdapter = {
  ...pending,
  async verifyWebhook(headers, body, opts) {
    const secret = etsyWebhookSecretFromEnv();
    return !!secret && verifyEtsyWebhook(headers, body, secret, opts?.receivedAt);
  },
  async parseWebhook(_headers, body) {
    return parseEtsyWebhook(body);
  },
  async fetchOrder() {
    throw upstream(
      "Etsy",
      "Fetching Etsy orders is pending marketplace approval; import the Etsy CSV export instead",
    );
  },
};

/** Order sync and tracking stay "pending approval" in mock mode too; only webhooks are mocked. */
const etsyMock: ChannelAdapter = {
  ...pending,
  async verifyWebhook(headers, body, opts) {
    // The mock secret is public: never accept it in production.
    if (env.isProd) return false;
    return verifyEtsyWebhook(headers, body, MOCK_ETSY_WEBHOOK_SECRET, opts?.receivedAt);
  },
  async parseWebhook(_headers, body) {
    return parseEtsyWebhook(body);
  },
  async fetchOrder(_conn, channelOrderId) {
    if (env.isProd) throw upstream("Etsy", "The mock Etsy store is not available in production");
    return mockEtsyReceipt(channelOrderId);
  },
};

/** The live adapter when ETSY_WEBHOOK_SECRET is set, else the mock. */
export function etsyAdapter(
  provider: "live" | "mock" = etsyMocked() ? "mock" : "live",
): ChannelAdapter {
  return provider === "live" && !etsyMocked() ? etsyLive : etsyMock;
}
