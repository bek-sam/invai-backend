import { contract } from "@invai/contracts";
import { authed, stubRouter } from "../../api/orpc";

/*
 * Listing photos (T-26-4, ADR 0023). Every procedure answers NOT_IMPLEMENTED until the module
 * lands; `pushToShopify` stays a stub until wave 27.
 */
export const photosRouter = authed.photos.router({
  ...stubRouter(authed.photos, contract.photos, ["photos"]),
});
