import type { BATCH_STRATEGIES, BatchBuyResult as BatchBuyResultSchema } from "@invai/contracts";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { systemContext, type TenantContext } from "../../api/context";
import { withTenant } from "../../db/client";
import { jobs, orders, type ShipmentState, shipments } from "../../db/schema";
import { upstream } from "../../lib/errors";
import { errorData, logger } from "../../lib/log";
import { emit } from "../../lib/outbox";
import { defineJob, isFinalAttempt, onEvent, RETRY_BACKOFF } from "../../lib/queues";
import { assertPaidActionAllowed } from "../billing/service";
import { createJobRow, updateJobRow } from "../production/job-rows";
import {
  BUY_IN_FLIGHT_MS,
  buyLabel,
  getSettings,
  getShipment,
  pickRate,
  rateOrder,
} from "./service";

/*
 * Batch label buy as a job (B-61). `shipping.batchBuy` records a `batch_labels` job row and an
 * outbox event and answers at once with `status: "queued"`; the web polls `production.jobs.get`.
 * The job buys one order at a time through the crash-safe `rateOrder` + `buyLabel` (T-2-5), so
 * the one-label-per-shipment guarantees hold. Each order's outcome is written to the job row
 * (`input.results`) as it happens, and the shipment id is written *before* the buy, so a run
 * that restarts after a crash (worker killed mid-batch) skips finished orders, recognises a
 * label it bought as its own, and finishes an interrupted buy with a carrier read-back.
 */

const log = logger("shipping.batch");

const LIVE_LABEL: ShipmentState[] = ["labeled", "in_transit", "delivered", "exception", "returned"];

type Strategy = (typeof BATCH_STRATEGIES)[number];
type BatchBuyResult = z.infer<typeof BatchBuyResultSchema>;
type OrderResult = {
  shipmentId: string | null;
  /** `buying`: the shipment was chosen and the buy started; the outcome isn't recorded yet. */
  status: "labeled" | "failed" | "skipped" | "buying";
  error: string | null;
  postage: number;
};
type BatchInput = {
  orderIds: string[];
  strategy: Strategy;
  packagePresetId: string | null;
  results: Record<string, OrderResult>;
};

export async function startBatchBuy(
  ctx: TenantContext,
  input: { orderIds: string[]; strategy?: Strategy | undefined; packagePresetId?: string },
): Promise<BatchBuyResult> {
  const orderIds = [...new Set(input.orderIds)];
  const job = await withTenant(ctx.companyId, async (tx) => {
    await assertPaidActionAllowed(tx, ctx);
    const settings = await getSettings(tx, ctx);
    const batch: BatchInput = {
      orderIds,
      strategy: input.strategy ?? settings.defaultStrategy,
      packagePresetId: input.packagePresetId ?? null,
      results: {},
    };
    const row = await createJobRow(tx, ctx, "batch_labels", batch);
    await tx
      .update(jobs)
      .set({ message: `Queued: ${orderIds.length} labels` })
      .where(eq(jobs.id, row.id));
    await emit(tx, ctx.companyId, "shipping.batch_requested", { jobId: row.id });
    return row;
  });
  return {
    jobId: job.id,
    status: "queued",
    results: [],
    labeled: 0,
    failed: 0,
    totalPostage: 0,
  };
}

/** Write one order's outcome into the job row (row-locked read-modify-write). */
async function saveResult(companyId: string, jobId: string, orderId: string, r: OrderResult) {
  await withTenant(companyId, async (tx) => {
    const [row] = await tx.select().from(jobs).where(eq(jobs.id, jobId)).for("update");
    if (!row) return;
    const input = row.input as BatchInput;
    // A label this batch bought stays counted: a duplicate run can't downgrade it to failed.
    if (input.results[orderId]?.status === "labeled" && r.status !== "labeled") return;
    await tx
      .update(jobs)
      .set({ input: { ...input, results: { ...input.results, [orderId]: r } } })
      .where(eq(jobs.id, jobId));
  });
}

type Step = { kind: "done"; result: OrderResult } | { kind: "in_flight"; until: number };

