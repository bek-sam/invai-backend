import type { Channel, NormalizedOrder } from "@invai/contracts";

/*
 * Channel adapter interface. Adapters normalize at the edge: the core only ever sees
 * `NormalizedOrder`. Credentials arrive decrypted in `ChannelConn.credentials`; adapters never
 * touch the database.
 */

export type ChannelCredentials = {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: string | null;
  scopes?: string[];
  /** Shopify: the location inventory is set on and fulfillments ship from. */
  locationId?: string | null;
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

export type FetchOrdersResult = {
  orders: NormalizedOrder[];
  /** Orders the channel reports as cancelled since the last cursor. */
  cancelledChannelOrderIds: string[];
  nextCursor: string | null;
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

export type WebhookEvent =
  | { kind: "order_upsert"; topic: string; shopDomain: string | null; order: NormalizedOrder }
  | { kind: "order_cancelled"; topic: string; shopDomain: string | null; channelOrderId: string }
  | { kind: "uninstalled"; topic: string; shopDomain: string | null }
  /** The webhook only names an order (Etsy): fetch it by id and trust the fetch, not the payload. */
  | { kind: "order_ref"; topic: string; shopDomain: string | null; channelOrderId: string }
  | { kind: "ignored"; topic: string; shopDomain: string | null };

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
  /** Fetch one order by its channel id (webhook `order_ref` events). */
  fetchOrder?(conn: ChannelConn, channelOrderId: string): Promise<FetchedOrder>;
}
