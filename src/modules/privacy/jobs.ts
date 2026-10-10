import { z } from "zod";
import { env } from "../../env";
import { errorData, logger } from "../../lib/log";
import { defineJob, queues, safeJobId } from "../../lib/queues";
import { expireAllTenantExports } from "./export-retention";
import { reportSheetsWaitingOverCap } from "./print-files";
import {
  HARD_PURGE_DELAY_MS,
  hardPurgeCompany,
  overduePurges,
  purgeOldFloorRequests,
  redactStaleBuyerPii,
  runTenantExport,
  sweepStaleAmazonData,
} from "./service";

const log = logger("privacy.jobs");

/**
 * One company's full data export (privacy.exportTrigger). The `jobs` row is the user-visible
 * state; the worker marks it failed when BullMQ gives up (the input carries `jobId`).
 */
export const tenantExportJob = defineJob({
  queue: "reports",
  name: "privacy.tenantExport",
  input: z.object({ companyId: z.uuid(), jobId: z.uuid() }),
  jobId: (i) => `tenant-export:${i.jobId}`,
  options: { attempts: 3 },
  handler: async ({ companyId, jobId }) => runTenantExport(companyId, jobId),
});

/**
 * The hard purge, delayed 30 days after the deletion request (jobId `hard-purge:{companyId}`).
 * A cancelled or not-yet-due request makes it a no-op, so a stale copy firing is harmless.
 */
export const tenantHardPurgeJob = defineJob({
  queue: "reports",
  name: "privacy.tenantHardPurge",
  input: z.object({ companyId: z.uuid() }),
  jobId: (i) => `hard-purge:${i.companyId}`,
  handler: async ({ companyId }) => hardPurgeCompany(companyId),
});

const hardPurgeJobId = (companyId: string) => safeJobId(`hard-purge:${companyId}`);

/** Drop any earlier copy of the purge job (a cancelled request's), so a new one can be added. */
export async function unscheduleHardPurge(companyId: string) {
  const job = await queues.reports.getJob(hardPurgeJobId(companyId));
  if (!job) return false;
  try {
    await job.remove();
    return true;
  } catch (err) {
    // Already running (locked): it re-checks the company and no-ops when cancelled.
    log.warn("could not remove the hard-purge job", { companyId, ...errorData(err) });
    return false;
  }
}

export async function scheduleHardPurge(companyId: string, delayMs = HARD_PURGE_DELAY_MS) {
  await unscheduleHardPurge(companyId);
  await tenantHardPurgeJob.enqueue({ companyId }, { delay: Math.max(0, delayMs) });
}

/**
 * Daily: buyer PII past 18 months, then non-PII Amazon data past 18 months (decision 0026),
 * `floor_requests` past 30 days, export zips past 7 days and a report of sheets waiting past
 * 14 days with a purged unit (decision 0033), and any due purge whose delayed
 * job was lost (enqueued again under the same id, so never twice).
 */
export const privacyRetentionSweepJob = defineJob({
  queue: "reports",
  name: "privacy.retentionSweep",
  input: z.object({}).passthrough(),
  options: { attempts: 3 },
  handler: async () => {
    const buyerPii = await redactStaleBuyerPii();
    // After the PII redaction (decision 0026): same 18-month cutoff, non-PII Amazon data.
    const amazon = await sweepStaleAmazonData();
    const floorRequests = await purgeOldFloorRequests();
    const exports = await expireAllTenantExports();
    const waiting = await reportSheetsWaitingOverCap();
    const due = await overduePurges();
    for (const companyId of due) await tenantHardPurgeJob.enqueue({ companyId });
    return {
      buyerPii,
      amazon,
      floorRequests,
      overduePurges: due.length,
      exportsDeleted: exports.exportsDeleted,
      exportsFailed: exports.exportsFailed,
      sheetsWaitingOverCap: waiting.sheetsWaitingOverCap,
      failedCompanies: exports.failedCompanies + waiting.failedCompanies,
    };
  },
});

/** Idempotent: registers the daily privacy retention sweep. */
export async function schedulePrivacyJobs() {
  await queues.reports.upsertJobScheduler(
    "privacy-retention-sweep",
    { pattern: "15 5 * * *", tz: "UTC" },
    { name: privacyRetentionSweepJob.name, data: {} },
  );
}

if (!env.isTest) {
  schedulePrivacyJobs().catch((err) =>
    log.warn("could not register the privacy retention scheduler", errorData(err)),
  );
}
