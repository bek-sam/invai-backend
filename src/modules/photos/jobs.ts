import { z } from "zod";
import { BULK_PRIORITY } from "../../lib/fairness";
import { logger } from "../../lib/log";
import { defineJob, isFinalAttempt, onEvent, RETRY_BACKOFF } from "../../lib/queues";
import {
  failComposition,
  openCompositions,
  renderComposition,
  runAnalysis,
  runZip,
  setPhotoEnqueuers,
} from "./service";

const log = logger("photos.jobs");

/*
 * Listing photo jobs (T-26-4, ADR 0023 §6). Every job is safe to run twice: the analysis and zip
 * rows carry the id of the run that owns them (a superseded run skips), and a composition's
 * render charges only while `charged_at` is null under a row lock.
 */

/** Design analysis on the `ai` queue: imaging palette, then the AI route; no tx across either. */
export const analyzeDesignJob = defineJob({
  queue: "ai",
  name: "photos.analyzeDesign",
  input: z.object({
    companyId: z.uuid(),
    designId: z.uuid(),
    jobId: z.uuid(),
    userId: z.uuid().nullable(),
  }),
  jobId: (i) => `photo-analysis-${i.jobId}`,
  options: { attempts: 3, backoff: RETRY_BACKOFF },
  handler: (input, job) => runAnalysis(input, isFinalAttempt(job)),
});

/**
 * One render job per composition (plan review item 9). Photos are bulk work next to gang-sheet
 * compose on the same `render` queue, so they carry an explicit (lower) priority: BullMQ runs
 * the default priority 0 (sheet builds) before any prioritized job.
 */
export const renderCompositionJob = defineJob({
  queue: "render",
  name: "photos.renderComposition",
  input: z.object({ companyId: z.uuid(), compositionId: z.uuid() }),
  jobId: (i) => `photo-render-${i.compositionId}`,
  options: { attempts: 4, backoff: RETRY_BACKOFF, priority: BULK_PRIORITY },
  handler: (input, job) =>
    renderComposition(input.companyId, input.compositionId, isFinalAttempt(job)),
  onFinalFailure: (input) =>
    failComposition(input.companyId, input.compositionId, "Rendering stopped after several tries."),
});

/** Fans a new set out into its render jobs; re-running enqueues only what is still open. */
export const dispatchSetJob = defineJob({
  queue: "render",
  name: "photos.dispatchSet",
  input: z.object({ companyId: z.uuid(), setId: z.uuid() }),
  jobId: (i) => `photo-dispatch-${i.setId}`,
  handler: async ({ companyId, setId }) => {
    const ids = await openCompositions(companyId, setId);
    for (const compositionId of ids)
      await renderCompositionJob.enqueue({ companyId, compositionId });
    log.info("photo set dispatched", { companyId, setId, compositions: ids.length });
    return { enqueued: ids.length };
  },
});

onEvent("photo_set.created", dispatchSetJob, (e) => ({
  companyId: e.companyId,
  setId: String(e.payload.setId),
}));

export const buildZipJob = defineJob({
  queue: "render",
  name: "photos.buildZip",
  input: z.object({ companyId: z.uuid(), setId: z.uuid(), zipJobId: z.uuid() }),
  jobId: (i) => `photo-zip-${i.zipJobId}`,
  options: { attempts: 3, backoff: RETRY_BACKOFF, priority: BULK_PRIORITY },
  handler: (input, job) => runZip(input, isFinalAttempt(job)),
});

setPhotoEnqueuers({
  analysis: async (input) => {
    await analyzeDesignJob.enqueue(input);
  },
  zip: async (input) => {
    await buildZipJob.enqueue(input);
  },
});
