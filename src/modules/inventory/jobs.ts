import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { withSystem, withTenant } from "../../db/client";
import { companies } from "../../db/schema";
import { env } from "../../env";
import { errorData, logger } from "../../lib/log";
import { emit } from "../../lib/outbox";
import { defineJob, onEvent, queues } from "../../lib/queues";
import { recordListingsForItems } from "../channels/sku";
import { raiseAlert } from "../today/service";
import { planAvailability, pushAvailability } from "./availability";
import { stuckSubmittingPos } from "./service";

const log = logger("inventory.jobs");

export const STUCK_SUBMITTING_SWEEP_EVERY_MS = 5 * 60_000;

/** One company's sweep for POs stuck in `submitting` past `STUCK_SUBMITTING_MS`. */
export const stuckSubmittingPoJob = defineJob({
  queue: "reports",
  name: "inventory.stuckSubmittingPos",
  input: z.object({ companyId: z.uuid(), bucket: z.number().int() }),
  jobId: (i) => `po-stuck-submitting-${i.companyId}-${i.bucket}`,
  handler: async ({ companyId }) =>
    withTenant(companyId, async (tx) => {
      const stuck = await stuckSubmittingPos(tx, companyId);
      for (const po of stuck) {
        // No dedicated alert kind for this yet; reuse the closest one that stays open, the way
        // shipping's stuck-intent sweep reuses `tracking_push_failed` for its own stuck calls.
        await raiseAlert(tx, companyId, {
          kind: "sync_broken",
          severity: "warning",
          title: `${po.poNo} is stuck sending to the supplier`,
          message: 'It\'s been in "submitting" for over 15 minutes with no confirmation back.',
          entityType: "purchase_order",
          entityId: po.id,
          dedupeKey: `po-stuck-submitting-${po.id}`,
          data: { poNo: po.poNo, supplier: po.supplier },
        });
      }
      return { stuck: stuck.length };
    }),
});

/** Fan-out over every shop (cross-tenant: owner connection, ids only). */
export const stuckSubmittingSweepJob = defineJob({
  queue: "reports",
  name: "inventory.stuckSubmittingSweep",
  input: z.object({}).passthrough(),
  handler: async () => {
    const shops = await withSystem((tx) =>
      tx.select({ id: companies.id }).from(companies).where(eq(companies.type, "shop")),
    );
    const bucket = Math.floor(Date.now() / STUCK_SUBMITTING_SWEEP_EVERY_MS);
    for (const s of shops) await stuckSubmittingPoJob.enqueue({ companyId: s.id, bucket });
    return { shops: shops.length };
  },
});

/** Idempotent: registers the 5-minute stuck-submitting sweep. */
export async function scheduleStuckSubmittingSweep() {
  await queues.reports.upsertJobScheduler(
    "inventory-stuck-submitting",
    { every: STUCK_SUBMITTING_SWEEP_EVERY_MS },
    { name: stuckSubmittingSweepJob.name, data: {} },
  );
}

if (!env.isTest) {
  scheduleStuckSubmittingSweep().catch((err) =>
    log.warn("could not register the stuck-submitting scheduler", errorData(err)),
  );
}

/** Debounce window for channel availability pushes (per company). */
export const AVAILABILITY_DEBOUNCE_MS = 30_000;

/** The debounce bucket a change at `now` lands in: the job runs at the end of that window. */
export function availabilityBucket(now: number) {
  const bucket = Math.floor(now / AVAILABILITY_DEBOUNCE_MS) + 1;
  return { bucket, delay: Math.max(0, bucket * AVAILABILITY_DEBOUNCE_MS - now) };
}

const pushInput = z.object({
  companyId: z.uuid(),
  connectionId: z.uuid(),
  idempotencyKey: z.string().min(1).max(200),
  updates: z
    .array(
      z.object({
        listingVariantId: z.uuid(),
        channelSku: z.string(),
        available: z.number().int().min(0),
        fromQty: z.number().int().nullable(),
      }),
    )
    .min(1),
});

/**
 * One connection's frozen availability push. The idempotency key and quantities live in the job
 * data, so every retry sends the same push under the same key.
 */
export const pushAvailabilityJob = defineJob({
  queue: "sync",
  name: "inventory.pushAvailability",
  input: pushInput,
  handler: async (input) => {
    const res = await pushAvailability(input);
    log.info("availability pushed", {
      companyId: input.companyId,
      connectionId: input.connectionId,
      ...res,
    });
    return res;
  },
});

/**
 * Plans the company's availability changes once per debounce window (the id is bucketed by
 * time, so every change in a window lands in the same delayed job and stock is read at run
 * time), then queues one push per opted-in connection. A retry of this job re-adds the same
 * push job ids, which BullMQ ignores, so a connection gets one push per window.
 */
export const syncAvailabilityJob = defineJob({
  queue: "sync",
  name: "inventory.syncAvailability",
  input: z.object({ companyId: z.uuid(), bucket: z.number().int() }),
  jobId: (i) => `availability-${i.companyId}-${i.bucket}`,
  handler: async ({ companyId, bucket }) => {
    const plan = await withTenant(companyId, (tx) => planAvailability(tx, companyId));
    for (const p of plan.pushes) {
      await pushAvailabilityJob.enqueue(
        {
          companyId,
          connectionId: p.connectionId,
          idempotencyKey: randomUUID(),
          updates: p.updates,
        },
        { jobId: `availability-push-${bucket}-${p.connectionId}` },
      );
    }
    const res = {
      connections: plan.pushes.length,
      variants: plan.pushes.reduce((n, p) => n + p.updates.length, 0),
      skippedConnections: plan.skippedConnections,
    };
    log.info("availability planned", { companyId, bucket, ...res });
    return res;
  },
});

export const scheduleAvailabilitySync = defineJob({
  queue: "sync",
  name: "inventory.scheduleAvailabilitySync",
  input: z.object({ companyId: z.uuid() }),
  handler: async ({ companyId }) => {
    const { bucket, delay } = availabilityBucket(Date.now());
    await syncAvailabilityJob.enqueue({ companyId, bucket }, { delay });
    return { bucket, delay };
  },
});

onEvent("stock.availability_changed", scheduleAvailabilitySync, (e) => ({
  companyId: e.companyId,
}));

/**
 * Records the listings and listing variants that imported or mapped units name (channels/sku).
 * A variant that is new or now maps to a different blank queues an availability push.
 */
export const recordListingsJob = defineJob({
  queue: "sync",
  name: "inventory.recordListings",
  input: z.object({ companyId: z.uuid(), orderItemIds: z.array(z.uuid()).max(5_000) }),
  handler: async ({ companyId, orderItemIds }) =>
    withTenant(companyId, async (tx) => {
      const res = await recordListingsForItems(tx, companyId, orderItemIds);
      if (res.blankVariantIds.length)
        await emit(tx, companyId, "stock.availability_changed", {
          blankVariantIds: res.blankVariantIds,
        });
      return res;
    }),
});

onEvent("order.imported", recordListingsJob, (e) => ({
  companyId: e.companyId,
  orderItemIds: (e.payload as { itemIds: string[] }).itemIds,
}));
onEvent("item.mapped", recordListingsJob, (e) => ({
  companyId: e.companyId,
  orderItemIds: (e.payload as { orderItemIds: string[] }).orderItemIds,
}));
