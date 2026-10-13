import { and, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { withSystem, withTenant } from "../../db/client";
import { buyerPii, companies, orderItems, orders } from "../../db/schema";
import { env } from "../../env";
import { ImagingError, imaging } from "../../integrations/imaging/client";
import { sha256Hex } from "../../lib/crypto";
import { errorData, logger } from "../../lib/log";
import { emit } from "../../lib/outbox";
import { defineJob, isPermanentHttpStatus, queues, safeJobId } from "../../lib/queues";
import { deleteObject, listKeysOlderThan } from "../../lib/s3";
import {
  artworkQaFlags,
  isImagingBusy,
  QA_NO_BUSY,
  redelayQa,
  takeQaTurn,
} from "../catalog/qa-turn";
import { forgetFiles } from "../files/service";
import {
  companiesWithPurgedSheets,
  purgeSheetFiles,
  sweepOrphanRenders,
} from "../privacy/print-files";
import { holdsBuyerText, redactBuyerText } from "../privacy/service";
import { ARTWORK_ITEM_FLAGS, withFlags } from "./flags";

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
  /** Object deletes that failed (units and sheets wait for the next night). */
  failedFiles: number;
  failedCompanies: number;
  /** Buyer photos kept because another unit still uses them (S-59). */
  sharedPhotosKept: number;
  /** Gang sheets whose print files were deleted after a unit on them was purged (decision 0031). */
  sheetFilesPurged: number;
  /** Sheets holding a purged unit that are still in production; their files wait. */
  sheetsWaiting: number;
  /** Age in days of the oldest waiting sheet, null when none waits. */
  oldestSheetWaitingDays: number | null;
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
    sharedPhotosKept: 0,
    sheetFilesPurged: 0,
    sheetsWaiting: 0,
    oldestSheetWaitingDays: null,
  };
  const failed = new Set<string>();
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
          res.sharedPhotosKept += text.sharedPhotosKept;
        });
      }
    } catch (err) {
      failed.add(companyId);
      log.error("buyer PII purge failed for a company", { companyId, ...errorData(err) });
    }
  }
  // After the unit purge, so a unit purged tonight frees its sheet tonight (decision 0031).
  for (const companyId of await companiesWithPurgedSheets()) {
    try {
      const s = await purgeSheetFiles(companyId, now);
      res.sheetFilesPurged += s.sheetFilesPurged;
      res.sheetsWaiting += s.sheetsWaiting;
      res.failedFiles += s.failedSheets;
      if (s.oldestSheetWaitingDays !== null)
        res.oldestSheetWaitingDays = Math.max(
          res.oldestSheetWaitingDays ?? 0,
          s.oldestSheetWaitingDays,
        );
    } catch (err) {
      failed.add(companyId);
      log.error("sheet file purge failed for a company", { companyId, ...errorData(err) });
    }
  }
  res.failedCompanies = failed.size;
  return res;
}

/**
 * Object kinds that carry buyer data: raw channel payloads, uploaded order CSVs, label PDFs.
 * `sheet`, `preview`, `artwork`, `photo` and `design` never join: this sweep deletes by age
 * alone and would remove the files of `ready` sheets and catalog previews. Those follow the
 * unit clocks (`redactBuyerText`, `purgeSheetFiles`) and the orphan sweep (decision 0031).
 */
export const PII_OBJECT_KINDS = ["raw", "csv", "label"] as const;

/**
 * Retention sweep for S3 (cross-tenant): objects of the PII kinds older than 30 days are
 * deleted under every company prefix (`{companyId}/{kind}/...`), and their `files` rows go too.
 * This also catches merged batch-label PDFs and CSVs that no table points at. Then renders,
 * sheet files and previews older than 2 days that no row points at go (`sweepOrphanRenders`).
 */
export async function purgePiiObjects(now = new Date(), only?: string[]) {
  const cutoff = new Date(now.getTime() - PII_RETENTION_DAYS * 86400_000);
  const companyIds = only
    ? only.map((id) => ({ id }))
    : await withSystem((tx) => tx.select({ id: companies.id }).from(companies));
  let deleted = 0;
  let orphanRendersDeleted = 0;
  let orphanRendersFailed = 0;
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
    try {
      const o = await sweepOrphanRenders(id, now);
      orphanRendersDeleted += o.orphanRendersDeleted;
      orphanRendersFailed += o.orphanRendersFailed;
    } catch (err) {
      orphanRendersFailed++;
      log.error("orphan render sweep failed for a company", { companyId: id, ...errorData(err) });
    }
  }
  return { objects: deleted, orphanRendersDeleted, orphanRendersFailed };
}

