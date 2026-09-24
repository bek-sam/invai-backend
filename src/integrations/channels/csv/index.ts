import type { Channel } from "@invai/contracts";
import { upstream } from "../../../lib/errors";
import type { ChannelAdapter } from "../types";

export * from "./parse";

/** Channels with no API at all (generic CSV, eBay in v1): orders come only from CSV uploads. */
export function csvOnlyAdapter(channel: Channel): ChannelAdapter {
  return {
    channel,
    pendingApproval: false,
    async fetchOrders() {
      throw upstream(channel, "CSV connections cannot sync; upload an export instead");
    },
    async pushTracking(_conn, push) {
      return {
        status: "manual",
        externalId: null,
        message: `Upload tracking ${push.trackingCode} for order ${push.channelOrderId} manually`,
      };
    },
    async setAvailability() {
      return { updated: 0 };
    },
    async verifyWebhook() {
      return false;
    },
    async parseWebhook() {
      return { kind: "ignored", topic: "unsupported", shopDomain: null };
    },
  };
}
