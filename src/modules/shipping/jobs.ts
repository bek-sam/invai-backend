import { and, eq, gt, inArray, isNotNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { systemContext, type TenantContext } from "../../api/context";
import { afterCommit, type Tx, withSystem, withTenant } from "../../db/client";
import {
  CARRIER_WEBHOOK_EVENT_RETENTION_MS,
  carrierWebhookEvents,
  shipments,
} from "../../db/schema";
import { env } from "../../env";
import {
  carrierTracking,
  TRACKER_STATUSES,
  type TrackerStatus,
  trackerMove,
} from "../../integrations/carriers";
import { takeToken } from "../../integrations/suppliers/ratelimit";
import { isORPCError } from "../../lib/errors";
import { errorData, logger } from "../../lib/log";
import { emit } from "../../lib/outbox";
import { defineJob, onEvent, queues, redis } from "../../lib/queues";
import { publish } from "../../lib/realtime";
import { raiseAlert } from "../today/service";
import {
  buyLabel,
  isMockCarrier,
  MOCK_DELIVERY_HOURS,
  MOCK_TRANSIT_HOURS,
  markDelivered,
  markInTransit,
  PUSH_MAX_ATTEMPTS,
  pushReleasedShipments,
  pushTracking,
  voidCancelledLabels,
  voidShipment,
} from "./service";

const log = logger("shipping.jobs");

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
    // "held" is not retried: the `order.released` job pushes it after the hold.
    if (outcome === "retry" || outcome === "busy")
      throw new Error(`tracking push for ${shipmentId} will be retried (${outcome})`);
    return { outcome };
  },
});

onEvent("shipment.labeled", pushTrackingJob, (e) => ({
  companyId: e.companyId,
  shipmentId: String(e.payload.shipmentId),
  attempt: 0,
}));

/**
 * An order (or some of its units) was cancelled: void its labels that haven't shipped (the
 * cancel already blocked their tracking push). Retries while a buy or void is in flight.
 */
export const voidCancelledLabelsJob = defineJob({
  queue: "ship",
  name: "shipping.voidCancelledLabels",
  input: z.object({ companyId: z.uuid(), orderId: z.uuid() }),
  options: { attempts: 8, backoff: { type: "exponential", delay: 5_000 } },
  handler: async ({ companyId, orderId }) => {
    const out = await voidCancelledLabels(systemContext(companyId), orderId);
    if (out.retry) throw new Error(`labels of cancelled order ${orderId}: will retry`);
    return out;
  },
});

onEvent("order.cancelled", voidCancelledLabelsJob, (e) => ({
  companyId: e.companyId,
  orderId: String(e.payload.orderId),
}));

/** A hold was released: push the tracking it held back. */
export const pushReleasedJob = defineJob({
  queue: "ship",
  name: "shipping.pushReleased",
  input: z.object({ companyId: z.uuid(), orderId: z.uuid() }),
  options: { attempts: PUSH_MAX_ATTEMPTS, backoff: { type: "exponential", delay: 5_000 } },
  handler: async ({ companyId, orderId }) => {
    const outcomes = await pushReleasedShipments(systemContext(companyId), orderId);
    if (outcomes.some((o) => o === "retry" || o === "busy"))
      throw new Error(`tracking push after release of ${orderId}: will retry`);
    return { outcomes };
  },
});

onEvent("order.released", pushReleasedJob, (e) => ({
  companyId: e.companyId,
  orderId: String(e.payload.orderId),
}));

