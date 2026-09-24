import { contract } from "@invai/contracts";
import { authed, stubRouter } from "../../api/orpc";

/*
 * inventory routers. Every procedure starts as a NOT_IMPLEMENTED stub; replace entries as you
 * implement them (see src/modules/catalog/router.ts and src/modules/README.md).
 */

export const inventoryRouter = authed.inventory.router({
  ...stubRouter(authed.inventory, contract.inventory, ["inventory"]),
});
