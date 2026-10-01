import { z } from "zod";
import { systemContext } from "../../api/context";
import { withTenant } from "../../db/client";
import { imaging } from "../../integrations/imaging/client";
import { logger } from "../../lib/log";
import { defineJob, onEvent } from "../../lib/queues";
import { renderDesignPreviews, runDesignQa } from "./service";

const log = logger("catalog.jobs");

/*
 * Worked example of the job pattern:
 *  - `defineJob` declares queue, name, input schema, an idempotent jobId and the handler.
 *  - `onEvent` subscribes the job to an outbox event; the relay maps the event to job input.
 *  - The handler opens its own tenant transaction (jobs run outside a request).
 */

export const runDesignQaJob = defineJob({
  queue: "render",
  name: "catalog.runDesignQa",
  input: z.object({ companyId: z.uuid(), designId: z.uuid() }),
  jobId: (i) => `design-qa-${i.designId}`,
  handler: async ({ companyId, designId }) => {
    if (!(await imaging.isUp())) {
      log.warn("imaging down, leaving QA pending", { designId });
      return { skipped: true };
    }
    const ctx = systemContext(companyId);
    const design = await withTenant(companyId, (tx) => runDesignQa(tx, ctx, designId));
    return { qaStatus: design.qaStatus };
  },
});

onEvent("design.updated", runDesignQaJob, (e) =>
  e.payload.qaRequested ? { companyId: e.companyId, designId: String(e.payload.designId) } : null,
);

/**
 * Thumbnails for the design list and order-item artwork (B-209). Runs whenever placements were
 * attached or replaced (the same `qaRequested` signal as the QA job, since that's when the file
 * rows change); a metadata-only update (rename, tags) leaves existing previews alone.
 *
 * T-P2-2 (B-233): `renderDesignPreviews` manages its own short transactions (no transaction is
 * held across the `imaging.preview()` calls), so this handler no longer opens one of its own.
 */
export const renderDesignPreviewsJob = defineJob({
  queue: "render",
  name: "catalog.renderDesignPreviews",
  input: z.object({ companyId: z.uuid(), designId: z.uuid() }),
  jobId: (i) => `design-preview-${i.designId}`,
  handler: async ({ companyId, designId }) => {
    const started = Date.now();
    let imagingMs = 0;
    const ctx = systemContext(companyId);
    const design = await renderDesignPreviews(companyId, ctx, designId, {
      onImagingMs: (ms) => {
        imagingMs += ms;
      },
    });
    log.info("render design previews", {
      companyId,
      designId,
      durationMs: Date.now() - started,
      imagingMs,
    });
    return { placements: design.placements.length };
  },
});

onEvent("design.updated", renderDesignPreviewsJob, (e) =>
  e.payload.qaRequested ? { companyId: e.companyId, designId: String(e.payload.designId) } : null,
);
