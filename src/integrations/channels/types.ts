import type { Channel, NormalizedOrder } from "@invai/contracts";

/*
 * Channel adapter interface. Adapters normalize at the edge: the core only ever sees
 * `NormalizedOrder`. Credentials arrive decrypted in `ChannelConn.credentials`; adapters never
 * touch the database.
 */

/** Result of the last webhook-subscription check (kept in the encrypted credentials). */
export type WebhookSubscriptionState = {
  checkedAt: string;
  subscriptionIds: string[];
  /** Topics that could not be subscribed; non-empty = the connection is degraded. */
  failures: { topic: string; message: string }[];
};

export type ChannelDisconnectResult = {
  unsubscribed: number;
  /** The app was removed from the store and its token revoked. */
  uninstalled: boolean;
  errors: string[];
};

export type ChannelCredentials = {
  accessToken?: string;
  refreshToken?: string;
  /** When the access token expires (expiring offline tokens: 1 hour). */
  expiresAt?: string | null;
  /** When the refresh token expires (Shopify: 90 days); the shop must reconnect after it. */
  refreshTokenExpiresAt?: string | null;
  /** The last refresh failed: the connection is flagged until a refresh or reconnect works. */
  refreshError?: { at: string; message: string; permanent: boolean } | null;
  scopes?: string[];
  /** Shopify: the location inventory is set on and fulfillments ship from. */
  locationId?: string | null;
  webhooks?: WebhookSubscriptionState;
  [key: string]: unknown;
};

export type ChannelConn = {
  id: string;
  companyId: string;
  channel: Channel;
  name: string;
  mode: "api" | "csv";
  provider: "live" | "mock";
  externalShopId: string | null;
  cursor: string | null;
  credentials: ChannelCredentials | null;
};

/**
 * T-7-2: one refund (or one line of one) the channel reports after the sale. Finance upserts
 * these into `refund_events` by (channel, channelRefundId), so a re-read never double-counts.
 */
export type ChannelRefund = {
  channelOrderId: string;
  /** Stable per refund line, e.g. `<refund id>:<line id>` or `<refund id>:order`. */
  channelRefundId: string;
  /** null = order-level (shipping, an adjustment, or a file with one refund total per order). */
  channelLineId: string | null;
  /** Units of that line refunded (1 for order-level). */
  quantity: number;
  amountCents: number;
  /** null = the source has no refund date (some CSV exports); finance uses the import time. */
  refundedAt: string | null;
  note: string | null;
};

export type FetchOrdersResult = {
  orders: NormalizedOrder[];
  /** Orders the channel reports as cancelled since the last cursor. */
  cancelledChannelOrderIds: string[];
  nextCursor: string | null;
  /** Refunds on the fetched orders (T-7-2); absent = the adapter doesn't read refunds. */
  refunds?: ChannelRefund[];
};

export type TrackingPush = {
  channelOrderId: string;
  carrier: string;
  trackingCode: string;
  trackingUrl?: string | null;
  /** Channel lines (and unit counts) covered by this shipment. */
  items: { channelLineId: string; quantity: number }[];
};

export type TrackingPushResult = {
  /** `manual`: the channel has no API access yet; the shop uploads tracking by hand. */
  status: "pushed" | "manual";
  externalId: string | null;
  message: string | null;
};

/**
 * One listing variant's availability to set on the channel (wave 3 agreed interface). Adapters
 * never touch the database, so the caller passes the channel SKU it recorded for the variant.
 */
export type AvailabilityUpdate = {
  /** Our `listing_variants.id`; results are keyed by it. */
  listingVariantId: string;
  channelSku: string;
  /** The quantity to set (negative values are sent as 0). */
  available: number;
};

/** @deprecated The pre-wave-3 shape; `normalizeAvailability` maps it. Remove once no caller uses it. */
export type LegacyAvailabilityUpdate = { channelSku: string; quantity: number };

export type SetAvailabilityOptions = {
  /**
   * Stable per push intent (e.g. stored with the push): a retry of the same push reuses it, so the
   * channel applies it once. Omitted: a fresh key per call.
   */
  idempotencyKey?: string;
};

