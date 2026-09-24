import { eq } from "drizzle-orm";
import { z } from "zod";
import { systemContext } from "../../api/context";
import { withSystem, withTenant } from "../../db/client";
import { companies } from "../../db/schema";
import { env } from "../../env";
import { errorData, logger } from "../../lib/log";
import { emit } from "../../lib/outbox";
import { defineJob, onEvent, queues } from "../../lib/queues";
import { RECOMPUTE_DEFAULT_DAYS, recomputeProfit, setJobState } from "./service";

const log = logger("finance.jobs");
const DAY = 86400_000;

/*
 * finance.recompute rematerializes profit_lines for a set of orders or a placed-at range.
 * Triggered by shipping/cancel/label events, cost-setting and ad-spend changes, the
 * `finance.recompute` procedure (with a `jobs` row for progress) and nightly for every shop.
 */

export const recomputeJob = defineJob({
  queue: "reports",
  name: "finance.recompute",
  input: z.object({
    companyId: z.uuid(),
    orderIds: z.array(z.uuid()).optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    /** `jobs` row to report progress on (manual recomputes). */
    jobRowId: z.uuid().optional(),
  }),
  jobId: (i) =>
    i.jobRowId
      ? `profit-recompute:${i.jobRowId}`
      : i.orderIds?.length === 1
        ? `profit-order:${i.orderIds[0]}:${Date.now()}`
        : `profit-range:${i.companyId}:${i.from ?? ""}:${i.to ?? ""}`,
  handler: async ({ companyId, orderIds, from, to, jobRowId }) => {
    const ctx = systemContext(companyId);
    if (jobRowId) {
      await withTenant(companyId, (tx) =>
        setJobState(tx, companyId, jobRowId, {
          status: "running",
          progress: 0,
          message: "Computing",
        }),
      );
    }
    try {
      const result = await withTenant(companyId, async (tx) => {
        const r = await recomputeProfit(tx, ctx, {
          orderIds,
          from: from ? new Date(from) : undefined,
          to: to ? new Date(to) : undefined,
        });
        if (r.orderIds.length) {
          await emit(tx, companyId, "profit.recomputed", {
            orderIds: r.orderIds,
            jobId: jobRowId ?? null,
          });
        }
        if (jobRowId) {
          await setJobState(tx, companyId, jobRowId, {
            status: "done",
            message: `${r.orderIds.length} orders, ${r.lines} lines`,
          });
        }
        return r;
      });
      return { orders: result.orderIds.length, lines: result.lines };
    } catch (err) {
      if (jobRowId) {
        await withTenant(companyId, (tx) =>
          setJobState(tx, companyId, jobRowId, {
            status: "failed",
            error: (err as Error).message,
            message: "Failed",
          }),
        ).catch(() => {});
      }
      throw err;
    }
  },
});

const one = (companyId: string, orderId: unknown) =>
  typeof orderId === "string" ? { companyId, orderIds: [orderId] } : null;

onEvent("item.state_changed", recomputeJob, (e) =>
  ["shipped", "delivered", "cancelled"].includes(String(e.payload.to))
    ? one(e.companyId, e.payload.orderId)
    : null,
);
onEvent("order.cancelled", recomputeJob, (e) => one(e.companyId, e.payload.orderId));
onEvent("shipment.labeled", recomputeJob, (e) => one(e.companyId, e.payload.orderId));
onEvent("shipment.voided", recomputeJob, (e) => one(e.companyId, e.payload.orderId));
onEvent("cost_settings.changed", recomputeJob, (e) => ({
  companyId: e.companyId,
  from: new Date(Date.now() - RECOMPUTE_DEFAULT_DAYS * DAY).toISOString(),
  to: new Date(Date.now() + DAY).toISOString(),
}));
onEvent("finance.ad_spend_changed", recomputeJob, (e) => ({
  companyId: e.companyId,
  // ad spend days are local dates: pad a day on both sides for the timezone
  from: new Date(new Date(`${String(e.payload.from)}T00:00:00Z`).getTime() - DAY).toISOString(),
  to: new Date(new Date(`${String(e.payload.to)}T00:00:00Z`).getTime() + 2 * DAY).toISOString(),
}));

/** Nightly: recompute the last 45 days for every shop (labels, fees and ads settle late). */
export const nightlyJob = defineJob({
  queue: "reports",
  name: "finance.nightly",
  input: z.object({}),
  handler: async () => {
    const shops = await withSystem((tx) =>
      tx.select({ id: companies.id }).from(companies).where(eq(companies.type, "shop")),
    );
    const day = new Date().toISOString().slice(0, 10);
    for (const s of shops) {
      await recomputeJob.enqueue(
        {
          companyId: s.id,
          from: new Date(Date.now() - 45 * DAY).toISOString(),
          to: new Date(Date.now() + DAY).toISOString(),
        },
        { jobId: `profit-nightly:${s.id}:${day}` },
      );
    }
    return { shops: shops.length };
  },
});

/** Idempotent: registers the 03:15 UTC nightly scheduler (safe from API and worker). */
export async function scheduleFinanceJobs() {
  await queues.reports.upsertJobScheduler(
    "finance-nightly",
    { pattern: "15 3 * * *" },
    { name: nightlyJob.name, data: {} },
  );
}

if (!env.isTest) {
  scheduleFinanceJobs().catch((err) =>
    log.warn("could not register the nightly profit scheduler", errorData(err)),
  );
}
