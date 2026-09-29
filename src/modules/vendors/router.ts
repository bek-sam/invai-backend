import { contract } from "@invai/contracts";
import { authed, stubRouter } from "../../api/orpc";
import { withTenant } from "../../db/client";
import * as svc from "./service";

export const vendorsRouter = authed.vendors.router({
  list: authed.vendors.list.handler(({ context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.listConnections(tx, tenant)),
  ),
  get: authed.vendors.get.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.getConnection(tx, tenant, input.id)),
  ),
  // Not wrapped in withTenant: it runs its own short transactions around the email send.
  invite: authed.vendors.invite.handler(({ input, context: { tenant } }) =>
    svc.inviteVendor(tenant, input),
  ),
  update: authed.vendors.update.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.updateConnection(tx, tenant, input)),
  ),
  setDefault: authed.vendors.setDefault.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.setDefaultConnection(tx, tenant, input.id)),
  ),
  remove: authed.vendors.remove.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.removeConnection(tx, tenant, input.id)),
  ),
  // T-22-1 day-1 stub (NOT_IMPLEMENTED): T-22-5 (backend-engineer, vendors) fills it.
  sheets: stubRouter(authed.vendors.sheets, contract.vendors.sheets, ["vendors", "sheets"]),
});

/** Vendor org side. The service opens `withVendor()` (and the shop's tenant for status writes). */
export const vendorPortalRouter = authed.vendorPortal.router({
  inbox: authed.vendorPortal.inbox.handler(({ input, context: { tenant } }) =>
    svc.vendorInbox(tenant, input),
  ),
  get: authed.vendorPortal.get.handler(({ input, context: { tenant } }) =>
    svc.vendorSheet(tenant, input.id),
  ),
  downloadUrls: authed.vendorPortal.downloadUrls.handler(({ input, context: { tenant } }) =>
    svc.vendorDownloadUrls(tenant, input.id),
  ),
  acknowledge: authed.vendorPortal.acknowledge.handler(({ input, context: { tenant } }) =>
    svc.vendorUpdate(tenant, input.id, { kind: "acknowledge" }),
  ),
  markPrinted: authed.vendorPortal.markPrinted.handler(({ input, context: { tenant } }) =>
    svc.vendorUpdate(tenant, input.id, { kind: "printed" }),
  ),
  markShipped: authed.vendorPortal.markShipped.handler(({ input, context: { tenant } }) =>
    svc.vendorUpdate(tenant, input.id, {
      kind: "shipped",
      carrier: input.carrier,
      trackingCode: input.trackingCode,
      note: input.note,
    }),
  ),
  reject: authed.vendorPortal.reject.handler(({ input, context: { tenant } }) =>
    svc.vendorUpdate(tenant, input.id, { kind: "reject", reason: input.reason }),
  ),
  shops: authed.vendorPortal.shops.handler(({ context: { tenant } }) => svc.vendorShops(tenant)),
});
