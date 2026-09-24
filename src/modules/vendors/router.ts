import { contract } from "@invai/contracts";
import { authed, stubRouter } from "../../api/orpc";

/*
 * vendors routers. Every procedure starts as a NOT_IMPLEMENTED stub; replace entries as you
 * implement them (see src/modules/catalog/router.ts and src/modules/README.md).
 */

export const vendorsRouter = authed.vendors.router({
  ...stubRouter(authed.vendors, contract.vendors, ["vendors"]),
});

export const vendorPortalRouter = authed.vendorPortal.router({
  ...stubRouter(authed.vendorPortal, contract.vendorPortal, ["vendorPortal"]),
});
