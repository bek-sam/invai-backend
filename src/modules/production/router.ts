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
    // T-6-2 (wave 6 stub 3): in-house print path, ready -> printing -> printed.
    markPrinting: authed.production.sheets.markPrinting.handler(() => {
      throw notImplemented("production.sheets.markPrinting");
    }),
    markPrinted: authed.production.sheets.markPrinted.handler(() => {
      throw notImplemented("production.sheets.markPrinted");
    }),
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
    // T-6-2 (wave 6 stub 6): count by reason and by week, for the reasons report chart.
    reasonsByWeek: authed.production.reprints.reasonsByWeek.handler(() => {
      throw notImplemented("production.reprints.reasonsByWeek");
    }),
  },
  bins: {
    list: authed.production.bins.list.handler(({ input, context: { tenant } }) =>
      withTenant(tenant.companyId, (tx) => svc.listBins(tx, tenant, input)),
    ),
    // T-6-2 (wave 6 stub 4): bin CRUD + label rendering.
    create: authed.production.bins.create.handler(() => {
      throw notImplemented("production.bins.create");
    }),
    rename: authed.production.bins.rename.handler(() => {
      throw notImplemented("production.bins.rename");
    }),
    archive: authed.production.bins.archive.handler(() => {
      throw notImplemented("production.bins.archive");
    }),
    labels: authed.production.bins.labels.handler(() => {
      throw notImplemented("production.bins.labels");
    }),
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
  packOrder: authed.production.packOrder.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.packOrder(tx, tenant, input)),
  ),
  staffOutput: authed.production.staffOutput.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.staffOutput(tx, tenant, input)),
  ),
});
