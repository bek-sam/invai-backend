import { authed } from "../../api/orpc";
import { withTenant } from "../../db/client";
import * as svc from "./service";

export const billingRouter = authed.billing.router({
  get: authed.billing.get.handler(({ context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.getStatus(tx, tenant)),
  ),
  plans: authed.billing.plans.handler(({ context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.listPlans(tx)),
  ),
  changePlan: authed.billing.changePlan.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.changePlan(tx, tenant, input.plan)),
  ),
});