/** Buy one order's label, or recognise and finish what an earlier run of this batch started. */
async function buyOne(
  ctx: TenantContext,
  jobId: string,
  orderId: string,
  batch: BatchInput,
): Promise<Step> {
  const prev = batch.results[orderId];
  const cur = await withTenant(ctx.companyId, async (tx) => {
    const [s] = await tx
      .select({
        id: shipments.id,
        status: shipments.status,
        selectedRateId: shipments.selectedRateId,
        buyAttemptedAt: shipments.buyAttemptedAt,
      })
      .from(shipments)
      .where(
        and(eq(shipments.orderId, orderId), inArray(shipments.status, [...LIVE_LABEL, "buying"])),
      )
      .orderBy(desc(shipments.createdAt))
      .limit(1);
    const [order] = await tx
      .select({ shipBy: orders.shipBy })
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);
    const postage =
      s && LIVE_LABEL.includes(s.status) ? (await getShipment(tx, ctx, s.id)).postage : 0;
    return { s, order, postage };
  });
  if (!cur.order) return done(null, "failed", "Order not found");
  const ours = !!cur.s && prev?.shipmentId === cur.s.id;

  if (cur.s && LIVE_LABEL.includes(cur.s.status))
    return ours
      ? done(cur.s.id, "labeled", null, cur.postage)
      : done(cur.s.id, "skipped", "already labeled");

  if (cur.s?.status === "buying") {
    // A buy is in flight or was cut off (possibly by a crash of this job): wait out the
    // in-flight window, then buyLabel reads the carrier back and never buys twice.
    const at = cur.s.buyAttemptedAt?.getTime() ?? null;
    if (at !== null && Date.now() - at < BUY_IN_FLIGHT_MS)
      return { kind: "in_flight", until: at + BUY_IN_FLIGHT_MS };
    if (!cur.s.selectedRateId) return done(cur.s.id, "failed", "No rate recorded for the buy");
    const shipment = await buyLabel(ctx, {
      shipmentId: cur.s.id,
      rateId: cur.s.selectedRateId,
    });
    if (!ours) return done(shipment.id, "skipped", "already labeled");
    return done(shipment.id, "labeled", null, shipment.postage);
  }

  const quote = await rateOrder(ctx, {
    orderId,
    packagePresetId: batch.packagePresetId ?? undefined,
  });
  const rate = pickRate(quote.rates, batch.strategy, cur.order.shipBy);
  if (!rate) throw upstream("carrier", "no rate");
  // Claim the shipment before buying, so a restarted run knows the label is this batch's.
  await saveResult(ctx.companyId, jobId, orderId, {
    shipmentId: quote.shipmentId,
    status: "buying",
    error: null,
    postage: 0,
  });
  const shipment = await buyLabel(ctx, { shipmentId: quote.shipmentId, rateId: rate.rateId });
  return done(shipment.id, "labeled", null, shipment.postage);
}

