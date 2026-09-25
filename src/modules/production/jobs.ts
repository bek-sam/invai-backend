import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { withTenant } from "../../db/client";
import { gangSheetBatches, gangSheets, jobs } from "../../db/schema";
import { imaging } from "../../integrations/imaging/client";
import { logger } from "../../lib/log";
import { defineJob, isFinalAttempt, onEvent, RETRY_BACKOFF } from "../../lib/queues";
import { updateJobRow } from "./job-rows";
import {
  lockSheet,
  runBuildSheets,
  runRegenerateSheet,
  scrapTransfers,
  transitionSheet,
} from "./service";

const log = logger("production.jobs");

/*
 * Build and regenerate retry with backoff (B-100). Imaging failures inside a run are recorded on
 * the sheet and don't throw; what throws is a crash (DB, network) or imaging being down at start,
 * and those retry. A retry of a run that already finished (job row done/failed, batch or sheet
 * no longer `building`) does nothing. Only the last attempt marks the job row failed.
 */
const RENDER_RETRY = { attempts: 4, backoff: RETRY_BACKOFF };

async function imagingReady() {
  if (!(await imaging.isUp())) throw new Error("imaging is not reachable; retrying");
}

async function jobFinished(companyId: string, jobId: string) {
  const [row] = await withTenant(companyId, (tx) =>
    tx.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, jobId)).limit(1),
  );
  return !row || row.status === "done" || row.status === "failed";
}

async function onRunError(
  err: unknown,
  final: boolean,
  companyId: string,
  jobId: string,
  what: string,
  context: Record<string, unknown>,
) {
  const error = err instanceof Error ? err.message : String(err);
  if (final) {
    log.error(`${what} failed`, { companyId, ...context, error });
    await updateJobRow(companyId, jobId, { status: "failed", progress: 1, error });
  } else {
    log.warn(`${what} failed, will retry`, { companyId, ...context, error });
    await updateJobRow(companyId, jobId, { message: `Retrying after an error: ${error}` });
  }
}

/** Nest + compose a batch into gang sheets (render queue: imaging is memory heavy). */
export const buildSheetsJob = defineJob({
  queue: "render",
  name: "production.buildSheets",
  input: z.object({ companyId: z.uuid(), batchId: z.uuid(), jobId: z.uuid() }),
  jobId: (i) => `build-sheets-${i.batchId}`,
  options: RENDER_RETRY,
  // BullMQ gave up outside the handler (stalled too often): the batch must not stay building.
  onFinalFailure: ({ companyId, batchId }, error) =>
    withTenant(companyId, async (tx) => {
      await tx
        .update(gangSheetBatches)
        .set({ status: "failed", error })
        .where(and(eq(gangSheetBatches.id, batchId), eq(gangSheetBatches.status, "building")));
    }),
  handler: async ({ companyId, batchId, jobId }, job) => {
    const [batch] = await withTenant(companyId, (tx) =>
      tx
        .select({ status: gangSheetBatches.status })
        .from(gangSheetBatches)
        .where(eq(gangSheetBatches.id, batchId))
        .limit(1),
    );
    if (batch?.status !== "building" || (await jobFinished(companyId, jobId)))
      return { skipped: true };
    try {
      await imagingReady();
      return await runBuildSheets(companyId, batchId, jobId);
    } catch (err) {
      const final = isFinalAttempt(job);
      await onRunError(err, final, companyId, jobId, "build sheets", { batchId });
      if (final)
        await withTenant(companyId, (tx) =>
          tx
            .update(gangSheetBatches)
            .set({ status: "failed", error: err instanceof Error ? err.message : String(err) })
            .where(eq(gangSheetBatches.id, batchId)),
        );
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
  options: RENDER_RETRY,
  onFinalFailure: ({ companyId, sheetId }, error) =>
    withTenant(companyId, async (tx) => {
      const cur = await lockSheet(tx, sheetId);
      if (cur.status === "building")
        await transitionSheet(tx, companyId, { kind: "system" }, cur, "failed", { error });
    }),
  handler: async ({ companyId, sheetId, jobId }, job) => {
    const [sheet] = await withTenant(companyId, (tx) =>
      tx
        .select({ status: gangSheets.status })
        .from(gangSheets)
        .where(eq(gangSheets.id, sheetId))
        .limit(1),
    );
    if (sheet?.status !== "building" || (await jobFinished(companyId, jobId)))
      return { skipped: true };
    try {
      await imagingReady();
      await runRegenerateSheet(companyId, sheetId, jobId);
    } catch (err) {
      await onRunError(err, isFinalAttempt(job), companyId, jobId, "regenerate sheet", {
        sheetId,
      });
      throw err;
    }
  },
});

onEvent("sheet.regenerate_requested", regenerateSheetJob, (e) => ({
  companyId: e.companyId,
  sheetId: String(e.payload.sheetId),
  jobId: String(e.payload.jobId),
}));

/** Content hash of the transfer set, so two partial cancels of one order get distinct job ids. */
export function transferSetHash(transferIds: string[]) {
  return createHash("sha256")
    .update([...transferIds].sort().join(","))
    .digest("hex")
    .slice(0, 16);
}

/** A cancelled item whose transfer was already nested: scrap the transfer, free the sheet slot. */
export const scrapCancelledJob = defineJob({
  queue: "sync",
  name: "production.scrapCancelled",
  input: z.object({ companyId: z.uuid(), orderId: z.uuid(), transferIds: z.array(z.uuid()) }),
  jobId: (i) => `scrap-cancelled-${i.orderId}-${transferSetHash(i.transferIds)}`,
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
