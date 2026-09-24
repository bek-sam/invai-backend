import { contract } from "@invai/contracts";
import { authed, stubRouter } from "../../api/orpc";

/*
 * finance routers. Every procedure starts as a NOT_IMPLEMENTED stub; replace entries as you
 * implement them (see src/modules/catalog/router.ts and src/modules/README.md).
 */

export const financeRouter = authed.finance.router({
  ...stubRouter(authed.finance, contract.finance, ["finance"]),
});
