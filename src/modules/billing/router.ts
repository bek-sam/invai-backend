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
  // These three call Stripe, so they open their own short transactions around the call.
  changePlan: authed.billing.changePlan.handler(({ input, context: { tenant } }) =>
    svc.requestPlanChange(tenant, input.plan),
  ),
  checkout: authed.billing.checkout.handler(({ input, context: { tenant } }) =>
    svc.checkout(tenant, input),
  ),
  portal: authed.billing.portal.handler(({ context: { tenant } }) => svc.portal(tenant)),
});
