import { contract } from "@invai/contracts";
import { authed, stubRouter } from "../../api/orpc";

/*
 * shipping routers. Every procedure starts as a NOT_IMPLEMENTED stub; replace entries as you
 * implement them (see src/modules/catalog/router.ts and src/modules/README.md).
 */

export const shippingRouter = authed.shipping.router({
  ...stubRouter(authed.shipping, contract.shipping, ["shipping"]),
});
