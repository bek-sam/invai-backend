import { authed } from "../../api/orpc";
import { withTenant } from "../../db/client";
import { errorData, logger } from "../../lib/log";
import { scheduleHardPurge, tenantExportJob, unscheduleHardPurge } from "./jobs";
import * as svc from "./service";

const log = logger("privacy.router");

/**
 * Whole-company export and deletion (owner only). Queue side effects run after the transaction
 * commits: the row is the truth, the job only acts on it.
 */
export const privacyRouter = authed.privacy.router({
  exportTrigger: authed.privacy.exportTrigger.handler(async ({ context: { tenant } }) => {
    const job = await withTenant(tenant.companyId, (tx) => svc.requestExport(tx, tenant));
    try {
      await tenantExportJob.enqueue({ companyId: tenant.companyId, jobId: job.id });
    } catch (err) {
      // Don't leave a queued row behind: it would block the next export as "in progress".
      await svc.failExport(tenant.companyId, job.id, "could not queue the export");
      throw err;
    }
    return job;
  }),
  exportStatus: authed.privacy.exportStatus.handler(({ input, context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.exportStatus(tx, input.jobId)),
  ),
  deleteRequest: authed.privacy.deleteRequest.handler(async ({ context: { tenant } }) => {
    const out = await withTenant(tenant.companyId, (tx) => svc.requestDeletion(tx, tenant));
    // If this fails the daily retention sweep enqueues the purge once it is due.
    await scheduleHardPurge(
      tenant.companyId,
      new Date(out.scheduledPurgeAt).getTime() - Date.now(),
    ).catch((err) =>
      log.error("could not schedule the hard purge", {
        companyId: tenant.companyId,
        ...errorData(err),
      }),
    );
    return out;
  }),
  deleteCancel: authed.privacy.deleteCancel.handler(async ({ context: { tenant } }) => {
    const out = await withTenant(tenant.companyId, (tx) => svc.cancelDeletion(tx, tenant));
    // Best effort: a copy that still fires finds the company active and does nothing.
    await unscheduleHardPurge(tenant.companyId).catch((err) =>
      log.warn("could not unschedule the hard purge", {
        companyId: tenant.companyId,
        ...errorData(err),
      }),
    );
    return out;
  }),
  deleteStatus: authed.privacy.deleteStatus.handler(({ context: { tenant } }) =>
    withTenant(tenant.companyId, (tx) => svc.deletionStatus(tx, tenant.companyId)),
  ),
});
