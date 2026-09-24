import { and, eq, inArray, isNotNull, isNull, lt, or } from "drizzle-orm";
import { z } from "zod";
import { withSystem } from "../../db/client";
import { buyerPii, orders } from "../../db/schema";
import { env } from "../../env";
import { errorData, logger } from "../../lib/log";
import { defineJob, queues } from "../../lib/queues";
import { deleteObject } from "../../lib/s3";

const log = logger("orders.jobs");

export const PII_RETENTION_DAYS = 30;

/**
 * Buyer PII purge (cross-tenant): deletes `buyer_pii` rows 30 days after delivery (or past an
 * explicit `purgeAfter`) and the raw channel payload archive of those orders. The order keeps
 * everything that is not personal (items, totals, states, profit).
 */
export async function purgeBuyerPii(now = new Date()) {
  const cutoff = new Date(now.getTime() - PII_RETENTION_DAYS * 86400_000);
  const due = await withSystem((tx) =>
    tx
      .select({ piiId: buyerPii.id, orderId: orders.id, rawKey: orders.rawPayloadKey })
      .from(buyerPii)
      .innerJoin(orders, eq(orders.id, buyerPii.orderId))
      .where(
        or(
          and(isNotNull(buyerPii.purgeAfter), lt(buyerPii.purgeAfter, now)),
          and(
            isNull(buyerPii.purgeAfter),
            isNotNull(orders.deliveredAt),
            lt(orders.deliveredAt, cutoff),
          ),
        ),
      ),
  );
  if (due.length === 0) return { purged: 0, payloads: 0 };
  let payloads = 0;
  for (const d of due) {
    if (!d.rawKey) continue;
    try {
      await deleteObject(d.rawKey);
      payloads++;
    } catch (err) {
      log.warn("raw payload delete failed", { orderId: d.orderId, ...errorData(err) });
    }
  }
  await withSystem(async (tx) => {
    await tx.delete(buyerPii).where(
      inArray(
        buyerPii.id,
        due.map((d) => d.piiId),
      ),
    );
    await tx
      .update(orders)
      .set({ rawPayloadKey: null })
      .where(
        inArray(
          orders.id,
          due.map((d) => d.orderId),
        ),
      );
  });
  return { purged: due.length, payloads };
}

export const purgeBuyerPiiJob = defineJob({
  queue: "reports",
  name: "orders.purgeBuyerPii",
  input: z.object({}).passthrough(),
  handler: async () => {
    const res = await purgeBuyerPii();
    log.info("buyer PII purge", res);
    return res;
  },
});

/** Idempotent: nightly at 04:30 UTC. */
export async function schedulePiiPurge() {
  await queues.reports.upsertJobScheduler(
    "orders-pii-purge",
    { pattern: "30 4 * * *", tz: "UTC" },
    { name: purgeBuyerPiiJob.name, data: {} },
  );
}

if (!env.isTest) {
  schedulePiiPurge().catch((err) =>
    log.warn("could not register the PII purge scheduler", errorData(err)),
  );
}
