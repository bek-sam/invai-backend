import { authed } from "../../api/orpc";
import { withTenant } from "../../db/client";
import * as svc from "./service";

/*
 * `market.*` (contract 0.6.0). The guard already enforced auth and the permission from the
 * contract meta: niches `catalog.read` / `market.niches.manage`, recommendations `finance.read`.
 */

export const marketRouter = authed.market.router({
  niches: {
    taxonomy: authed.market.niches.taxonomy.handler(() => svc.nicheTaxonomy()),
    get: authed.market.niches.get.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.getDesignNiches(tx, tenant, input)),
    ),
    set: authed.market.niches.set.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.setDesignNiches(tx, tenant, input)),
    ),
  },
  recommendations: {
    list: authed.market.recommendations.list.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.listRecommendationsPage(tx, tenant, input)),
    ),
    vote: authed.market.recommendations.vote.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.voteRecommendation(tx, tenant, input)),
    ),
  },
});
