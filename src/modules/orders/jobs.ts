import { and, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { withSystem, withTenant } from "../../db/client";
import { buyerPii, companies, orders } from "../../db/schema";
import { env } from "../../env";
import { errorData, logger } from "../../lib/log";
import { defineJob, queues } from "../../lib/queues";
import { deleteObject, listKeysOlderThan } from "../../lib/s3";
import { forgetFiles } from "../files/service";
import { holdsBuyerText, redactBuyerText } from "../privacy/service";

const log = logger("orders.jobs");

export const PII_RETENTION_DAYS = 30;

const PURGE_BATCH = 500;

export type BuyerPiiPurge = {
  orders: number;
  /** `buyer_pii` rows deleted. */
  purged: number;
  payloads: number;
  personalizedItems: number;
  artwork: number;
  notes: number;
  files: number;
  failedFiles: number;
  failedCompanies: number;
};

/**
 * Buyer PII purge (cross-tenant), nightly. An order is due 30 days after delivery (or after
 * shipping/cancelling when no delivery event arrives, or past an explicit `buyer_pii.purge_after`)
 * while it still holds something personal: its `buyer_pii` row, the raw channel payload, or
 * buyer text (`holdsBuyerText`, decision 0027). Orders whose `buyer_pii` went in an earlier run
 * are found by their own dates. Per due order: the `buyer_pii` row, the raw payload object, the
 * free-text notes, and for each unit already shipped, delivered or cancelled its personalization
 * text and artwork (`redactBuyerText`, scope `shipped-items`); units still in production keep
 * theirs until a later night. Storage first: a payload or artwork object whose delete failed keeps
 * its key for the next night. Order facts (items, totals, states, profit) stay.
 */
export async function purgeBuyerPii(now = new Date()): Promise<BuyerPiiPurge> {
  const cutoff = new Date(now.getTime() - PII_RETENTION_DAYS * 86400_000);
  const nowTs = sql`${now.toISOString()}::timestamptz`;
  const clockPassed = or(
    sql`exists (select 1 from buyer_pii b where b.company_id = ${orders.companyId}
      and b.order_id = ${orders.id} and b.purge_after is not null and b.purge_after < ${nowTs})`,
    and(
      sql`not exists (select 1 from buyer_pii b where b.company_id = ${orders.companyId}
        and b.order_id = ${orders.id} and b.purge_after is not null)`,
      or(
        lt(orders.deliveredAt, cutoff),
        // No delivery event ever arrives for CSV channels or lost tracking: 30 days after
        // shipping (or cancelling) is the fallback, so no order keeps PII forever.
        and(isNull(orders.deliveredAt), lt(orders.shippedAt, cutoff)),
        lt(orders.cancelledAt, cutoff),
      ),
    ),
  );
  const unredacted = or(
    sql`exists (select 1 from buyer_pii b where b.company_id = ${orders.companyId}
      and b.order_id = ${orders.id})`,
    isNotNull(orders.rawPayloadKey),
    holdsBuyerText("shipped-items"),
  );
  // withSystem: cross-tenant job, reads order and company ids only; every change runs in withTenant.
  const due = await withSystem((tx) =>
    tx
      .select({ orderId: orders.id, companyId: orders.companyId, rawKey: orders.rawPayloadKey })
      .from(orders)
      .where(and(clockPassed, unredacted))
      .orderBy(orders.companyId, orders.id),
  );
  const res: BuyerPiiPurge = {
    orders: 0,
    purged: 0,
    payloads: 0,
    personalizedItems: 0,
    artwork: 0,
    notes: 0,
    files: 0,
    failedFiles: 0,
    failedCompanies: 0,
  };
  const byCompany = new Map<string, typeof due>();
  for (const d of due) byCompany.set(d.companyId, [...(byCompany.get(d.companyId) ?? []), d]);
  for (const [companyId, list] of byCompany) {
    try {
      for (let i = 0; i < list.length; i += PURGE_BATCH) {
        const batch = list.slice(i, i + PURGE_BATCH);
        // Storage first: a payload whose delete failed keeps its key for the next night.
        const payloadGone: string[] = [];
        for (const d of batch) {
          if (!d.rawKey) continue;
          try {
            await deleteObject(d.rawKey);
            payloadGone.push(d.orderId);
          } catch (err) {
            log.warn("raw payload delete failed", {
              companyId,
              orderId: d.orderId,
              ...errorData(err),
            });
          }
        }
        await withTenant(companyId, async (tx) => {
          const ids = batch.map((d) => d.orderId);
          const pii = await tx
            .delete(buyerPii)
            .where(inArray(buyerPii.orderId, ids))
            .returning({ id: buyerPii.id });
          if (payloadGone.length)
            await tx
              .update(orders)
              .set({ rawPayloadKey: null })
              .where(inArray(orders.id, payloadGone));
          const text = await redactBuyerText(tx, ids, { scope: "shipped-items" });
          res.orders += ids.length;
          res.purged += pii.length;
          res.payloads += payloadGone.length;
          res.personalizedItems += text.personalizedItems;
          res.artwork += text.artwork;
          res.notes += text.notes;
          res.files += text.files.length;
          res.failedFiles += text.failedFiles.length;
        });
      }
    } catch (err) {
      res.failedCompanies++;
      log.error("buyer PII purge failed for a company", { companyId, ...errorData(err) });
    }
  }
  return res;
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
