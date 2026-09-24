import { contract } from "@invai/contracts";
import { authed, stubRouter } from "../../api/orpc";

/*
 * personalization routers. Every procedure starts as a NOT_IMPLEMENTED stub; replace entries as you
 * implement them (see src/modules/catalog/router.ts and src/modules/README.md).
 */

export const personalizationRouter = authed.personalization.router({
  ...stubRouter(authed.personalization, contract.personalization, ["personalization"]),
});
