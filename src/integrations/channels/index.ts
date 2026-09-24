import type { Channel } from "@invai/contracts";
import { amazonAdapter } from "./amazon";
import { csvOnlyAdapter } from "./csv";
import { etsyAdapter } from "./etsy";
import { shopifyAdapter } from "./shopify";
import { tiktokAdapter } from "./tiktok";
import type { ChannelAdapter } from "./types";
import { walmartAdapter } from "./walmart";

export type * from "./types";

/**
 * The adapter for a channel. Shopify picks live or mock from the connection's provider (and the
 * env keys); Etsy/Amazon/TikTok/Walmart are pending marketplace approval (CSV import works, tracking
 * push returns `manual`); eBay and generic CSV have no API.
 */
export function getChannelAdapter(kind: Channel, provider?: "live" | "mock"): ChannelAdapter {
  switch (kind) {
    case "shopify":
      return shopifyAdapter(provider);
    case "etsy":
      return etsyAdapter;
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