export type AvailabilityItemResult = {
  listingVariantId: string;
  /** `set`: the channel now holds `available`; `not_found`: no variant or no stock level there. */
  status: "set" | "not_found" | "failed";
  available: number | null;
  message: string | null;
};

export type SetAvailabilityResult = {
  updated: number;
  /** Per listing variant (live adapters always fill it; channels without inventory sync omit it). */
  results?: AvailabilityItemResult[];
};

export function normalizeAvailability(
  updates: (AvailabilityUpdate | LegacyAvailabilityUpdate)[],
): AvailabilityUpdate[] {
  return updates.map((u) =>
    "available" in u
      ? u
      : { listingVariantId: u.channelSku, channelSku: u.channelSku, available: u.quantity },
  );
}

/** A channel privacy request (Shopify compliance topics). Ids only: no buyer PII is kept. */
export type PrivacyWebhookRequest = {
  topic: "customers/data_request" | "customers/redact" | "shop/redact";
  channelCustomerId: string | null;
  channelRequestId: string | null;
  channelOrderIds: string[];
};

export type WebhookEvent =
  | { kind: "order_upsert"; topic: string; shopDomain: string | null; order: NormalizedOrder }
  | { kind: "order_cancelled"; topic: string; shopDomain: string | null; channelOrderId: string }
  | { kind: "uninstalled"; topic: string; shopDomain: string | null }
  /** The webhook only names an order (Etsy): fetch it by id and trust the fetch, not the payload. */
  | { kind: "order_ref"; topic: string; shopDomain: string | null; channelOrderId: string }
  /** Compliance request; `shopDomain` comes from the signed body, not the unsigned header. */
  | { kind: "privacy"; topic: string; shopDomain: string | null; request: PrivacyWebhookRequest }
  /** `reason` is logged and kept on the delivery record (no PII). */
  | { kind: "ignored"; topic: string; shopDomain: string | null; reason?: string };

/** One order fetched by id: `order` null when the channel no longer has it. */
export type FetchedOrder = { order: NormalizedOrder | null; cancelled: boolean };

export type VerifyWebhookOptions = {
  /** When the delivery reached us; signed timestamps are checked against it (default: now). */
  receivedAt?: Date;
};

export type HeaderBag = Headers | Record<string, string | undefined>;

export function header(headers: HeaderBag, name: string): string | null {
  if (headers instanceof Headers) return headers.get(name);
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? (headers[key] ?? null) : null;
}

export interface ChannelAdapter {
  channel: Channel;
  /** True when the marketplace app is not approved yet (API calls fail, CSV works). */
  pendingApproval: boolean;
  fetchOrders(conn: ChannelConn): Promise<FetchOrdersResult>;
  pushTracking(conn: ChannelConn, push: TrackingPush): Promise<TrackingPushResult>;
  /**
   * Set available quantities on the channel. Shopify: compare-and-set (`changeFromQuantity` =
   * the quantity just read) under an `@idempotent` key; a stale compare re-reads and retries once.
   */
  setAvailability(
    conn: ChannelConn,
    updates: (AvailabilityUpdate | LegacyAvailabilityUpdate)[],
    opts?: SetAvailabilityOptions,
  ): Promise<SetAvailabilityResult>;
  verifyWebhook(headers: HeaderBag, body: string, opts?: VerifyWebhookOptions): Promise<boolean>;
  parseWebhook(headers: HeaderBag, body: string): Promise<WebhookEvent>;
  /** Subscribe the order webhooks to `uri` (re-creating any the channel dropped). */
  ensureWebhooks?(conn: ChannelConn, uri: string): Promise<WebhookSubscriptionState>;
  /** Unsubscribe the webhooks and revoke the token on the channel's side. Never throws. */
  disconnect?(conn: ChannelConn, uri: string): Promise<ChannelDisconnectResult>;
  /** Fetch one order by its channel id (webhook `order_ref` events). */
  fetchOrder?(conn: ChannelConn, channelOrderId: string): Promise<FetchedOrder>;
}
