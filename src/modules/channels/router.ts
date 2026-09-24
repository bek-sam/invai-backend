import { contract } from "@invai/contracts";
import { authed, stubRouter } from "../../api/orpc";

/*
 * channels routers. Every procedure starts as a NOT_IMPLEMENTED stub; replace entries as you
 * implement them (see src/modules/catalog/router.ts and src/modules/README.md).
 */

export const channelsRouter = authed.channels.router({
  ...stubRouter(authed.channels, contract.channels, ["channels"]),
});

export const skuRulesRouter = authed.skuRules.router({
  ...stubRouter(authed.skuRules, contract.skuRules, ["skuRules"]),
});
