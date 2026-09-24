import { contract } from "@invai/contracts";
import { authed, stubRouter } from "../../api/orpc";

/*
 * orders routers. Every procedure starts as a NOT_IMPLEMENTED stub; replace entries as you
 * implement them (see src/modules/catalog/router.ts and src/modules/README.md).
 */

export const ordersRouter = authed.orders.router({
  ...stubRouter(authed.orders, contract.orders, ["orders"]),
});

export const orderItemsRouter = authed.orderItems.router({
  ...stubRouter(authed.orderItems, contract.orderItems, ["orderItems"]),
});
