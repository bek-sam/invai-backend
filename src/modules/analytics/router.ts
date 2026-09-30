import { contract } from "@invai/contracts";
import { authed, stubRouter } from "../../api/orpc";

/*
 * `analytics.*` (contract 0.9.0, wave A1). Committed by T-A2 as a pure stub so the root router
 * typechecks and the guard already answers FORBIDDEN for roles without `finance.read`; every
 * procedure throws NOT_IMPLEMENTED until its implementer registers it here: T-A3 takes this file
 * over (unitEconomics, losingOrders, leakage, shippingMargin, profitBridge, breakEven), T-A4 adds
 * `operations`, T-A5 adds inventoryHealth, supplierTrends, designLifecycle and export.
 */

export const analyticsRouter = authed.analytics.router({
  ...stubRouter(authed.analytics, contract.analytics, ["analytics"]),
});
