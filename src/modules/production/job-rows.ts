import type { Job } from "@invai/contracts";
import { eq } from "drizzle-orm";
import type { TenantContext } from "../../api/context";
import { afterCommit, type Tx, withTenant } from "../../db/client";
import { type JOB_KINDS, jobs } from "../../db/schema";
import { notFound } from "../../lib/errors";
import { publish } from "../../lib/realtime";

/*
 * User-visible job rows (contracts `Job`): created in the request transaction, advanced by the
 * worker, every change pushed as realtime `job.progress`.
 */

export type JobKind = (typeof JOB_KINDS)[number];
type JobRow = typeof jobs.$inferSelect;

export function toJob(row: JobRow): Job {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    progress: Math.min(1, Math.max(0, row.progress)),
    message: row.message,
    resultIds: row.resultIds,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

function publishProgress(companyId: string, row: JobRow) {
  return publish(companyId, {
    type: "job.progress",
    data: {
      jobId: row.id,
      kind: row.kind,
      status: row.status,
      progress: Math.min(1, Math.max(0, row.progress)),
      message: row.message,
      resultIds: row.resultIds,
    },
  });
}

export async function createJobRow(
  tx: Tx,
  ctx: TenantContext,
  kind: JobKind,
  input: Record<string, unknown>,
): Promise<JobRow> {
  const [row] = await tx
    .insert(jobs)
    .values({ companyId: ctx.companyId, kind, input, createdBy: ctx.userId })
    .returning();
  if (!row) throw new Error("job insert failed");
  afterCommit(tx, () => publishProgress(ctx.companyId, row).then(() => undefined));
  return row;
}

export type JobPatch = Partial<
  Pick<JobRow, "status" | "progress" | "message" | "resultIds" | "error">
>;

/** Update a job row in its own transaction (worker side) and publish the progress. */
export async function updateJobRow(companyId: string, jobId: string, patch: JobPatch) {
  const done = patch.status === "done" || patch.status === "failed";
  const row = await withTenant(companyId, async (tx) => {
    const [r] = await tx
      .update(jobs)
      .set({ ...patch, finishedAt: done ? new Date() : undefined })
      .where(eq(jobs.id, jobId))
      .returning();
    return r;
  });
  if (row) await publishProgress(companyId, row);
  return row;
}

export async function getJobRow(tx: Tx, id: string): Promise<Job> {
  const [row] = await tx.select().from(jobs).where(eq(jobs.id, id)).limit(1);
  if (!row) throw notFound("job", id);
  return toJob(row);
}
