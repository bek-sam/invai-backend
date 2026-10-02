import { contract } from "@invai/contracts";
import { authed, stubRouter } from "../../api/orpc";
import { withTenant } from "../../db/client";
import * as svc from "./service";

/*
 * Listing photos (T-26-4, ADR 0023): one line per handler. The guard already enforced auth and
 * `photos.read` / `photos.manage` from the contract meta. Phase B (`pushTargets`,
 * `pushToShopify`) stays NOT_IMPLEMENTED until wave 27.
 */
export const photosRouter = authed.photos.router({
  ...stubRouter(authed.photos, contract.photos, ["photos"]),
  analyzeDesign: authed.photos.analyzeDesign.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.analyzeDesign(tx, tenant, input)),
  ),
  estimate: authed.photos.estimate.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.estimate(tx, tenant, input)),
  ),
  createSet: authed.photos.createSet.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.createSet(tx, tenant, input)),
  ),
  listSets: authed.photos.listSets.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.listSets(tx, tenant, input)),
  ),
  getSet: authed.photos.getSet.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.getSet(tx, tenant, input)),
  ),
  reviewImages: authed.photos.reviewImages.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.reviewImages(tx, tenant, input)),
  ),
  exportZip: authed.photos.exportZip.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.exportZip(tx, tenant, input)),
  ),
  attachToDraft: authed.photos.attachToDraft.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.attachToDraft(tx, tenant, input)),
  ),
});
