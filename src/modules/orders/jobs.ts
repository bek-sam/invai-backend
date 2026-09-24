import { and, eq, inArray, isNotNull, isNull, lt, or } from "drizzle-orm";
import { z } from "zod";
import { withSystem, withTenant } from "../../db/client";
import { buyerPii, companies, orders } from "../../db/schema";
import { env } from "../../env";
import { errorData, logger } from "../../lib/log";
import { defineJob, queues } from "../../lib/queues";
import { deleteObject, listKeysOlderThan } from "../../lib/s3";
import { forgetFiles } from "../files/service";

const log = logger("orders.jobs");

export const PII_RETENTION_DAYS = 30;

/**
 * Buyer PII purge (cross-tenant): deletes `buyer_pii` rows 30 days after delivery (or after
 * shipping/cancelling when no delivery event arrives, or past an explicit `purgeAfter`) and the raw channel payload archive of those orders. The order keeps
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
            or(
              lt(orders.deliveredAt, cutoff),
              // No delivery event ever arrives for CSV channels or lost tracking: 30 days after
              // shipping (or cancelling) is the fallback, so no order keeps PII forever.
              and(isNull(orders.deliveredAt), lt(orders.shippedAt, cutoff)),
              lt(orders.cancelledAt, cutoff),
            ),
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

/** Object kinds that carry buyer data: raw channel payloads, uploaded order CSVs, label PDFs. */
export const PII_OBJECT_KINDS = ["raw", "csv", "label"] as const;

/**
 * Retention sweep for S3 (cross-tenant): objects of the PII kinds older than 30 days are
 * deleted under every company prefix (`{companyId}/{kind}/...`), and their `files` rows go too.
 * This also catches merged batch-label PDFs and CSVs that no table points at.
 */
export async function purgePiiObjects(now = new Date(), only?: string[]) {
  const cutoff = new Date(now.getTime() - PII_RETENTION_DAYS * 86400_000);
  const companyIds = only
    ? only.map((id) => ({ id }))
    : await withSystem((tx) => tx.select({ id: companies.id }).from(companies));
  let deleted = 0;
  for (const { id } of companyIds) {
    const keys: string[] = [];
    for (const kind of PII_OBJECT_KINDS)
      keys.push(...(await listKeysOlderThan(`${id}/${kind}/`, cutoff)));
    for (const key of keys) {
      try {
        await deleteObject(key);
        deleted++;
      } catch (err) {
        log.warn("PII object delete failed", { key, ...errorData(err) });
      }
    }
    if (keys.length) await withTenant(id, (tx) => forgetFiles(tx, keys));
  }
  return { objects: deleted };
}

export const purgeBuyerPiiJob = defineJob({
  queue: "reports",
  name: "orders.purgeBuyerPii",
  input: z.object({}).passthrough(),
  handler: async () => {
    const res = { ...(await purgeBuyerPii()), ...(await purgePiiObjects()) };
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
