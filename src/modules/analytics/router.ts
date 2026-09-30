import { contract } from "@invai/contracts";
import { authed, stubRouter } from "../../api/orpc";
import { withTenant } from "../../db/client";
import * as finance from "./finance-service";

/*
 * `analytics.*` (contract 0.9.0, wave A1). The guard already enforced `finance.read` from the
 * contract meta; every read runs inside `withTenant`. T-A3 registers the finance views below;
 * T-A4 adds `operations`, T-A5 adds inventoryHealth, supplierTrends, designLifecycle and export
 * (each card adds only its own lines). Until then those stay NOT_IMPLEMENTED via `stubRouter`.
 */

export const analyticsRouter = authed.analytics.router({
  ...stubRouter(authed.analytics, contract.analytics, ["analytics"]),
  // T-A3: finance analytics.
  unitEconomics: authed.analytics.unitEconomics.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => finance.unitEconomics(tx, tenant, input)),
  ),
  losingOrders: authed.analytics.losingOrders.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => finance.losingOrders(tx, tenant, input)),
  ),
  leakage: authed.analytics.leakage.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => finance.leakage(tx, tenant, input)),
  ),
  shippingMargin: authed.analytics.shippingMargin.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => finance.shippingMargin(tx, tenant, input)),
  ),
  profitBridge: authed.analytics.profitBridge.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => finance.profitBridge(tx, tenant, input)),
  ),
  breakEven: authed.analytics.breakEven.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => finance.breakEven(tx, tenant, input)),
  ),
});
