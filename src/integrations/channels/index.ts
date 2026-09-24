import type { Channel } from "@invai/contracts";
import { env } from "../../env";
import { amazonAdapter } from "./amazon";
import { csvOnlyAdapter } from "./csv";
import { etsyAdapter, etsyMocked } from "./etsy";
import { shopifyAdapter } from "./shopify";
import { tiktokAdapter } from "./tiktok";
import type { ChannelAdapter } from "./types";
import { type HeaderBag, header } from "./types";
import { walmartAdapter } from "./walmart";

export type * from "./types";

/**
 * The adapter for a channel. Shopify and Etsy pick live or mock from the provider (and the env
 * keys); Etsy/Amazon/TikTok/Walmart are pending marketplace approval (CSV import works, tracking
 * push returns `manual`; Etsy webhooks are verified); eBay and generic CSV have no API.
 */
export function getChannelAdapter(kind: Channel, provider?: "live" | "mock"): ChannelAdapter {
  switch (kind) {
    case "shopify":
      return shopifyAdapter(provider);
    case "etsy":
      return etsyAdapter(provider);
    case "amazon":
      return amazonAdapter;
    case "tiktok":
      return tiktokAdapter;
    case "walmart":
      return walmartAdapter;
    default:
      return csvOnlyAdapter(kind);
  }
}

/** True when this channel's platform-wide key is missing, so it runs on its mock provider. */
export function channelMocked(kind: Channel): boolean {
  switch (kind) {
    case "shopify":
      return env.mocks.shopify;
    case "etsy":
      return etsyMocked();
    default:
      return true;
  }
}

/** The adapter webhooks for this channel are verified and parsed with (per-channel mock flag). */
export function webhookAdapter(kind: Channel): ChannelAdapter {
  return getChannelAdapter(kind, channelMocked(kind) ? "mock" : "live");
}

/** Each channel's delivery-id header, the key webhook redeliveries are deduplicated on. */
const DELIVERY_ID_HEADERS: Partial<Record<Channel, string>> = {
  shopify: "x-shopify-webhook-id",
  etsy: "webhook-id",
};

export const MAX_DELIVERY_ID_LENGTH = 200;

/** The delivery id, or null when the header is missing or malformed (never a made-up one). */
export function webhookDeliveryId(kind: Channel, headers: HeaderBag): string | null {
  const name = DELIVERY_ID_HEADERS[kind];
  const value = name ? header(headers, name)?.trim() : null;
  // Printable ASCII only: it becomes part of a job id and a log line.
  if (!value || value.length > MAX_DELIVERY_ID_LENGTH || !/^[!-~]+$/.test(value)) return null;
  return value;
}
