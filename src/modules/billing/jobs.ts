import { lt } from "drizzle-orm";
import { z } from "zod";
import { withSystem, withTenant } from "../../db/client";
import { BILLING_WEBHOOK_EVENT_RETENTION_MS, billingWebhookEvents } from "../../db/schema";
import { env } from "../../env";
import { errorData, logger } from "../../lib/log";
import { defineJob, onEvent, queues } from "../../lib/queues";
import { expireTrials, recordUsage } from "./service";

const log = logger("billing.jobs");

/** Nightly: trials past their end with no subscription become `trial_expired`. */
export const expireTrialsJob = defineJob({
  queue: "reports",
  name: "billing.expireTrials",
  input: z.object({}).passthrough(),
  handler: async () => expireTrials(),
});

/** Delete Stripe webhook event records past their retention (system role: cross-tenant). */
export async function purgeBillingWebhookEvents(now = new Date()) {
  const cutoff = new Date(now.getTime() - BILLING_WEBHOOK_EVENT_RETENTION_MS);
  const deleted = await withSystem((tx) =>
    tx
      .delete(billingWebhookEvents)
      .where(lt(billingWebhookEvents.receivedAt, cutoff))
      .returning({ id: billingWebhookEvents.id }),
  );
  return { deleted: deleted.length };
}

export const purgeBillingWebhookEventsJob = defineJob({
  queue: "reports",
  name: "billing.webhookEvents.purge",
  input: z.object({}).passthrough(),
  handler: async () => purgeBillingWebhookEvents(),
});

/** One `sheetsBuilt` per built sheet (the relay's jobId makes each event run once). */
export const recordSheetBuiltJob = defineJob({
  queue: "reports",
  name: "billing.recordSheetBuilt",
  input: z.object({ companyId: z.uuid(), sheetId: z.uuid() }),
  handler: async ({ companyId }) => {
    await withTenant(companyId, (tx) => recordUsage(tx, companyId, { sheetsBuilt: 1 }));
  },
});
onEvent("sheet.built", recordSheetBuiltJob, (e) => ({
  companyId: e.companyId,
  sheetId: String(e.payload.sheetId),
}));

/** Idempotent: registers the nightly trial expiry and event purge (API and worker). */
export async function scheduleBillingJobs() {
  await queues.reports.upsertJobScheduler(
    "billing-expire-trials",
    { pattern: "15 5 * * *", tz: "UTC" },
    { name: expireTrialsJob.name, data: {} },
  );
  await queues.reports.upsertJobScheduler(
    "billing-webhook-events-purge",
    { pattern: "50 4 * * *", tz: "UTC" },
    { name: purgeBillingWebhookEventsJob.name, data: {} },
  );
}

if (!env.isTest) {
  scheduleBillingJobs().catch((err) =>
    log.warn("could not register the billing schedulers", errorData(err)),
  );
}
