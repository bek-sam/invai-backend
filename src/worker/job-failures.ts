import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { withTenant } from "../db/client";
import { jobs } from "../db/schema";
import { errorData, logger } from "../lib/log";
import type { DefinedJob } from "../lib/queues";
import { publish } from "../lib/realtime";

const log = logger("worker.failures");

/** The ids a job's data may carry that point at a user-visible `jobs` row. */
const JobRowRef = z.object({
  companyId: z.uuid(),
  jobId: z.uuid().nullish(),
  importRunId: z.uuid().nullish(),
});

type FailedJob = {
  name: string;
  id?: string | undefined;
  data: unknown;
  finishedOn?: number | undefined;
  attemptsMade?: number;
};

/**
 * A job BullMQ failed for good (`finishedOn` is set only then; a failure that will be retried
 * leaves it empty). Handlers mark their rows on their own last attempt, but a job that stalled
 * too often or had bad input never reaches the handler, and its row would stay `running`
 * forever. This marks the `jobs` row failed (only while it is still queued or running) and
 * runs the job's `onFinalFailure` hook for the module's own entity.
 */
export async function onJobFailed(
  def: DefinedJob<unknown> | undefined,
  job: FailedJob | undefined,
  err: Error,
) {
  if (!job?.finishedOn) return;
  const ref = JobRowRef.safeParse(job.data);
  if (!ref.success) return;
  const { companyId } = ref.data;
  const rowId = ref.data.jobId ?? ref.data.importRunId ?? null;
  // S-68: `jobs.error` reaches the shop's staff through `Job.error`; store it scrubbed.
  const error = String(errorData(err).error) || String(err);
  try {
    if (rowId) {
      const [row] = await withTenant(companyId, (tx) =>
        tx
          .update(jobs)
          .set({ status: "failed", progress: 1, error, finishedAt: new Date() })
          .where(and(eq(jobs.id, rowId), inArray(jobs.status, ["queued", "running"])))
          .returning(),
      );
      if (row) {
        log.warn("job row marked failed after the queue gave up", {
          companyId,
          job: job.name,
          jobRowId: row.id,
          error,
        });
        await publish(companyId, "job.progress", {
          jobId: row.id,
          kind: row.kind,
          status: row.status,
          progress: row.progress,
          message: row.message,
          resultIds: row.resultIds,
        });
      }
    }
    if (def?.onFinalFailure) {
      const input = def.input.safeParse(job.data);
      if (input.success) await def.onFinalFailure(input.data, error);
    }
  } catch (e) {
    log.error("could not record a failed job", { companyId, job: job.name, ...errorData(e) });
  }
}
