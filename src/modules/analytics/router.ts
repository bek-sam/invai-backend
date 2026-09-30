import { authed } from "../../api/orpc";
import { withTenant } from "../../db/client";
import { designLifecycle } from "./design-service";
import { exportAnalyticsCsv } from "./export-service";
import * as finance from "./finance-service";
import { inventoryHealth, supplierTrends } from "./inventory-service";
import * as operations from "./operations-service";

/*
 * `analytics.*` (contract 0.9.0, wave A1). The guard already enforced `finance.read` from the
 * contract meta; every read runs inside `withTenant`. T-A3 registers the finance views below;
 * T-A4 adds `operations`; T-A5 adds inventoryHealth, supplierTrends, designLifecycle and export
 * (each card added only its own lines). All 11 `analytics.*` procedures are implemented, so the
 * `stubRouter` fallback T-A2 committed is no longer needed.
 */

export const analyticsRouter = authed.analytics.router({
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
  // T-A4: operations analytics.
  operations: authed.analytics.operations.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => operations.getOperations(tx, tenant, input)),
  ),
  // T-A5: inventory and design analytics, plus the shared CSV export.
  inventoryHealth: authed.analytics.inventoryHealth.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => inventoryHealth(tx, tenant, input)),
  ),
  supplierTrends: authed.analytics.supplierTrends.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => supplierTrends(tx, tenant, input)),
  ),
  designLifecycle: authed.analytics.designLifecycle.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => designLifecycle(tx, tenant, input)),
  ),
  export: authed.analytics.export.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => exportAnalyticsCsv(tx, tenant, input)),
  ),
});
