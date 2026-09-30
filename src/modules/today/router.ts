import { contract } from "@invai/contracts";
import { authed, stubRouter } from "../../api/orpc";
import { withTenant } from "../../db/client";
import { badRequest } from "../../lib/errors";
import { setChecklistDismissed } from "../tenancy/onboarding";
import * as svc from "./service";

export const todayRouter = authed.today.router({
  // NOT_IMPLEMENTED until T-A9 builds the daily action set (contract 0.10.0, T-A10).
  actions: stubRouter(authed.today.actions, contract.today.actions, ["today", "actions"]),
  recordActionClick: stubRouter(authed.today.recordActionClick, contract.today.recordActionClick, [
    "today",
    "recordActionClick",
  ]),
  summary: authed.today.summary.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.summary(tx, tenant, input)),
  ),
  dismissChecklist: authed.today.dismissChecklist.handler(({ input, context: { tenant } }) => {
    if (tenant.orgType !== "shop") throw badRequest("Only shops have a setup checklist");
    return withTenant(tenant.companyId, (tx) =>
      setChecklistDismissed(tx, tenant.companyId, input.dismissed),
    );
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
