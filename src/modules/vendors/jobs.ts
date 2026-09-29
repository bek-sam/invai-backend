import { z } from "zod";
import { defineJob, onEvent, permanentFailure } from "../../lib/queues";
import { deliverPendingSheet, RESEND_EVENT } from "./delivery";

/*
 * Vendor sheet delivery after the sending transaction commits (B-102, T-22-5). Both the first
 * send (contract event `sheet.sent`) and a resend (internal `vendor.sheet_resend_requested`)
 * run the same handler, which delivers the sheet's newest pending `vendor_sheet_deliveries`
 * row. The row's state guard, not the jobId, makes a retry or a re-relayed event send nothing.
 */
export const deliverSheetJob = defineJob({
  queue: "ship",
  name: "vendors.deliverSheet",
  input: z.object({ companyId: z.uuid(), sheetId: z.uuid() }),
  jobId: (i) => `vendor-sheet-delivery-${i.sheetId}`,
  options: { attempts: 5, backoff: { type: "exponential", delay: 10_000 } },
  handler: async ({ companyId, sheetId }, job) => {
    const lastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    try {
      return await deliverPendingSheet(companyId, sheetId, { lastAttempt });
    } catch (err) {
      if ((err as { permanent?: boolean }).permanent) permanentFailure(String(err));
      throw err;
    }
  },
});

onEvent("sheet.sent", deliverSheetJob, (e) => ({
  companyId: e.companyId,
  sheetId: String(e.payload.sheetId),
}));
onEvent(RESEND_EVENT, deliverSheetJob, (e) => ({
  companyId: e.companyId,
  sheetId: String(e.payload.sheetId),
}));
