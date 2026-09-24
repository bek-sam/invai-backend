import { authed } from "../../api/orpc";
import { afterCommit, withTenant } from "../../db/client";
import { pushTrackingJob } from "./jobs";
import * as svc from "./service";

export const shippingRouter = authed.shipping.router({
  shipments: {
    list: authed.shipping.shipments.list.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.listShipments(tx, tenant, input)),
    ),
    get: authed.shipping.shipments.get.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.getShipment(tx, tenant, input.id)),
    ),
  },
  settings: {
    get: authed.shipping.settings.get.handler(({ context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.getSettings(tx, tenant)),
    ),
    update: authed.shipping.settings.update.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.updateSettings(tx, tenant, input)),
    ),
  },
  trackingPush: {
    list: authed.shipping.trackingPush.list.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.listTrackingPush(tx, tenant, input)),
    ),
    retry: authed.shipping.trackingPush.retry.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, async (tx) => {
        const status = await svc.resetTrackingPush(tx, tenant, input.shipmentId);
        if (status.status === "pending") {
          afterCommit(tx, async () => {
            await pushTrackingJob.enqueue({
              companyId: tenant.companyId,
              shipmentId: input.shipmentId,
              attempt: Date.now(),
            });
          });
        }
        return status;
      }),
    ),
  },
  queue: authed.shipping.queue.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.shipQueue(tx, tenant, input)),
  ),
  rates: authed.shipping.rates.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.rateOrder(tx, tenant, input)),
  ),
  buy: authed.shipping.buy.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.buyLabel(tx, tenant, input)),
  ),
  batchBuy: authed.shipping.batchBuy.handler(({ input, context: { tenant } }) =>
    svc.batchBuy(tenant, input),
  ),
  batchLabelPdf: authed.shipping.batchLabelPdf.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.batchLabelPdf(tx, tenant, input)),
  ),
  void: authed.shipping.void.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.voidShipment(tx, tenant, input)),
  ),
});
