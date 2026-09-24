import { pendingApprovalAdapter } from "../pending";

/**
 * Etsy Open API v3. Planned calls once the app is approved:
 * GET /v3/application/shops/{shop_id}/receipts?was_paid=true&min_last_modified=... (orders) and
 * POST /v3/application/shops/{shop_id}/receipts/{receipt_id}/tracking (tracking).
 */
export const etsyAdapter = pendingApprovalAdapter("etsy", "Etsy", {
  orders: "Shop Manager > Settings > Options > Download Data > Orders + Order Items",
  tracking: "Orders & Shipping > Complete order > Add tracking",
});
