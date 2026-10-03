import { z } from "zod";
import { BULK_PRIORITY } from "../../lib/fairness";
import { logger } from "../../lib/log";
import { defineJob, isFinalAttempt, onEvent, RETRY_BACKOFF } from "../../lib/queues";
import { failPush, runPush } from "./push";
import { renderScene } from "./scenes";
import {
  failComposition,
  openCompositionsBySource,
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
    const open = await openCompositionsBySource(companyId, setId);
    for (const c of open) {
      if (c.source === "ai_scene") await renderSceneJob.enqueue({ companyId, compositionId: c.id });
      else await renderCompositionJob.enqueue({ companyId, compositionId: c.id });
    }
    const scenes = open.filter((c) => c.source === "ai_scene").length;
    log.info("photo set dispatched", { companyId, setId, compositions: open.length, scenes });
    return { enqueued: open.length, scenes };
  },
});

/**
 * One AI scene (phase B): imaging base, provider scene, composite per channel, charge once. On
 * the `ai` queue (bulk priority): most of its time is the provider call (up to 120 s,
 * IMAGE_TIMEOUT_MS), which is async, so BullMQ keeps renewing the lock (every lockDuration/2)
 * and the job never stalls on it. A stalled re-run after a dead worker reuses the stored scene;
 * only a call cut off mid-flight can be paid twice.
 */
export const renderSceneJob = defineJob({
  queue: "ai",
  name: "photos.renderScene",
  input: z.object({ companyId: z.uuid(), compositionId: z.uuid() }),
  jobId: (i) => `photo-scene-${i.compositionId}`,
  options: { attempts: 3, backoff: RETRY_BACKOFF, priority: BULK_PRIORITY },
  handler: (input, job) => renderScene(input.companyId, input.compositionId, isFinalAttempt(job)),
  onFinalFailure: (input) =>
    failComposition(input.companyId, input.compositionId, "The scene stopped after several tries."),
});

/** Sends approved photos to one Shopify product; the `photo_pushes` row's status guards reruns. */
export const pushImagesJob = defineJob({
  queue: "sync",
  name: "photos.pushToShopify",
  input: z.object({ companyId: z.uuid(), pushId: z.uuid() }),
  jobId: (i) => `photo-push-${i.pushId}`,
  options: { attempts: 4, backoff: RETRY_BACKOFF },
  handler: (input, job) => runPush(input, isFinalAttempt(job)),
  onFinalFailure: (input) => failPush(input, "Shopify did not answer. Try the push again."),
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
  push: async (input) => {
    await pushImagesJob.enqueue(input);
  },
});
