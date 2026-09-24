import { pendingApprovalAdapter } from "../pending";

/**
 * TikTok Shop Partner API. Planned calls: POST /order/202309/orders/search and
 * POST /fulfillment/202309/orders/{order_id}/packages (ship with tracking).
 */
export const tiktokAdapter = pendingApprovalAdapter("tiktok", "TikTok Shop", {
  orders: "Seller Center > Orders > Manage orders > Export",
  tracking: "Seller Center > Orders > Batch ship > Upload tracking file",
});
