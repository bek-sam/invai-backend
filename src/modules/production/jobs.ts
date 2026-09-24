import { z } from "zod";
import { logger } from "../../lib/log";
import { defineJob, onEvent } from "../../lib/queues";
import { updateJobRow } from "./job-rows";
import { runBuildSheets, runRegenerateSheet } from "./service";

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
