import { authed } from "../../api/orpc";
import { withTenant } from "../../db/client";
import { mapItemManually } from "./mapping";
import * as svc from "./service";

/* Orders and order items: one line each; the service does the work inside the tenant tx. */

export const ordersRouter = authed.orders.router({
  list: authed.orders.list.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.listOrders(tx, tenant, input)),
  ),
  get: authed.orders.get.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.getOrder(tx, tenant, input.id)),
  ),
  timeline: authed.orders.timeline.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.timeline(tx, tenant, input)),
  ),
  hold: authed.orders.hold.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.holdOrder(tx, tenant, input)),
  ),
  release: authed.orders.release.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.releaseOrder(tx, tenant, input.id)),
  ),
  cancel: authed.orders.cancel.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.cancelOrder(tx, tenant, input)),
  ),
  addNote: authed.orders.addNote.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.addNote(tx, tenant, input)),
  ),
  setTags: authed.orders.setTags.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.setTags(tx, tenant, input)),
  ),
  counts: authed.orders.counts.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.countOrders(tx, tenant, input)),
  ),
  channelPerformance: authed.orders.channelPerformance.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.channelPerformance(tx, tenant, input)),
  ),
  updateAddress: authed.orders.updateAddress.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.updateAddress(tx, tenant, input)),
  ),
});

export const orderItemsRouter = authed.orderItems.router({
  list: authed.orderItems.list.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.listItems(tx, tenant, input)),
  ),
  get: authed.orderItems.get.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.getItem(tx, tenant, input.id)),
  ),
  map: authed.orderItems.map.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => mapItemManually(tx, tenant, input)),
  ),
  setArtwork: authed.orderItems.setArtwork.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.setItemArtwork(tx, tenant, input)),
  ),
  setFlag: authed.orderItems.setFlag.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.setItemFlag(tx, tenant, input)),
  ),
  setRush: authed.orderItems.setRush.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.setItemRush(tx, tenant, input)),
  ),
});
