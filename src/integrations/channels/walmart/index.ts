import { pendingApprovalAdapter } from "../pending";

/**
 * Walmart Marketplace API. Planned calls: GET /v3/orders?createdStartDate=... and
 * POST /v3/orders/{purchaseOrderId}/shipping (ship lines with tracking).
 */
export const walmartAdapter = pendingApprovalAdapter("walmart", "Walmart", {
  orders: "Seller Center > Order Management > Download",
  tracking: "Seller Center > Order Management > Bulk Update > Shipping",
});
