import type { Channel } from "@invai/contracts";
import { upstream } from "../../lib/errors";
import { logger } from "../../lib/log";
import type { ChannelAdapter } from "./types";

const log = logger("channels.pending");

/**
 * Adapter for a marketplace whose API app is not approved yet (Etsy, Amazon SP-API, TikTok Shop,
 * Walmart). Orders arrive by CSV export meanwhile; API calls fail with a clear UPSTREAM_FAILED.
 * Tracking push succeeds as `manual` so shipping keeps working: the shop uploads tracking in the
 * marketplace (or its shipping-confirmation file) by hand.
 */
export function pendingApprovalAdapter(
  channel: Channel,
  label: string,
  docs: { orders: string; tracking: string },
): ChannelAdapter {
  const pending = (what: string) =>
    upstream(
      label,
      `${what} is pending marketplace approval; import the ${label} CSV export instead (${docs.orders})`,
    );
  return {
    channel,
    pendingApproval: true,
    async fetchOrders() {
      throw pending("Order sync");
    },
    async pushTracking(conn, push) {
      log.info("manual upload needed", {
        channel,
        connectionId: conn.id,
        channelOrderId: push.channelOrderId,
        carrier: push.carrier,
      });
      return {
        status: "manual",
        externalId: null,
        message: `Upload tracking ${push.trackingCode} (${push.carrier}) for ${label} order ${push.channelOrderId} manually: use "Export tracking for ${label}" on the Shipping page, or go to ${docs.tracking}`,
      };
    },
    async setAvailability() {
      throw pending("Inventory sync");
    },
    async verifyWebhook() {
      return false;
    },
    async parseWebhook() {
      return { kind: "ignored", topic: "unsupported", shopDomain: null };
    },
  };
}
