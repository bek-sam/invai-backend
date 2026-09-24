import { z } from "zod";
import { systemContext } from "../../api/context";
import { withTenant } from "../../db/client";
import { defineJob, onEvent } from "../../lib/queues";
import {
  isMockCarrier,
  MOCK_DELIVERY_HOURS,
  MOCK_TRANSIT_HOURS,
  markDelivered,
  markInTransit,
  PUSH_MAX_ATTEMPTS,
  pushTracking,
} from "./service";

/**
 * Push tracking to the channel after a label is bought. BullMQ retries with backoff; the
 * service records each attempt and marks the push failed after PUSH_MAX_ATTEMPTS.
 */
export const pushTrackingJob = defineJob({
  queue: "ship",
  name: "shipping.pushTracking",
  input: z.object({
    companyId: z.uuid(),
    shipmentId: z.uuid(),
    attempt: z.number().int().default(0),
  }),
  jobId: (i) => `push-tracking-${i.shipmentId}-${i.attempt}`,
  options: { attempts: PUSH_MAX_ATTEMPTS, backoff: { type: "exponential", delay: 5_000 } },
  handler: async ({ companyId, shipmentId }) => {
    const outcome = await pushTracking(companyId, systemContext(companyId), shipmentId);
    if (outcome === "retry") throw new Error(`tracking push for ${shipmentId} will be retried`);
    return { outcome };
  },
});

onEvent("shipment.labeled", pushTrackingJob, (e) => ({
  companyId: e.companyId,
  shipmentId: String(e.payload.shipmentId),
  attempt: 0,
}));

/** Mock carrier only: simulate the package moving and arriving. */
export const mockTrackingJob = defineJob({
  queue: "ship",
  name: "shipping.mockTracking",
  input: z.object({
    companyId: z.uuid(),
    shipmentId: z.uuid(),
    step: z.enum(["in_transit", "delivered"]),
  }),
  jobId: (i) => `mock-tracking-${i.shipmentId}-${i.step}`,
  handler: async ({ companyId, shipmentId, step }) => {
    const ctx = systemContext(companyId);
    await withTenant(companyId, async (tx) => {
      if (step === "in_transit") await markInTransit(tx, ctx, shipmentId);
      else await markDelivered(tx, ctx, shipmentId);
    });
  },
});

export const scheduleMockTrackingJob = defineJob({
  queue: "ship",
  name: "shipping.scheduleMockTracking",
  input: z.object({ companyId: z.uuid(), shipmentId: z.uuid() }),
  jobId: (i) => `schedule-mock-tracking-${i.shipmentId}`,
  handler: async ({ companyId, shipmentId }) => {
    if (!isMockCarrier()) return { skipped: true };
    await mockTrackingJob.enqueue(
      { companyId, shipmentId, step: "in_transit" },
      { delay: MOCK_TRANSIT_HOURS * 3600_000 },
    );
    await mockTrackingJob.enqueue(
      { companyId, shipmentId, step: "delivered" },
      { delay: MOCK_DELIVERY_HOURS * 3600_000 },
    );
    return { scheduled: true };
  },
});

onEvent("shipment.labeled", scheduleMockTrackingJob, (e) => ({
  companyId: e.companyId,
  shipmentId: String(e.payload.shipmentId),
}));
