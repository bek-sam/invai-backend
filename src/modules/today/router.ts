import { contract } from "@invai/contracts";
import { authed, stubRouter } from "../../api/orpc";

/*
 * today routers. Every procedure starts as a NOT_IMPLEMENTED stub; replace entries as you
 * implement them (see src/modules/catalog/router.ts and src/modules/README.md).
 */

export const todayRouter = authed.today.router({
  ...stubRouter(authed.today, contract.today, ["today"]),
});

export const alertsRouter = authed.alerts.router({
  ...stubRouter(authed.alerts, contract.alerts, ["alerts"]),
});
