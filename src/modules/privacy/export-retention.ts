import { and, eq, lt } from "drizzle-orm";
import { withSystem, withTenant } from "../../db/client";
import { companies, files } from "../../db/schema";
import { errorData, logger } from "../../lib/log";
import { deleteObject, isCompanyKey, listKeysOlderThan } from "../../lib/s3";
import { forgetFiles } from "../files/service";
import { exportKey } from "./service";

const log = logger("privacy.export-retention");

/*
 * Whole-company export zips hold buyer text, so they expire (decision 0033, T-31-5): a zip older
 * than 7 days is deleted, object first, then its `files` row. Zips no row points at (an export
 * that uploaded and then failed before its row was written) are found by listing the prefix.
 */

/** A zip is kept for exactly this long; one second older and the nightly sweep deletes it. */
export const EXPORT_RETENTION_DAYS = 7;
const DAY = 86400_000;

export type ExportExpiry = {
  /** Export zips deleted (with their `files` row when one existed). */
  exportsDeleted: number;
  /** Zips whose delete failed: object and row wait for the next run. */
  exportsFailed: number;
};

const fileIdOf = (key: string) => key.slice(key.lastIndexOf("/") + 1).replace(/\.zip$/, "");

/**
 * One company. Rows: `kind = 'export'` whose key is exactly `exportKey(companyId, id)`, aged by
 * `files.createdAt`. Then every object under `{companyId}/tenant-export/` last modified more than
 * 7 days ago. Idempotent: a second run finds nothing.
 */
export async function expireTenantExports(
  companyId: string,
  now = new Date(),
): Promise<ExportExpiry> {
  const cutoff = new Date(now.getTime() - EXPORT_RETENTION_DAYS * DAY);
  const res: ExportExpiry = { exportsDeleted: 0, exportsFailed: 0 };

  const rows = await withTenant(companyId, (tx) =>
    tx
      .select({ id: files.id, key: files.key })
      .from(files)
      .where(
        and(eq(files.companyId, companyId), eq(files.kind, "export"), lt(files.createdAt, cutoff)),
      ),
  );
  const gone: string[] = [];
  const failed = new Set<string>();
  for (const r of rows) {
    if (r.key !== exportKey(companyId, r.id) || !isCompanyKey(companyId, r.key)) continue;
    try {
      await deleteObject(r.key);
      gone.push(r.key);
    } catch (err) {
      failed.add(r.key);
      res.exportsFailed++;
      log.warn("export zip delete failed; it waits for the next run", {
        companyId,
        fileId: r.id,
        ...errorData(err),
      });
    }
  }

  const unlisted: string[] = [];
  for (const key of await listKeysOlderThan(`${companyId}/tenant-export/`, cutoff)) {
    if (failed.has(key) || gone.includes(key) || !isCompanyKey(companyId, key)) continue;
    try {
      await deleteObject(key);
      unlisted.push(key);
    } catch (err) {
      res.exportsFailed++;
      log.warn("export zip delete failed; it waits for the next run", {
        companyId,
        fileId: fileIdOf(key),
        ...errorData(err),
      });
    }
  }

  // Object first, then row: a row pointing at an unlisted old zip goes with it.
  const deleted = [...gone, ...unlisted];
  if (deleted.length) await withTenant(companyId, (tx) => forgetFiles(tx, deleted));
  res.exportsDeleted = deleted.length;
  return res;
}

/** Every company (or `only`), each in its own tenant scope; one failing company never stops the rest. */
export async function expireAllTenantExports(
  now = new Date(),
  only?: string[],
): Promise<ExportExpiry & { failedCompanies: number }> {
  const ids =
    only ??
    // withSystem: cross-tenant job, reads company ids only; each company's work runs in withTenant.
    (await withSystem((tx) => tx.select({ id: companies.id }).from(companies))).map((c) => c.id);
  const res = { exportsDeleted: 0, exportsFailed: 0, failedCompanies: 0 };
  for (const companyId of ids) {
    try {
      const r = await expireTenantExports(companyId, now);
      res.exportsDeleted += r.exportsDeleted;
      res.exportsFailed += r.exportsFailed;
    } catch (err) {
      res.failedCompanies++;
      log.error("export expiry failed for a company", { companyId, ...errorData(err) });
    }
  }
  return res;
}
