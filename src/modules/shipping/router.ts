import { contract } from "@invai/contracts";
import { authed, stubRouter } from "../../api/orpc";
import { afterCommit, withTenant } from "../../db/client";
import { startBatchBuy } from "./batch";
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
  // T-22-1 day-1 stubs (NOT_IMPLEMENTED): T-22-3 (integrations-engineer, by grant) fills them.
  scanForms: stubRouter(authed.shipping.scanForms, contract.shipping.scanForms, [
    "shipping",
    "scanForms",
  ]),
  verifyAddress: stubRouter(authed.shipping.verifyAddress, contract.shipping.verifyAddress, [
    "shipping",
    "verifyAddress",
  ]),
  queue: authed.shipping.queue.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.shipQueue(tx, tenant, input)),
  ),
  // Rate and buy open their own short transactions around the carrier call (R8).
  rates: authed.shipping.rates.handler(({ input, context: { tenant } }) =>
    svc.rateOrder(tenant, input),
  ),
  buy: authed.shipping.buy.handler(({ input, context: { tenant } }) => svc.buyLabel(tenant, input)),
  // Always a job (B-61): answers `queued` with the job id; progress via production.jobs.get.
  batchBuy: authed.shipping.batchBuy.handler(({ input, context: { tenant } }) =>
    startBatchBuy(tenant, input),
  ),
  batchLabelPdf: authed.shipping.batchLabelPdf.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.batchLabelPdf(tx, tenant, input)),
  ),
  void: authed.shipping.void.handler(({ input, context: { tenant } }) =>
    svc.voidShipment(tenant, input),
  ),
  // T-7-1 (wave 7 stub 1): CSV tracking export for pendingApproval-adapter channels.
  exportTracking: authed.shipping.exportTracking.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.exportTracking(tx, tenant, input)),
  ),
});
