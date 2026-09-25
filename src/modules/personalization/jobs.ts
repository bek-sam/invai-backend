import { z } from "zod";
import { systemContext } from "../../api/context";
import { logger } from "../../lib/log";
import { defineJob, isFinalAttempt, onEvent, RETRY_BACKOFF } from "../../lib/queues";
import { renderPendingItem } from "./service";

const log = logger("personalization.jobs");

/**
 * Renders the personalized artwork queued by a mapping (import, SKU rule, manual map) after
 * that transaction committed (B-61): never inside the import. The guard is the artwork row's
 * `pending` status, so a re-run or a duplicate event renders nothing twice. A transient imaging
 * failure retries the job (3 attempts, exponential backoff with jitter); items already done are
 * skipped on the retry. On the last attempt a failure is saved: `artwork_qa_failed` with the
 * reason, and the unit moves to `needs_artwork`.
 */
export const renderArtworkJob = defineJob({
  queue: "render",
  name: "personalization.renderArtwork",
  input: z.object({ companyId: z.uuid(), orderItemIds: z.array(z.uuid()).min(1) }),
  options: { attempts: 3, backoff: RETRY_BACKOFF },
  handler: async ({ companyId, orderItemIds }, job) => {
    const ctx = systemContext(companyId);
    const final = isFinalAttempt(job);
    const counts: Record<string, number> = {};
    for (const id of orderItemIds) {
      const res = await renderPendingItem(ctx, id, final);
      counts[res] = (counts[res] ?? 0) + 1;
    }
    if (counts.retry) {
      log.warn("personalization renders failed, will retry", { companyId, ...counts });
      throw new Error(`${counts.retry} personalization render(s) failed; retrying`);
    }
    return counts;
  },
});

onEvent("artwork.render_requested", renderArtworkJob, (e) => {
  const ids = (e.payload.orderItemIds as string[] | undefined) ?? [];
  return ids.length ? { companyId: e.companyId, orderItemIds: ids } : null;
});