/** The states in which `setItemArtwork` accepts artwork; the follow-up uses the same guard. */
const ARTWORK_QA_STATES = ["imported", "needs_mapping", "ready", "needs_artwork", "on_hold"];

const ARTWORK_QA_DOWN_RETRY_MS = 30_000;

/**
 * Follow-up QA for artwork attached while imaging could not answer (T-43-3, S-76 / B-399).
 * Applies the same flags `setItemArtwork` would have, only if the unit still has this exact
 * `artworkKey` and is still in an artwork-editable state (not `on_sheet` or later). The jobId
 * is the item plus the file, so a re-upload of another file is its own job. Never sleeps on a
 * busy imaging slot: it re-delays itself.
 */
export const itemArtworkQaJob = defineJob({
  queue: "render",
  name: "orders.itemArtworkQa",
  input: z.object({ companyId: z.uuid(), itemId: z.uuid(), fileKey: z.string().min(1) }),
  jobId: (i) => `artwork-qa-${i.itemId}-${sha256Hex(i.fileKey).slice(0, 16)}`,
  handler: async ({ companyId, itemId, fileKey }, job) => {
    const row = await withTenant(companyId, async (tx) => {
      const [r] = await tx.select().from(orderItems).where(eq(orderItems.id, itemId)).limit(1);
      return r;
    });
    if (!row || row.artworkKey !== fileKey || !ARTWORK_QA_STATES.includes(row.state))
      return { skipped: true };
    const ctx = { companyId, what: "item", id: itemId };
    // Imaging down or unreachable is waiting, not failing: re-delay with the same 30-minute bound
    // as a busy slot, so a restart of a few minutes never drops the flags (B-399, round 2).
    if (!(await imaging.isUp())) {
      log.warn("imaging down, artwork QA deferred", { companyId, itemId });
      return await redelayQa(job, ARTWORK_QA_DOWN_RETRY_MS, ctx);
    }
    const turn = await takeQaTurn(companyId);
    if (!turn.ok) return await redelayQa(job, turn.retryAfterMs, ctx);
    let flags: ReturnType<typeof artworkQaFlags>;
    try {
      const qa = await imaging.qaCheck(
        {
          file_key: fileKey,
          target_width_in: row.printWidthIn ?? undefined,
          target_height_in: row.printHeightIn ?? undefined,
        },
        QA_NO_BUSY,
      );
      flags = artworkQaFlags(qa.issues);
    } catch (err) {
      if (isImagingBusy(err)) return await redelayQa(job, err.retryAfterMs ?? 5_000, ctx);
      if (err instanceof ImagingError && isPermanentHttpStatus(err.status)) {
        log.warn("imaging rejected the artwork; no QA flags", {
          companyId,
          itemId,
          status: err.status,
        });
        return { skipped: true };
      }
      if (err instanceof ImagingError) {
        // 5xx or a connection/timeout error mid-call: imaging went away after the health check.
        log.warn("imaging unreachable, artwork QA deferred", { companyId, itemId });
        return await redelayQa(job, ARTWORK_QA_DOWN_RETRY_MS, ctx);
      }
      throw err;
    } finally {
      await turn.release();
    }
    return withTenant(companyId, async (tx) => {
      const [locked] = await tx
        .select()
        .from(orderItems)
        .where(eq(orderItems.id, itemId))
        .for("update");
      if (!locked || locked.artworkKey !== fileKey || !ARTWORK_QA_STATES.includes(locked.state))
        return { skipped: true };
      await tx
        .update(orderItems)
        .set({ flags: withFlags(locked.flags, flags, [...ARTWORK_ITEM_FLAGS, "artwork_low_dpi"]) })
        .where(eq(orderItems.id, itemId));
      await emit(tx, companyId, "order.updated", { orderId: locked.orderId });
      return { flags: flags.length };
    });
  },
});

/**
 * Queue the follow-up for this item and file. BullMQ keeps a finished job's id (24 h completed,
 * 7 days failed), which would turn a second attach of the same still-unchecked file into a no-op
 * after a give-up, so a finished job with this id is removed first. A waiting, delayed or active
 * one is left alone: that is the dedupe.
 */
export async function enqueueItemArtworkQa(input: {
  companyId: string;
  itemId: string;
  fileKey: string;
}) {
  const id = safeJobId(itemArtworkQaJob.jobId?.(input) ?? "");
  const old = await queues.render.getJob(id);
  if (old) {
    const state = await old.getState();
    if (state === "completed" || state === "failed") await old.remove();
  }
  return itemArtworkQaJob.enqueue(input);
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
