import { contract } from "@invai/contracts";
import { authed, stubRouter } from "../../api/orpc";

/*
 * billing routers. Every procedure starts as a NOT_IMPLEMENTED stub; replace entries as you
 * implement them (see src/modules/catalog/router.ts and src/modules/README.md).
 */

export const billingRouter = authed.billing.router({
  ...stubRouter(authed.billing, contract.billing, ["billing"]),
});
