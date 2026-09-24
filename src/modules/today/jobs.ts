import { eq } from "drizzle-orm";
import { z } from "zod";
import { systemContext } from "../../api/context";
import { withSystem, withTenant } from "../../db/client";
import { companies } from "../../db/schema";
import { env } from "../../env";
import { errorData, logger } from "../../lib/log";
import { defineJob, queues } from "../../lib/queues";
import { generateAlerts } from "./service";

const log = logger("today.jobs");

export const ALERT_SWEEP_EVERY_MS = 5 * 60_000;

/** One company's alert sweep; the id is bucketed per 5 minutes so a sweep never runs twice. */
export const generateAlertsJob = defineJob({
  queue: "reports",
  name: "today.generateAlerts",
  input: z.object({ companyId: z.uuid(), bucket: z.number().int() }),
  jobId: (i) => `alerts-${i.companyId}-${i.bucket}`,
  handler: async ({ companyId }) =>
    withTenant(companyId, (tx) => generateAlerts(tx, systemContext(companyId))),
});

/** Fan-out over every shop (cross-tenant: owner connection, ids only). */
export const alertsSweepJob = defineJob({
  queue: "reports",
  name: "today.alertsSweep",
  input: z.object({}).passthrough(),
  handler: async () => {
    const shops = await withSystem((tx) =>
      tx.select({ id: companies.id }).from(companies).where(eq(companies.type, "shop")),
    );
    const bucket = Math.floor(Date.now() / ALERT_SWEEP_EVERY_MS);
    for (const s of shops) await generateAlertsJob.enqueue({ companyId: s.id, bucket });
    return { shops: shops.length };
  },
});

/** Idempotent: registers the 5-minute alert scheduler (safe from API and worker). */
export async function scheduleAlertJobs() {
  await queues.reports.upsertJobScheduler(
    "alerts-sweep",
    { every: ALERT_SWEEP_EVERY_MS },
    { name: alertsSweepJob.name, data: {} },
  );
}

if (!env.isTest) {
  scheduleAlertJobs().catch((err) =>
    log.warn("could not register the alert scheduler", errorData(err)),
  );
}
