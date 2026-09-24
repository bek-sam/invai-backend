import { z } from "zod";
import { withTenant } from "../../db/client";
import { logger } from "../../lib/log";
import { defineJob, onEvent } from "../../lib/queues";
import { updateJobRow } from "./job-rows";
import { runBuildSheets, runRegenerateSheet, scrapTransfers } from "./service";

const log = logger("production.jobs");

/** Nest + compose a batch into gang sheets (render queue: imaging is memory heavy). */
export const buildSheetsJob = defineJob({
  queue: "render",
  name: "production.buildSheets",
  input: z.object({ companyId: z.uuid(), batchId: z.uuid(), jobId: z.uuid() }),
  jobId: (i) => `build-sheets-${i.batchId}`,
  options: { attempts: 1 },
  handler: async ({ companyId, batchId, jobId }) => {
    try {
      return await runBuildSheets(companyId, batchId, jobId);
    } catch (err) {
      log.error("build sheets crashed", { batchId, error: String(err) });
      await updateJobRow(companyId, jobId, { status: "failed", progress: 1, error: String(err) });
      throw err;
    }
  },
});

onEvent("batch.requested", buildSheetsJob, (e) => ({
  companyId: e.companyId,
  batchId: String(e.payload.batchId),
  jobId: String(e.payload.jobId),
}));

export const regenerateSheetJob = defineJob({
  queue: "render",
  name: "production.regenerateSheet",
  input: z.object({ companyId: z.uuid(), sheetId: z.uuid(), jobId: z.uuid() }),
  jobId: (i) => `regenerate-sheet-${i.jobId}`,
  options: { attempts: 1 },
  handler: async ({ companyId, sheetId, jobId }) => {
    try {
      await runRegenerateSheet(companyId, sheetId, jobId);
    } catch (err) {
      await updateJobRow(companyId, jobId, { status: "failed", progress: 1, error: String(err) });
      throw err;
    }
  },
});

onEvent("sheet.regenerate_requested", regenerateSheetJob, (e) => ({
  companyId: e.companyId,
  sheetId: String(e.payload.sheetId),
  jobId: String(e.payload.jobId),
}));

/** A cancelled item whose transfer was already nested: scrap the transfer, free the sheet slot. */
export const scrapCancelledJob = defineJob({
  queue: "sync",
  name: "production.scrapCancelled",
  input: z.object({ companyId: z.uuid(), orderId: z.uuid(), transferIds: z.array(z.uuid()) }),
  jobId: (i) => `scrap-cancelled-${i.orderId}-${i.transferIds.length}`,
  handler: async ({ companyId, transferIds }) => {
    await withTenant(companyId, (tx) => scrapTransfers(tx, transferIds));
  },
});

onEvent("order.cancelled", scrapCancelledJob, (e) => {
  const transferIds = (e.payload.scrappedTransferIds as string[] | undefined) ?? [];
  return transferIds.length
    ? { companyId: e.companyId, orderId: String(e.payload.orderId), transferIds }
    : null;
});
