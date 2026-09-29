import { contract } from "@invai/contracts";
import { authed, stubRouter } from "../../api/orpc";
import { withTenant } from "../../db/client";
import { sendSheetToVendor } from "../vendors/service";
import * as svc from "./service";

export const productionRouter = authed.production.router({
  batches: {
    preview: authed.production.batches.preview.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.previewBatch(tx, tenant, input)),
    ),
    build: authed.production.batches.build.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.buildBatch(tx, tenant, input)),
    ),
  },
  jobs: {
    get: authed.production.jobs.get.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.getJobRow(tx, input.id)),
    ),
  },
  sheets: {
    list: authed.production.sheets.list.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.listSheets(tx, tenant, input)),
    ),
    get: authed.production.sheets.get.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.getSheet(tx, tenant, input.id)),
    ),
    regenerate: authed.production.sheets.regenerate.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.regenerateSheet(tx, tenant, input.id)),
    ),
    sendToVendor: authed.production.sheets.sendToVendor.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => sendSheetToVendor(tx, tenant, input)),
    ),
    // In-house print path, ready -> printing -> printed (wave 6, T-6-2).
    markPrinting: authed.production.sheets.markPrinting.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.markSheetPrinting(tx, tenant, input.id)),
    ),
    markPrinted: authed.production.sheets.markPrinted.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.markSheetPrinted(tx, tenant, input.id)),
    ),
    markReceived: authed.production.sheets.markReceived.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.markSheetReceived(tx, tenant, input.id)),
    ),
    cancel: authed.production.sheets.cancel.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.cancelSheet(tx, tenant, input.id)),
    ),
    downloadUrls: authed.production.sheets.downloadUrls.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.downloadUrls(tx, tenant, input.id)),
    ),
    items: authed.production.sheets.items.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.sheetItems(tx, tenant, input.id)),
    ),
  },
  reprints: {
    list: authed.production.reprints.list.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.listReprints(tx, tenant, input)),
    ),
    request: authed.production.reprints.request.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.requestReprint(tx, tenant, input)),
    ),
    cancel: authed.production.reprints.cancel.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.cancelReprint(tx, tenant, input.id)),
    ),
    stats: authed.production.reprints.stats.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.reprintStats(tx, tenant, input)),
    ),
    // Count by reason and by week, for the reasons report chart (wave 6, T-6-2).
    reasonsByWeek: authed.production.reprints.reasonsByWeek.handler(
      ({ input, context: { tenant } }) =>
        withTenant(tenant.companyId, (tx) => svc.reprintReasonsByWeek(tx, tenant, input)),
    ),
  },
  bins: {
    list: authed.production.bins.list.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.listBins(tx, tenant, input)),
    ),
    // Bin CRUD + label rendering (wave 6, T-6-2).
    create: authed.production.bins.create.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.createBin(tx, tenant, input)),
    ),
    rename: authed.production.bins.rename.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.renameBin(tx, tenant, input)),
    ),
    archive: authed.production.bins.archive.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.archiveBin(tx, tenant, input)),
    ),
    labels: authed.production.bins.labels.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.binLabels(tx, tenant, input)),
    ),
    assign: authed.production.bins.assign.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.assignBin(tx, tenant, input)),
    ),
    release: authed.production.bins.release.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.releaseBin(tx, tenant, input)),
    ),
  },
  // T-22-1 day-1 stubs (NOT_IMPLEMENTED): T-22-4 (backend-engineer, production) fills them.
  maintenance: stubRouter(authed.production.maintenance, contract.production.maintenance, [
    "production",
    "maintenance",
  ]),
  queue: authed.production.queue.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.stationQueue(tx, tenant, input)),
  ),
  scan: authed.production.scan.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.scan(tx, tenant, input)),
  ),
  qc: authed.production.qc.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.qc(tx, tenant, input)),
  ),
  packOrder: authed.production.packOrder.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.packOrder(tx, tenant, input)),
  ),
  staffOutput: authed.production.staffOutput.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.staffOutput(tx, tenant, input)),
  ),
});
