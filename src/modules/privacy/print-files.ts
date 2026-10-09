import {
  and,
  arrayOverlaps,
  eq,
  getTableColumns,
  gt,
  inArray,
  isNotNull,
  notInArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { type Tx, withSystem, withTenant } from "../../db/client";
import { gangSheets } from "../../db/schema";
import { errorData, logger } from "../../lib/log";
import { deleteObject, isCompanyKey, listKeysOlderThan } from "../../lib/s3";
import { forgetFiles } from "../files/service";
import { tenantTables } from "./service";

const log = logger("privacy.print-files");

/*
 * Print files and orphan renders follow the buyer-text clocks (decision 0031, T-30-1).
 * - A gang sheet that holds a unit whose artwork was purged (any 0027 clock) loses its PNG, PDF
 *   and preview once it has left production; sheets still being made keep theirs.
 * - Renders, sheet files and previews no row points at (a superseded render, a rebuilt sheet, a
 *   compose that lost its race, a template preview) are deleted once they are 2 days old.
 */

/** Sheet states whose files go once a unit on the sheet was purged (decision 0032). */
export const SHEET_FILES_PURGE_STATES = [
  "printed",
  "shipped",
  "received",
  "cancelled",
  "failed",
] as const;

/** A render or compose younger than this may still be in flight: never an orphan. */
export const ORPHAN_MIN_AGE_MS = 2 * 86400_000;

/** Object kinds the orphan sweep covers (`{company}/{kind}/...`); catalog's design previews excluded. */
export const ORPHAN_KINDS = ["artwork", "sheet", "preview"] as const;
const CATALOG_PREVIEW_PREFIX = "preview/design/";

/** Keys per reference query (Postgres allows 65,535 bind parameters). */
export const REF_CHUNK = 1000;
const SHEET_BATCH = 200;
const DAY = 86400_000;

/** A gang sheet (in a `gang_sheets` query) with a unit whose artwork was purged, over all its transfers. */
const holdsPurgedUnit: SQL = sql`exists (select 1 from transfers t
  join order_items i on i.company_id = t.company_id and i.id = t.order_item_id
  where t.company_id = ${gangSheets.companyId} and t.gang_sheet_id = ${gangSheets.id}
    and i.artwork_status = 'purged')`;
const hasFiles = or(
  isNotNull(gangSheets.pngKey),
  isNotNull(gangSheets.pdfKey),
  isNotNull(gangSheets.previewKey),
);

export type SheetFilesPurge = {
  /** Sheets whose print files were deleted and keys cleared. */
  sheetFilesPurged: number;
  /** Sheets holding a purged unit that are still in production (files kept). */
  sheetsWaiting: number;
  /** Age in whole days of the oldest waiting sheet (by creation), null when none waits. */
  oldestSheetWaitingDays: number | null;
  /** Sheets whose object delete failed: keys kept for the next night. */
  failedSheets: number;
};

/** Companies with at least one sheet that still has files and holds a purged unit. */
export async function companiesWithPurgedSheets(): Promise<string[]> {
  // withSystem: cross-tenant job, reads company ids only; each company's work runs in withTenant.
  const rows = await withSystem((tx) =>
    tx
      .selectDistinct({ companyId: gangSheets.companyId })
      .from(gangSheets)
      .where(and(hasFiles, holdsPurgedUnit)),
  );
  return rows.map((r) => r.companyId);
}

/**
 * One company: sheets in SHEET_FILES_PURGE_STATES lose their objects first (storage first), then
 * their three keys and `files` rows. A sheet whose delete failed keeps everything for the next
 * night. Sheets in other states are counted as waiting. Idempotent: a cleared sheet has no keys.
 */
export async function purgeSheetFiles(
  companyId: string,
  now = new Date(),
): Promise<SheetFilesPurge> {
  const res: SheetFilesPurge = {
    sheetFilesPurged: 0,
    sheetsWaiting: 0,
    oldestSheetWaitingDays: null,
    failedSheets: 0,
  };
  const purgeStates = new Set<string>(SHEET_FILES_PURGE_STATES);
  let last: string | undefined;
  for (;;) {
    const more = await withTenant(companyId, async (tx) => {
      const rows = await tx
        .select({
          id: gangSheets.id,
          status: gangSheets.status,
          pngKey: gangSheets.pngKey,
          pdfKey: gangSheets.pdfKey,
          previewKey: gangSheets.previewKey,
          createdAt: gangSheets.createdAt,
        })
        .from(gangSheets)
        .where(and(hasFiles, holdsPurgedUnit, last ? gt(gangSheets.id, last) : undefined))
        .orderBy(gangSheets.id)
        .limit(SHEET_BATCH)
        .for("update");
      if (rows.length === 0) return false;
      last = rows[rows.length - 1]?.id;

      const due = rows.filter((r) => purgeStates.has(r.status));
      for (const r of rows) {
        if (purgeStates.has(r.status)) continue;
        res.sheetsWaiting++;
        const days = Math.floor((now.getTime() - r.createdAt.getTime()) / DAY);
        res.oldestSheetWaitingDays = Math.max(res.oldestSheetWaitingDays ?? 0, days);
      }
      if (due.length === 0) return rows.length === SHEET_BATCH;

      const keysOf = (r: (typeof due)[number]) =>
        [r.pngKey, r.pdfKey, r.previewKey].filter((k): k is string => !!k);
      // A key another sheet still points at keeps its object (that sheet decides for itself).
      const allKeys = due.flatMap(keysOf);
      const shared = new Set<string>();
      for (const col of [gangSheets.pngKey, gangSheets.pdfKey, gangSheets.previewKey]) {
        const others = await tx
          .select({ k: col })
          .from(gangSheets)
          .where(
            and(
              inArray(col, allKeys),
              notInArray(
                gangSheets.id,
                due.map((r) => r.id),
              ),
            ),
          );
        for (const o of others) if (o.k) shared.add(o.k);
      }

      for (const r of due) {
        const keys = keysOf(r);
        let ok = true;
        for (const key of keys) {
          if (shared.has(key) || !isCompanyKey(companyId, key)) continue;
          try {
            await deleteObject(key);
          } catch (err) {
            ok = false;
            log.warn("sheet file delete failed; the sheet waits for the next run", {
              companyId,
              sheetId: r.id,
              ...errorData(err),
            });
            break;
          }
        }
        if (!ok) {
          res.failedSheets++;
          continue;
        }
        await tx
          .update(gangSheets)
          .set({ pngKey: null, pdfKey: null, previewKey: null, updatedAt: now })
          .where(eq(gangSheets.id, r.id));
        await forgetFiles(
          tx,
          keys.filter((k) => !shared.has(k)),
        );
        res.sheetFilesPurged++;
      }
      return rows.length === SHEET_BATCH;
    });
    if (!more) return res;
  }
}

/* ---- Orphan renders ---------------------------------------------------------------------- */

type KeyColumn = { table: string; column: string; col: PgColumn; array: boolean };

const NOT_STORAGE_KEYS = new Set([
  "dedupeKey",
  "idempotencyKey",
  "weekKey",
  "templateKey",
  "planKey",
]);
let keyColumnCache: KeyColumn[] | null = null;

/**
 * Every tenant column that can hold a storage key, found from the schema: text columns named
 * `key` or `*Key`, text arrays named `*Keys`. A column that holds something else only costs a
 * query (it never matches), so the list errs on the side of keeping objects.
 */
export function storageKeyColumns(): KeyColumn[] {
  if (keyColumnCache) return keyColumnCache;
  const out: KeyColumn[] = [];
  for (const t of tenantTables()) {
    const cols = getTableColumns(t.table) as Record<string, PgColumn>;
    for (const [name, col] of Object.entries(cols)) {
      if (NOT_STORAGE_KEYS.has(name)) continue;
      const type = col.getSQLType();
      if (type === "text" && (name === "key" || name.endsWith("Key")))
        out.push({ table: t.name, column: name, col, array: false });
      else if (type === "text[]" && name.endsWith("Keys"))
        out.push({ table: t.name, column: name, col, array: true });
    }
  }
  keyColumnCache = out;
  return out;
}

/** Keys in jsonb columns: a photo slot's value in `item_artwork.values`, a personalization file. */
async function referencedInJson(tx: Tx, keys: string[]): Promise<string[]> {
  const list = sql.join(
    keys.map((k) => sql`${k}`),
    sql`, `,
  );
  const values = await tx.execute<{ k: string }>(sql`select distinct v.value as k
    from item_artwork a cross join lateral jsonb_each_text(
      case when jsonb_typeof(a."values") = 'object' then a."values" else '{}'::jsonb end) v
    where v.value in (${list})`);
  const personalization = await tx.execute<{ k: string }>(sql`select distinct x.k
    from order_items i
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(i.personalization) = 'array' then i.personalization else '[]'::jsonb end) e
    cross join lateral (values (e->>'fileUrl'), (e->>'answer')) x(k)
    where x.k in (${list})`);
  return [...values.rows, ...personalization.rows].map((r) => r.k);
}

/** The subset of `keys` (at most REF_CHUNK) that some row of this tenant points at. */
export async function referencedKeys(tx: Tx, keys: string[]): Promise<Set<string>> {
  if (keys.length > REF_CHUNK) throw new Error(`at most ${REF_CHUNK} keys per reference query`);
  const found = new Set<string>();
  if (keys.length === 0) return found;
  const wanted = new Set(keys);
  for (const c of storageKeyColumns()) {
    const table = tenantTables().find((t) => t.name === c.table)?.table;
    if (!table) continue;
    const rows = await tx
      .select({ k: c.col })
      .from(table)
      .where(c.array ? arrayOverlaps(c.col, keys) : inArray(c.col, keys));
    for (const r of rows) {
      const v = r.k as unknown;
      for (const k of Array.isArray(v) ? v : [v])
        if (typeof k === "string" && wanted.has(k)) found.add(k);
    }
  }
  for (const k of await referencedInJson(tx, keys)) found.add(k);
  return found;
}

export type OrphanSweep = { orphanRendersDeleted: number; orphanRendersFailed: number };

/**
 * One company: objects under `{company}/artwork|sheet|preview/` (not catalog's
 * `preview/design/`) older than ORPHAN_MIN_AGE_MS that no row points at are deleted. Reference
 * checks run in chunks of REF_CHUNK keys inside the tenant. Idempotent.
 */
export async function sweepOrphanRenders(
  companyId: string,
  now = new Date(),
): Promise<OrphanSweep> {
  const before = new Date(now.getTime() - ORPHAN_MIN_AGE_MS);
  const res: OrphanSweep = { orphanRendersDeleted: 0, orphanRendersFailed: 0 };
  const keys: string[] = [];
  for (const kind of ORPHAN_KINDS)
    for (const k of await listKeysOlderThan(`${companyId}/${kind}/`, before))
      if (!k.startsWith(`${companyId}/${CATALOG_PREVIEW_PREFIX}`) && isCompanyKey(companyId, k))
        keys.push(k);
  for (let i = 0; i < keys.length; i += REF_CHUNK) {
    const chunk = keys.slice(i, i + REF_CHUNK);
    const referenced = await withTenant(companyId, (tx) => referencedKeys(tx, chunk));
    for (const key of chunk) {
      if (referenced.has(key)) continue;
      try {
        await deleteObject(key);
        res.orphanRendersDeleted++;
      } catch (err) {
        res.orphanRendersFailed++;
        log.warn("orphan render delete failed", { companyId, ...errorData(err) });
      }
    }
  }
  return res;
}
