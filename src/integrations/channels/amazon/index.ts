import { pendingApprovalAdapter } from "../pending";

/**
 * Amazon SP-API (restricted role; needs a security review). Planned calls: Orders API
 * getOrders/getOrderItems and Feeds API POST_ORDER_FULFILLMENT_DATA / confirmShipment.
 */
export const amazonAdapter = pendingApprovalAdapter("amazon", "Amazon", {
  orders: "Seller Central > Orders > Order Reports > Unshipped Orders",
  tracking: "Seller Central > Orders > Upload Order Related Files > Shipping Confirmation",
});
