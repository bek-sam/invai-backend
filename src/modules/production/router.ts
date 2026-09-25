import { authed } from "../../api/orpc";
import { withTenant } from "../../db/client";
import { notImplemented } from "../../lib/errors";
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
  },
  bins: {
    list: authed.production.bins.list.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.listBins(tx, tenant, input)),
    ),
    assign: authed.production.bins.assign.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.assignBin(tx, tenant, input)),
    ),
    release: authed.production.bins.release.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.releaseBin(tx, tenant, input)),
    ),
  },
  queue: authed.production.queue.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.stationQueue(tx, tenant, input)),
  ),
  scan: authed.production.scan.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.scan(tx, tenant, input)),
  ),
  // Each replayed scan commits on its own, so one bad scan can't undo the others.
  scanBatch: authed.production.scanBatch.handler(async ({ input, context: { tenant } }) => {
    const results = [];
    for (const s of input.scans)
      results.push(await withTenant(tenant.companyId, (tx) => svc.scan(tx, tenant, s)));
    return { results };
  }),
  qc: authed.production.qc.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.qc(tx, tenant, input)),
  ),
  // T-4-1 fills this in; the stub keeps the router typechecking against the new contract procedure.
  packOrder: authed.production.packOrder.handler(() => {
    throw notImplemented("production.packOrder");
  }),
  staffOutput: authed.production.staffOutput.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.staffOutput(tx, tenant, input)),
  ),
});
