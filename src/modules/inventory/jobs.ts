import { z } from "zod";
import { withTenant } from "../../db/client";
import { logger } from "../../lib/log";
import { defineJob, onEvent } from "../../lib/queues";
import { syncAvailability } from "./availability";

const log = logger("inventory.jobs");

/** Debounce window for channel availability pushes (per company). */
export const AVAILABILITY_DEBOUNCE_MS = 30_000;

/**
 * Pushes current availability to every channel listing variant drawn from a blank. Runs at
 * most once per company per 30-second window: the id is bucketed by time, so every change in
 * the window lands in the same delayed job and the handler reads the stock at run time.
 */
export const syncAvailabilityJob = defineJob({
  queue: "sync",
  name: "inventory.syncAvailability",
  input: z.object({ companyId: z.uuid(), bucket: z.number().int() }),
  jobId: (i) => `availability-${i.companyId}-${i.bucket}`,
  handler: async ({ companyId }) => {
    const res = await withTenant(companyId, (tx) => syncAvailability(tx, companyId));
    log.info("availability synced", { companyId, ...res });
    return res;
  },
});

export const scheduleAvailabilitySync = defineJob({
  queue: "sync",
  name: "inventory.scheduleAvailabilitySync",
  input: z.object({ companyId: z.uuid() }),
  handler: async ({ companyId }) => {
    const now = Date.now();
    const bucket = Math.floor(now / AVAILABILITY_DEBOUNCE_MS) + 1;
    const delay = Math.max(0, bucket * AVAILABILITY_DEBOUNCE_MS - now);
    await syncAvailabilityJob.enqueue({ companyId, bucket }, { delay });
    return { bucket, delay };
  },
});

onEvent("stock.availability_changed", scheduleAvailabilitySync, (e) => ({
  companyId: e.companyId,
}));