function done(
  shipmentId: string | null,
  status: OrderResult["status"],
  error: string | null,
  postage = 0,
): Step {
  return { kind: "done", result: { shipmentId, status, error, postage } };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Worker body: every order once, resumable; the row's `results` is the progress record. */
export async function runBatchBuy(companyId: string, jobId: string) {
  const [row] = await withTenant(companyId, (tx) =>
    tx.select().from(jobs).where(eq(jobs.id, jobId)).limit(1),
  );
  if (!row || row.status === "done" || row.status === "failed") return { skipped: true };
  const ctx: TenantContext = { ...systemContext(companyId), userId: row.createdBy };
  let batch = row.input as BatchInput;
  const total = batch.orderIds.length;
  const finished = () =>
    batch.orderIds.filter((id) => {
      const r = batch.results[id];
      return r && r.status !== "buying";
    }).length;
  await updateJobRow(companyId, jobId, {
    status: "running",
    progress: finished() / total,
    message: `Buying ${total} labels`,
  });

  const attempt = async (orderId: string): Promise<Step> => {
    try {
      return await buyOne(ctx, jobId, orderId, batch);
    } catch (err) {
      const message = String(errorData(err).error);
      log.warn("batch label failed", { companyId, jobId, orderId, error: message });
      const prev = batch.results[orderId];
      return done(prev?.shipmentId ?? null, "failed", message);
    }
  };
  const record = async (orderId: string, step: Extract<Step, { kind: "done" }>) => {
    await saveResult(companyId, jobId, orderId, step.result);
    batch = { ...batch, results: { ...batch.results, [orderId]: step.result } };
  };

  const waiting = new Map<string, number>();
  for (const orderId of batch.orderIds) {
    const prev = batch.results[orderId];
    if (prev && prev.status !== "buying") continue;
    // `buyOne` may have saved a `buying` claim; re-read it before the next order.
    const step = await attempt(orderId);
    const [fresh] = await withTenant(companyId, (tx) =>
      tx.select({ input: jobs.input }).from(jobs).where(eq(jobs.id, jobId)).limit(1),
    );
    if (fresh) batch = fresh.input as BatchInput;
    if (step.kind === "in_flight") waiting.set(orderId, step.until);
    else await record(orderId, step);
    const n = finished();
    if (n % 5 === 0 || n === total)
      await updateJobRow(companyId, jobId, {
        progress: n / total,
        message: `Bought ${n} of ${total} labels`,
      });
  }

  // Buys cut off by a crash: finish them once their in-flight window has passed.
  for (const [orderId, until] of waiting) {
    let step: Step = { kind: "in_flight", until };
    for (let tries = 0; step.kind === "in_flight" && tries < 3; tries++) {
      await sleep(Math.max(0, step.until - Date.now()) + 1_000);
      step = await attempt(orderId);
    }
    await record(
      orderId,
      step.kind === "done"
        ? step
        : {
            kind: "done",
            result: {
              shipmentId: batch.results[orderId]?.shipmentId ?? null,
              status: "failed",
              error: "The label is still being bought. Check the order in a minute.",
              postage: 0,
            },
          },
    );
  }

  // The row is the record (a duplicate run may have written it too); summarise from it.
  const [latest] = await withTenant(companyId, (tx) =>
    tx.select({ input: jobs.input }).from(jobs).where(eq(jobs.id, jobId)).limit(1),
  );
  if (latest) batch = latest.input as BatchInput;
  const results = batch.orderIds.map(
    (orderId): OrderResult =>
      batch.results[orderId] ?? {
        shipmentId: null,
        status: "failed",
        error: "not processed",
        postage: 0,
      },
  );
  const labeled = results.filter((r) => r.status === "labeled");
  const failed = results.filter((r) => r.status === "failed").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  const postage = labeled.reduce((s, r) => s + r.postage, 0);
  await updateJobRow(companyId, jobId, {
    status: "done",
    progress: 1,
    message: `${labeled.length} labeled, ${failed} failed${skipped ? `, ${skipped} skipped` : ""}; postage $${(postage / 100).toFixed(2)}`,
    resultIds: labeled.flatMap((r) => (r.shipmentId ? [r.shipmentId] : [])),
  });
  return { labeled: labeled.length, failed, skipped };
}

export const batchBuyJob = defineJob({
  queue: "ship",
  name: "shipping.batchBuy",
  input: z.object({ companyId: z.uuid(), jobId: z.uuid() }),
  jobId: (i) => `batch-labels-${i.jobId}`,
  options: { attempts: 3, backoff: RETRY_BACKOFF },
  handler: async ({ companyId, jobId }, job) => {
    try {
      return await runBatchBuy(companyId, jobId);
    } catch (err) {
      const final = isFinalAttempt(job);
      log.error("batch buy run failed", { companyId, jobId, final, ...errorData(err) });
      if (final)
        await updateJobRow(companyId, jobId, {
          status: "failed",
          progress: 1,
          error: String(errorData(err).error),
        });
      throw err;
    }
  },
});

onEvent("shipping.batch_requested", batchBuyJob, (e) => ({
  companyId: e.companyId,
  jobId: String(e.payload.jobId),
}));
