import { authed } from "../../api/orpc";
import { withTenant } from "../../db/client";
import { notImplemented } from "../../lib/errors";
import * as svc from "./service";

export const todayRouter = authed.today.router({
  summary: authed.today.summary.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.summary(tx, tenant, input)),
  ),
  // TODO(backend-foundation, T-5-3): implement per wave 5's contract-stub section 2
  // (extract `onboarding()` from modules/tenancy/service.ts, add dismissed/dismissedAt to
  // company_settings).
  dismissChecklist: authed.today.dismissChecklist.handler(() => {
    throw notImplemented("today.dismissChecklist");
  }),
});

export const alertsRouter = authed.alerts.router({
  list: authed.alerts.list.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.listAlerts(tx, tenant, input)),
  ),
  markRead: authed.alerts.markRead.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.markRead(tx, tenant, input.ids)),
  ),
  markAllRead: authed.alerts.markAllRead.handler(({ context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.markAllRead(tx, tenant)),
  ),
});