/** Mock carrier only: simulate the package moving and arriving (same state function as EasyPost). */
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
    const now = new Date();
    return applyTrackerUpdate(companyId, shipmentId, {
      status: step,
      statusDetail: null,
      occurredAt: now,
      deliveredAt: step === "delivered" ? now : null,
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

/* ------------------------------ carrier tracking ----------------------------- */

/** A tracker reading, as the state function takes it (EasyPost webhook, poll or mock timer). */
export type TrackerReading = {
  status: TrackerStatus;
  statusDetail: string | null;
  occurredAt: Date;
  deliveredAt: Date | null;
};

/**
 * The carrier reports a return or a failed delivery: `labeled` or `in_transit` becomes
 * `exception`. A delivered (or voided) shipment never moves back.
 */
async function markException(tx: Tx, ctx: TenantContext, shipmentId: string, why: TrackerStatus) {
  const [s] = await tx.select().from(shipments).where(eq(shipments.id, shipmentId)).for("update");
  if (!s || (s.status !== "labeled" && s.status !== "in_transit")) return;
  await tx
    .update(shipments)
    .set({ status: "exception", trackingStatus: why })
    .where(eq(shipments.id, s.id));
  await emit(tx, ctx.companyId, "shipment.status_changed", {
    shipmentId: s.id,
    from: s.status,
    to: "exception",
  });
  afterCommit(tx, () =>
    publish(ctx.companyId, {
      type: "shipment.updated",
      data: { shipmentId: s.id, orderId: s.orderId, status: "exception" },
    }).then(() => undefined),
  );
}

/**
 * Apply a tracker reading to a shipment, forward only: `in_transit` on the first carrier scan
 * (which also ships units no tracking push shipped, T-2-5), `delivered`, and a return or failure
 * as `exception`. The service functions ignore any move backwards (a late `in_transit` after
 * `delivered` changes nothing). Runs inside the caller's tenant transaction, shipment locked.
 */
async function applyReading(tx: Tx, ctx: TenantContext, shipmentId: string, r: TrackerReading) {
  const move = trackerMove(r.status);
  if (move === "in_transit") {
    await markInTransit(tx, ctx, shipmentId);
    // Keep the carrier's finer status (out for delivery, ready for pickup) while in transit.
    await tx
      .update(shipments)
      .set({ trackingStatus: r.status })
      .where(and(eq(shipments.id, shipmentId), eq(shipments.status, "in_transit")));
  } else if (move === "delivered") {
    await markDelivered(tx, ctx, shipmentId, r.deliveredAt ?? r.occurredAt);
  } else if (move === "exception") {
    await markException(tx, ctx, shipmentId, r.status);
  }
}

async function lockedStatus(tx: Tx, shipmentId: string) {
  const [s] = await tx
    .select({ status: shipments.status })
    .from(shipments)
    .where(eq(shipments.id, shipmentId))
    .for("update");
  return s?.status ?? null;
}

/**
 * The one tracking state function: the EasyPost webhook, the daily poll and the mock carrier's
 * timer all move shipments through it. Returns the status before and after.
 */
export async function applyTrackerUpdate(
  companyId: string,
  shipmentId: string,
  reading: TrackerReading,
) {
  const ctx = systemContext(companyId);
  return withTenant(companyId, async (tx) => {
    const from = await lockedStatus(tx, shipmentId);
    if (!from) return { from: null, to: null };
    await applyReading(tx, ctx, shipmentId, reading);
    return { from, to: await lockedStatus(tx, shipmentId) };
  });
}

/* ------------------------------ EasyPost events ------------------------------ */

/** Record a verified event id. False when it was already recorded (a redelivery). */
export async function recordCarrierEvent(
  eventId: string,
  initial: { status?: "received" | "ignored"; detail?: string } = {},
): Promise<boolean> {
  const inserted = await withSystem((tx) =>
    tx
      .insert(carrierWebhookEvents)
      .values({
        provider: "easypost",
        eventId,
        status: initial.status ?? "received",
        detail: initial.detail ?? null,
        processedAt: initial.status === "ignored" ? new Date() : null,
      })
      .onConflictDoNothing()
      .returning({ id: carrierWebhookEvents.id }),
  );
  return inserted.length > 0;
}

/** Undo a record whose job could not be enqueued, so EasyPost's retry is processed. */
export async function forgetCarrierEvent(eventId: string) {
  await withSystem((tx) =>
    tx
      .delete(carrierWebhookEvents)
      .where(
        and(
          eq(carrierWebhookEvents.provider, "easypost"),
          eq(carrierWebhookEvents.eventId, eventId),
          eq(carrierWebhookEvents.status, "received"),
        ),
      ),
  );
}

async function finishCarrierEvent(
  eventId: string,
  outcome: {
    status: "processed" | "ignored" | "failed";
    companyId?: string | null;
    detail?: string | null;
    subjectId?: string | null;
    occurredAt?: Date | null;
  },
) {
  await withSystem((tx) =>
    tx
      .update(carrierWebhookEvents)
      .set({
        status: outcome.status,
        companyId: outcome.companyId ?? null,
        detail: outcome.detail ?? null,
        subjectId: outcome.subjectId ?? null,
        occurredAt: outcome.occurredAt ?? null,
        processedAt: new Date(),
      })
      .where(
        and(
          eq(carrierWebhookEvents.provider, "easypost"),
          eq(carrierWebhookEvents.eventId, eventId),
        ),
      ),
  );
}

/** Delete carrier events older than the retention window (daily job). */
export async function purgeCarrierWebhookEvents(now = new Date()) {
  const cutoff = new Date(now.getTime() - CARRIER_WEBHOOK_EVENT_RETENTION_MS);
  const deleted = await withSystem((tx) =>
    tx
      .delete(carrierWebhookEvents)
      .where(lt(carrierWebhookEvents.receivedAt, cutoff))
      .returning({ id: carrierWebhookEvents.id }),
  );
  return { deleted: deleted.length };
}

const trackerInput = z.object({
  trackerId: z.string().nullable(),
  trackingCode: z.string().min(1),
  carrierShipmentId: z.string().nullable(),
  status: z.enum(TRACKER_STATUSES),
  statusDetail: z.string().nullable(),
  occurredAt: z.iso.datetime(),
  deliveredAt: z.iso.datetime().nullable(),
});
export type CarrierEventTracker = z.infer<typeof trackerInput>;

export type CarrierEventOutcome =
  | { status: "processed"; shipmentId: string; from: string; to: string }
  | { status: "ignored"; reason: string };

/**
 * Process one verified EasyPost event (the route already deduped it on the event id). Routes the
 * tracker to its shipment by the carrier shipment id (else the tracking code), then applies it
 * under the shipment's row lock, unless a processed event for the same tracker already carried a
 * later scan: an older event arriving late never moves a shipment, even to `exception`.
 */
export async function processCarrierEvent(input: {
  eventId: string;
  description: string;
  tracker: CarrierEventTracker | null;
}): Promise<CarrierEventOutcome> {
  const { eventId, tracker } = input;
  const ignore = async (reason: string, extra: { companyId?: string } = {}) => {
    await finishCarrierEvent(eventId, { status: "ignored", detail: reason, ...extra });
    return { status: "ignored" as const, reason };
  };
  if (!tracker) return ignore(`unhandled event ${input.description}`);

  const matches = await withSystem((tx) =>
    tx
      .select({
        id: shipments.id,
        companyId: shipments.companyId,
        trackingCode: shipments.trackingCode,
      })
      .from(shipments)
      .where(
        tracker.carrierShipmentId
          ? eq(shipments.carrierShipmentId, tracker.carrierShipmentId)
          : eq(shipments.trackingCode, tracker.trackingCode),
      )
      .limit(2),
  );
  if (!matches.length) return ignore("no shipment for this tracker");
  if (matches.length > 1) return ignore("tracker matches more than one shipment");
  const target = matches[0] as (typeof matches)[number];
  if (target.trackingCode !== tracker.trackingCode)
    return ignore("tracking code differs from the shipment's label", {
      companyId: target.companyId,
    });

  const subjectId = tracker.trackerId ?? tracker.trackingCode;
  const occurredAt = new Date(tracker.occurredAt);
  const reading: TrackerReading = {
    status: tracker.status,
    statusDetail: tracker.statusDetail,
    occurredAt,
    deliveredAt: tracker.deliveredAt ? new Date(tracker.deliveredAt) : null,
  };
  let finished = false;
  try {
    const res = await withTenant(target.companyId, async (tx) => {
      const from = await lockedStatus(tx, target.id);
      if (!from) return { stale: false, from: null, to: null };
      // Under the shipment lock, so a concurrent event for this tracker has either finished
      // (and is seen here) or waits for this one.
      const [newer] = await tx
        .select({ id: carrierWebhookEvents.id })
        .from(carrierWebhookEvents)
        .where(
          and(
            eq(carrierWebhookEvents.provider, "easypost"),
            eq(carrierWebhookEvents.subjectId, subjectId),
            eq(carrierWebhookEvents.status, "processed"),
            gt(carrierWebhookEvents.occurredAt, occurredAt),
          ),
        )
        .limit(1);
      if (newer) return { stale: true, from, to: from };
      await applyReading(tx, systemContext(target.companyId), target.id, reading);
      const to = await lockedStatus(tx, target.id);
      // Recorded while the lock is held, so the next event for this tracker sees it.
      await finishCarrierEvent(eventId, {
        status: "processed",
        companyId: target.companyId,
        subjectId,
        occurredAt,
        detail: `${tracker.status}: ${from} -> ${to}`,
      });
      finished = true;
      return { stale: false, from, to };
    });
    if (res.stale)
      return ignore("older than the last applied tracker event", { companyId: target.companyId });
    if (!res.from) return ignore("shipment not found", { companyId: target.companyId });
    return {
      status: "processed",
      shipmentId: target.id,
      from: res.from,
      to: res.to ?? res.from,
    };
  } catch (err) {
    // Not applied (or the commit failed after the record): mark it failed; the job retries.
    await finishCarrierEvent(eventId, {
      status: "failed",
      companyId: target.companyId,
      subjectId,
      detail: err instanceof Error ? err.message.slice(0, 500) : "failed",
    }).catch(() => {});
    if (finished) log.warn("carrier event recorded but its transaction failed", { eventId });
    throw err;
  }
}

/** Verified EasyPost events, normalized at the edge (no PII in the queue). */
export const easypostEventJob = defineJob({
  queue: "ship",
  name: "shipping.easypostEvent",
  input: z.object({
    eventId: z.string().min(1),
    description: z.string(),
    tracker: trackerInput.nullable(),
  }),
  jobId: (i) => `easypost-${i.eventId}`,
  options: { attempts: 5, backoff: { type: "exponential", delay: 5_000 } },
  handler: async (input) => processCarrierEvent(input),
});

/** Daily: drop carrier webhook event records past their retention (7 days). */
export const purgeCarrierWebhookEventsJob = defineJob({
  queue: "ship",
  name: "shipping.carrierWebhookEvents.purge",
  input: z.object({}).passthrough(),
  handler: async () => purgeCarrierWebhookEvents(),
});

/* ---------------------------- fallback tracker poll -------------------------- */

/** A label with no carrier scan after this long is polled (webhooks may have been missed). */
export const TRACKER_POLL_AFTER_MS = 3 * 86400_000;
const TRACKER_POLL_BATCH = 500;

/** Refresh one shipment from its carrier tracker. */
export const pollTrackerJob = defineJob({
  queue: "ship",
  name: "shipping.pollTracker",
  input: z.object({ companyId: z.uuid(), shipmentId: z.uuid() }),
  options: { attempts: 3, backoff: { type: "exponential", delay: 60_000 } },
  handler: async ({ companyId, shipmentId }) => {
    const [s] = await withTenant(companyId, (tx) =>
      tx.select().from(shipments).where(eq(shipments.id, shipmentId)),
    );
    if (s?.status !== "labeled" || !s.carrierShipmentId || !s.trackingCode)
      return { skipped: true };
    const tracking = carrierTracking();
    // EasyPost index and read endpoints allow about 5 requests per second per account.
    if (tracking.provider === "easypost")
      await takeToken("easypost:trackers", { capacity: 5, perMs: 1_000 }, 120_000);
    const update = await tracking.track({
      companyId,
      carrierShipmentId: s.carrierShipmentId,
      trackingCode: s.trackingCode,
      carrier: s.carrier,
    });
    if (!update || update.trackingCode !== s.trackingCode) return { skipped: true };
    return applyTrackerUpdate(companyId, shipmentId, update);
  },
});

/** Daily fan-out: shipments still `labeled` 3+ days after the label (cross-tenant, ids only). */
export const trackerPollSweepJob = defineJob({
  queue: "ship",
  name: "shipping.trackerPollSweep",
  input: z.object({}).passthrough(),
  handler: async () => {
    const cutoff = new Date(Date.now() - TRACKER_POLL_AFTER_MS);
    const rows = await withSystem((tx) =>
      tx
        .select({ id: shipments.id, companyId: shipments.companyId })
        .from(shipments)
        .where(
          and(
            eq(shipments.status, "labeled"),
            lt(shipments.labeledAt, cutoff),
            isNotNull(shipments.carrierShipmentId),
            isNotNull(shipments.trackingCode),
          ),
        )
        .orderBy(shipments.labeledAt)
        .limit(TRACKER_POLL_BATCH),
    );
    const day = new Date().toISOString().slice(0, 10);
    for (const r of rows)
      await pollTrackerJob.enqueue(
        { companyId: r.companyId, shipmentId: r.id },
        { jobId: `poll-tracker-${r.id}-${day}` },
      );
    return { shipments: rows.length };
  },
});

/* ---------------------------- stuck intent sweep ----------------------------- */

/** A buy, void or push intent untouched this long is retried by the sweep. */
export const STUCK_INTENT_MS = 15 * 60_000;
/** Alert the shop after this many failed sweep retries of one intent. */
export const STUCK_ALERT_AFTER = 3;
export const STUCK_SWEEP_EVERY_MS = 5 * 60_000;
const STUCK_BATCH = 200;
const STUCK_KINDS = ["buy", "void", "push"] as const;
type StuckKind = (typeof STUCK_KINDS)[number];

const failureKey = (kind: StuckKind, shipmentId: string) => `stuck-intent:${kind}:${shipmentId}`;

/** Intents older than STUCK_INTENT_MS (cross-tenant, ids only). */
export async function findStuckIntents(now = new Date()) {
  const cutoff = new Date(now.getTime() - STUCK_INTENT_MS);
  const rows = await withSystem((tx) =>
    tx
      .select({
        id: shipments.id,
        companyId: shipments.companyId,
        status: shipments.status,
        push: shipments.trackingPushStatus,
      })
      .from(shipments)
      .where(
        or(
          and(inArray(shipments.status, ["buying", "voiding"]), lt(shipments.updatedAt, cutoff)),
          and(
            eq(shipments.trackingPushStatus, "pushing"),
            lt(sql`coalesce(${shipments.pushAttemptedAt}, ${shipments.updatedAt})`, cutoff),
          ),
        ),
      )
      .limit(STUCK_BATCH),
  );
  return rows.map((r) => ({
    shipmentId: r.id,
    companyId: r.companyId,
    kind: (r.status === "buying" ? "buy" : r.status === "voiding" ? "void" : "push") as StuckKind,
  }));
}

const STUCK_ALERTS: Record<StuckKind, { title: string; message: string }> = {
  buy: {
    title: "A label purchase needs a look",
    message:
      "We couldn't confirm a label purchase with the carrier after several tries. Open the shipment and buy the label again to check; you won't be charged twice.",
  },
  void: {
    title: "A label void needs a look",
    message:
      "We couldn't confirm a label void with the carrier. Open the shipment and void it again, or contact the carrier about the refund.",
  },
  push: {
    title: "Tracking wasn't sent to the channel",
    message:
      "We couldn't confirm the tracking upload to the channel after several tries. Open the tracking list and retry it.",
  },
};

async function alertStuck(companyId: string, shipmentId: string, kind: StuckKind, why: string) {
  const a = STUCK_ALERTS[kind];
  await withTenant(companyId, (tx) =>
    raiseAlert(tx, companyId, {
      // No dedicated kind in the contract yet; the closest shipping alert that stays open.
      kind: "tracking_push_failed",
      severity: "warning",
      title: a.title,
      message: a.message,
      entityType: "shipment",
      entityId: shipmentId,
      dedupeKey: `stuck-intent-${kind}-${shipmentId}`,
      data: { intent: kind, detail: why.slice(0, 300) },
    }),
  );
}

type StuckResult = "resolved" | "failed" | "alerted";

/**
 * Retry one stuck intent with the service's own crash-safe paths: a buy is only read back from
 * the carrier (`readBackOnly`: it records a label the carrier sold, else returns the shipment to
 * `rated`; never a new purchase), a void reads the refund back before asking again, and a push
 * goes through `pushTracking` (safe to repeat, T-2-5). Failures are counted per intent; the shop
 * is alerted after STUCK_ALERT_AFTER, or at once when the carrier or channel gave up for good.
 */
export async function retryStuckIntent(
  companyId: string,
  shipmentId: string,
  kind: StuckKind,
): Promise<StuckResult> {
  const ctx = systemContext(companyId);
  const [s] = await withTenant(companyId, (tx) =>
    tx.select().from(shipments).where(eq(shipments.id, shipmentId)),
  );
  const stillStuck = (row: typeof s) =>
    !!row &&
    (kind === "buy"
      ? row.status === "buying"
      : kind === "void"
        ? row.status === "voiding"
        : row.trackingPushStatus === "pushing");
  const ok = async () => {
    await redis.del(failureKey(kind, shipmentId));
    return "resolved" as const;
  };
  if (!stillStuck(s)) return ok();

  let error: string | null = null;
  let final = false;
  try {
    if (kind === "buy") {
      if (!s?.selectedRateId) error = "no selected rate on the buying shipment";
      else await buyLabel(ctx, { shipmentId, rateId: s.selectedRateId }, { readBackOnly: true });
    } else if (kind === "void") {
      await voidShipment(ctx, { id: shipmentId, reason: "retried after it got stuck" });
    } else {
      const outcome = await pushTracking(companyId, ctx, shipmentId);
      if (outcome === "failed") {
        error = "the channel refused the tracking upload";
        final = true;
      } else if (outcome === "retry" || outcome === "busy") {
        error = `push ${outcome}`;
        // Back to the push job's own retry loop (it marks the push failed after
        // PUSH_MAX_ATTEMPTS and emits tracking.push_failed).
        await pushTrackingJob.enqueue(
          { companyId, shipmentId, attempt: 0 },
          { jobId: `push-tracking-${shipmentId}-sweep-${Date.now()}` },
        );
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    final = isORPCError(err) && err.code === "VOID_REJECTED";
  }
  if (!error) {
    const [after] = await withTenant(companyId, (tx) =>
      tx.select().from(shipments).where(eq(shipments.id, shipmentId)),
    );
    if (!stillStuck(after)) return ok();
    error = "still in flight after the retry";
  }
  const failures = await redis.incr(failureKey(kind, shipmentId));
  await redis.pexpire(failureKey(kind, shipmentId), 7 * 86400_000);
  log.warn("stuck intent retry failed", { shipmentId, kind, failures, error });
  if (final || failures >= STUCK_ALERT_AFTER) {
    await alertStuck(companyId, shipmentId, kind, error);
    return "alerted";
  }
  return "failed";
}

export const retryStuckIntentJob = defineJob({
  queue: "ship",
  name: "shipping.retryStuckIntent",
  input: z.object({ companyId: z.uuid(), shipmentId: z.uuid(), kind: z.enum(STUCK_KINDS) }),
  // One try per sweep: the sweep is the retry loop and counts failures itself.
  options: { attempts: 1 },
  handler: async ({ companyId, shipmentId, kind }) => ({
    result: await retryStuckIntent(companyId, shipmentId, kind),
  }),
});

export const stuckIntentSweepJob = defineJob({
  queue: "ship",
  name: "shipping.stuckIntentSweep",
  input: z.object({}).passthrough(),
  handler: async () => {
    const stuck = await findStuckIntents();
    const bucket = Math.floor(Date.now() / STUCK_SWEEP_EVERY_MS);
    for (const i of stuck)
      await retryStuckIntentJob.enqueue(i, {
        jobId: `stuck-${i.kind}-${i.shipmentId}-${bucket}`,
      });
    return { stuck: stuck.length };
  },
});

/** Idempotent: registers the stuck-intent sweep, the daily tracker poll and the event purge. */
export async function scheduleShippingJobs() {
  await queues.ship.upsertJobScheduler(
    "shipping-stuck-intents",
    { every: STUCK_SWEEP_EVERY_MS },
    { name: stuckIntentSweepJob.name, data: {} },
  );
  await queues.ship.upsertJobScheduler(
    "shipping-tracker-poll",
    { pattern: "20 6 * * *", tz: "UTC" },
    { name: trackerPollSweepJob.name, data: {} },
  );
  await queues.ship.upsertJobScheduler(
    "shipping-carrier-events-purge",
    { pattern: "55 4 * * *", tz: "UTC" },
    { name: purgeCarrierWebhookEventsJob.name, data: {} },
  );
}

if (!env.isTest) {
  scheduleShippingJobs().catch((err) =>
    log.warn("could not register the shipping schedulers", errorData(err)),
  );
}
