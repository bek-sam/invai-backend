import {
  type BATCH_EXCLUSION_REASONS,
  type BatchPreview,
  DEFAULT_SHEET_SPEC,
  type GangSheet,
  type GangSheetDetail,
  SHEET_TRANSITIONS,
  type SheetPlacement,
  type SheetState,
} from "@invai/contracts";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  like,
  lte,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { TenantContext } from "../../api/context";
import { afterCommit, type Tx, withTenant } from "../../db/client";
import type { SheetSpec } from "../../db/schema";
import {
  companies,
  designFiles,
  gangSheetBatches,
  gangSheets,
  orderItems,
  reprints,
  transfers,
  vendorAccess,
  vendorConnections,
} from "../../db/schema";
import { ImagingError, imaging, type NestResult } from "../../integrations/imaging/client";
import { type Actor, audit } from "../../lib/audit";
import { badRequest, invalidTransition, notFound, ORPCError } from "../../lib/errors";
import { logger } from "../../lib/log";
import { emit } from "../../lib/outbox";
import { keyset, type PageInput } from "../../lib/pagination";
import { publish } from "../../lib/realtime";
import { headObject, objectKey, presignGet } from "../../lib/s3";
import { transitionItem } from "../orders/state-machine";
import { createJobRow, updateJobRow } from "./job-rows";
import { type ItemView, loadItemViews, placementOf, toOrderItem } from "./views";

const log = logger("production.sheets");

/*
 * Gang sheets: pick eligible `ready` items (rush first, by ship-by), nest them with imaging
 * `/nest` to the vendor's spec, compose each sheet with `/compose`, then move the items
 * ready -> on_sheet. A sheet's transfers are the QR-coded copies the floor scans later.
 */

type SheetRow = typeof gangSheets.$inferSelect;
type TransferRow = typeof transfers.$inferSelect;
type ExclusionReason = (typeof BATCH_EXCLUSION_REASONS)[number];

export const LABEL_HEIGHT_IN = 0.42;
/** Top-edge sheet-id header band (B-79); nesting starts placements below it, not just margin_in. */
export const HEADER_HEIGHT_IN = 0.45;

/* --------------------------------- specs ---------------------------------- */

export type VendorChoice = {
  id: string | null;
  name: string | null;
  spec: SheetSpec;
};

/** The vendor connection a batch goes to (explicit or the default) and its sheet spec. */
export async function resolveVendor(
  tx: Tx,
  vendorConnectionId: string | null,
): Promise<VendorChoice> {
  const [row] = vendorConnectionId
    ? await tx
        .select()
        .from(vendorConnections)
        .where(eq(vendorConnections.id, vendorConnectionId))
        .limit(1)
    : await tx
        .select()
        .from(vendorConnections)
        .where(sql`${vendorConnections.status} <> 'paused'`)
        .orderBy(desc(vendorConnections.isDefault), asc(vendorConnections.createdAt))
        .limit(1);
  if (vendorConnectionId && !row) throw notFound("vendor connection", vendorConnectionId);
  return {
    id: row?.id ?? null,
    name: row?.name ?? null,
    spec: { ...DEFAULT_SHEET_SPEC, ...(row?.spec ?? {}) },
  };
}

/* ------------------------------- candidates ------------------------------- */

export type BatchOptionsInput = {
  dueBefore: string;
  rushFirst: boolean;
  includeReprints: boolean;
  vendorConnectionId: string | null;
  orderItemIds?: string[] | undefined;
  maxSheets: number | null;
};

export type Candidate = {
  view: ItemView;
  widthIn: number;
  heightIn: number;
  fileKey: string | null;
  reason: ExclusionReason | null;
};

const STATES_NEEDING_SHEET = ["ready", "on_sheet", "transfer_in"] as const;

/** Does a w x h design (plus its label strip) fit the spec's printable width in some rotation? */
export function fitsSpec(w: number, h: number, spec: SheetSpec) {
  const usable = spec.widthIn - 2 * spec.marginIn;
  const maxLen = spec.maxLengthIn - 2 * spec.marginIn - HEADER_HEIGHT_IN;
  return (
    (w <= usable && h + LABEL_HEIGHT_IN <= maxLen) || (h <= usable && w + LABEL_HEIGHT_IN <= maxLen)
  );
}

/** Classify one item for a batch: null reason = goes on a sheet. */
export function classify(
  v: ItemView,
  file: { fileKey: string; widthIn: number; heightIn: number; qaStatus: string } | null,
  spec: SheetSpec,
): Candidate {
  const i = v.item;
  const out = (reason: ExclusionReason | null, fileKey: string | null = null, w = 0, h = 0) => ({
    view: v,
    widthIn: w,
    heightIn: h,
    fileKey,
    reason,
  });
  switch (i.state) {
    case "cancelled":
      return out("cancelled");
    case "on_hold":
      return out("on_hold");
    case "imported":
    case "needs_mapping":
      return out("needs_mapping");
    case "needs_artwork":
      return out("needs_artwork");
    case "ready":
    case "on_sheet":
    case "transfer_in":
      // on_sheet/transfer_in without a transfer: a reprint or a unit whose sheet was cancelled.
      if (i.transferId) return out("already_on_sheet");
      break;
    default:
      return out("already_on_sheet");
  }
  if (!v.design || !i.blankVariantId) return out("needs_mapping");
  const personalized = !!v.design.templateId;
  const w = i.printWidthIn ?? file?.widthIn ?? 0;
  const h = i.printHeightIn ?? file?.heightIn ?? 0;
  let key: string | null;
  if (personalized) {
    if (!i.artworkKey || !["rendered", "approved"].includes(i.artworkStatus))
      return out("needs_artwork");
    key = i.artworkKey;
  } else {
    if (!file) return out("no_print_file");
    if (file.qaStatus === "failed") return out("artwork_qa_failed");
    key = file.fileKey;
  }
  if (w <= 0 || h <= 0) return out("no_print_file");
  if (!fitsSpec(w, h, spec)) return out("oversize", key, w, h);
  return out(null, key, w, h);
}

async function designFilesFor(tx: Tx, views: ItemView[]) {
  const ids = [...new Set(views.map((v) => v.design?.id).filter((x): x is string => !!x))];
  if (!ids.length) return new Map<string, typeof designFiles.$inferSelect>();
  const rows = await tx.select().from(designFiles).where(inArray(designFiles.designId, ids));
  return new Map(rows.map((r) => [`${r.designId}:${r.placement}`, r]));
}

function sortCandidates(list: Candidate[], rushFirst: boolean) {
  return list.sort(
    (a, b) =>
      (rushFirst ? Number(b.view.item.isRush) - Number(a.view.item.isRush) : 0) ||
      Number(b.view.item.isReprint) - Number(a.view.item.isReprint) ||
      a.view.item.shipBy.getTime() - b.view.item.shipBy.getTime() ||
      a.view.orderNo.localeCompare(b.view.orderNo) ||
      a.view.item.lineNo - b.view.item.lineNo ||
      a.view.item.unitNo - b.view.item.unitNo,
  );
}

/** Every item the options touch, classified. Items outside the cutoff are not listed at all. */
export async function collectCandidates(
  tx: Tx,
  opts: BatchOptionsInput,
  spec: SheetSpec,
): Promise<Candidate[]> {
  const explicit = !!opts.orderItemIds?.length;
  let ids: string[];
  if (explicit) {
    ids = opts.orderItemIds ?? [];
  } else {
    const dueBefore = new Date(opts.dueBefore);
    const due = and(
      lte(orderItems.shipBy, dueBefore),
      inArray(orderItems.state, ["imported", "needs_mapping", "ready", "needs_artwork", "on_hold"]),
    );
    // Reprints (and units whose sheet was cancelled) wait on_sheet/transfer_in with no transfer.
    const reprintWaiting = opts.includeReprints
      ? and(inArray(orderItems.state, [...STATES_NEEDING_SHEET]), isNull(orderItems.transferId))
      : undefined;
    const rows = await tx
      .select({ id: orderItems.id })
      .from(orderItems)
      .where(reprintWaiting ? or(due, reprintWaiting) : due);
    ids = rows.map((r) => r.id);
  }
  const views = [...(await loadItemViews(tx, ids)).values()];
  const files = await designFilesFor(tx, views);
  const out = views
    .filter((v) => opts.includeReprints || !v.item.isReprint || explicit)
    .map((v) =>
      classify(
        v,
        v.design ? (files.get(`${v.design.id}:${placementOf(v.item.placement)}`) ?? null) : null,
        spec,
      ),
    );
  await markMissingFiles(out);
  return sortCandidates(out, opts.rushFirst);
}

/** Items whose print file isn't in storage can't be composed; keep them off the sheet. */
async function markMissingFiles(list: Candidate[]) {
  const keys = [
    ...new Set(list.filter((c) => !c.reason && c.fileKey).map((c) => c.fileKey as string)),
  ];
  const exists = new Map<string, boolean>();
  await Promise.all(
    keys.map(async (k) => {
      exists.set(
        k,
        await headObject(k).then(
          (h) => h.exists,
          () => false,
        ),
      );
    }),
  );
  for (const c of list) {
    if (c.reason || !c.fileKey || exists.get(c.fileKey)) continue;
    c.reason = c.view.design?.templateId ? "needs_artwork" : "no_print_file";
  }
}

/* -------------------------------- estimate -------------------------------- */

function nestRequest(items: Candidate[], spec: SheetSpec) {
  return {
    items: items.map((c) => ({ id: c.view.item.id, width_in: c.widthIn, height_in: c.heightIn })),
    sheet_width_in: spec.widthIn,
    spacing_in: spec.spacingIn,
    margin_in: spec.marginIn,
    max_length_in: spec.maxLengthIn,
    allow_rotation: true,
    label_height_in: LABEL_HEIGHT_IN,
    header_height_in: HEADER_HEIGHT_IN,
  };
}

function summarize(sheets: NestResult["sheets"]) {
  const length = sheets.reduce((s, x) => s + x.length_in, 0);
  const used = sheets.reduce((s, x) => s + x.utilization * x.length_in, 0);
  return { length, utilization: length > 0 ? used / length : 0 };
}

/** Area-based guess when imaging is down: 80% packing efficiency. */
function roughEstimate(items: Candidate[], spec: SheetSpec) {
  const usable = spec.widthIn - 2 * spec.marginIn;
  const area = items.reduce(
    (s, c) => s + (c.widthIn + spec.spacingIn) * (c.heightIn + LABEL_HEIGHT_IN + spec.spacingIn),
    0,
  );
  const length = area / usable / 0.8 + 2 * spec.marginIn + HEADER_HEIGHT_IN;
  const sheets = Math.max(items.length ? 1 : 0, Math.ceil(length / spec.maxLengthIn));
  const designArea = items.reduce((s, c) => s + c.widthIn * c.heightIn, 0);
  return {
    sheets,
    length,
    utilization: length > 0 ? Math.min(1, designArea / (length * spec.widthIn)) : 0,
  };
}

export async function previewBatch(
  tx: Tx,
  _ctx: TenantContext,
  opts: BatchOptionsInput,
): Promise<BatchPreview> {
  const vendor = await resolveVendor(tx, opts.vendorConnectionId);
  const spec = vendor.spec;
  const all = await collectCandidates(tx, opts, spec);
  let eligible = all.filter((c) => !c.reason);
  const excluded = all.filter((c) => c.reason);

  let estimate = { sheets: 0, length: 0, utilization: 0 };
  if (eligible.length) {
    try {
      const nest = await imaging.nest(nestRequest(eligible, spec));
      const sheets = opts.maxSheets ? nest.sheets.slice(0, opts.maxSheets) : nest.sheets;
      const placed = new Set(sheets.flatMap((s) => s.placements.map((p) => p.id)));
      const s = summarize(sheets);
      estimate = { sheets: sheets.length, length: s.length, utilization: s.utilization };
      const unplacedIds = new Set(nest.sheets.flatMap((x) => x.placements.map((p) => p.id)));
      for (const c of eligible) if (!unplacedIds.has(c.view.item.id)) c.reason = "oversize";
      eligible = eligible.filter((c) => placed.has(c.view.item.id));
    } catch (err) {
      log.warn("nest estimate failed, using area estimate", { error: String(err) });
      estimate = roughEstimate(eligible, spec);
    }
  }
  return {
    items: eligible.map((c) => ({
      orderItemId: c.view.item.id,
      orderId: c.view.item.orderId,
      orderNo: c.view.orderNo,
      designName: c.view.design?.name ?? c.view.item.title,
      placement: placementOf(c.view.item.placement),
      widthIn: c.widthIn,
      heightIn: c.heightIn,
      shipBy: c.view.item.shipBy.toISOString(),
      isRush: c.view.item.isRush,
      isReprint: c.view.item.isReprint,
    })),
    excluded: [
      ...excluded,
      ...all.filter((c) => c.reason === "oversize" && !excluded.includes(c)),
    ].map((c) => ({
      orderItemId: c.view.item.id,
      orderNo: c.view.orderNo,
      reason: c.reason as ExclusionReason,
    })),
    sheetWidthIn: spec.widthIn,
    estimatedSheets: estimate.sheets,
    estimatedLengthIn: Math.round(estimate.length * 100) / 100,
    estimatedUtilization: Math.min(1, Math.round(estimate.utilization * 1000) / 1000),
    estimatedCost: Math.round(estimate.length * spec.pricePerInch),
  };
}

/* ---------------------------------- build ---------------------------------- */

export async function buildBatch(
  tx: Tx,
  ctx: TenantContext,
  input: BatchOptionsInput & { name?: string | undefined },
) {
  const vendor = await resolveVendor(tx, input.vendorConnectionId);
  const eligible = (await collectCandidates(tx, input, vendor.spec)).filter((c) => !c.reason);
  if (!eligible.length)
    throw new ORPCError("NOTHING_TO_BUILD", {
      status: 400,
      message: "No eligible items for this cutoff",
    });
  const ids = eligible.map((c) => c.view.item.id);
  const day = new Date().toISOString().slice(0, 10);
  const [batch] = await tx
    .insert(gangSheetBatches)
    .values({
      companyId: ctx.companyId,
      name: input.name ?? `${day} build`,
      status: "building",
      dueBefore: new Date(input.dueBefore),
      vendorConnectionId: vendor.id,
      options: {
        dueBefore: input.dueBefore,
        rushFirst: input.rushFirst,
        includeReprints: input.includeReprints,
        maxSheets: input.maxSheets,
        orderItemIds: ids,
      },
      itemCount: ids.length,
      createdBy: ctx.userId,
    })
    .returning();
  if (!batch) throw new Error("batch insert failed");
  const job = await createJobRow(tx, ctx, "build_sheets", { batchId: batch.id });
  await tx.update(gangSheetBatches).set({ jobId: job.id }).where(eq(gangSheetBatches.id, batch.id));
  await audit(tx, {
    companyId: ctx.companyId,
    actor: ctx.actor,
    action: "sheets.build",
    entityType: "gang_sheet_batch",
    entityId: batch.id,
    summary: `Build sheets for ${ids.length} items`,
  });
  await emit(tx, ctx.companyId, "batch.requested", {
    batchId: batch.id,
    jobId: job.id,
    orderItemIds: ids,
  });
  return { jobId: job.id, batchId: batch.id, itemCount: ids.length };
}

/** Next free "YYYY-MM-DD #n" name for today. */
async function nextSheetName(tx: Tx, day: string, offset = 0) {
  const rows = await tx
    .select({ name: gangSheets.name })
    .from(gangSheets)
    .where(like(gangSheets.name, `${day} #%`));
  const max = rows.reduce(
    (m, r) => Math.max(m, Number.parseInt(r.name.split("#")[1] ?? "0", 10) || 0),
    0,
  );
  return `${day} #${max + 1 + offset}`;
}

export type SkippedItem = { orderItemId: string; reason: string };

type PlannedSheet = {
  placements: NestResult["sheets"][number]["placements"];
  length: number;
  utilization: number;
};

/**
 * Creates the sheet row and its transfers for one nested sheet, and points the items at them.
 * Items that changed since the batch was planned are dropped (their slot stays empty).
 */
async function createSheetRows(
  companyId: string,
  batchId: string,
  vendor: VendorChoice,
  planned: PlannedSheet,
  byId: Map<string, Candidate>,
  sheetNo: number,
) {
  return withTenant(companyId, async (tx) => {
    const ids = [...new Set(planned.placements.map((p) => p.id))];
    const locked = await tx
      .select()
      .from(orderItems)
      .where(inArray(orderItems.id, ids))
      .for("update");
    const fresh = new Map(locked.map((r) => [r.id, r]));
    const dropped: SkippedItem[] = [];
    const keep = planned.placements.filter((p) => {
      const r = fresh.get(p.id);
      const ok =
        r && !r.transferId && (STATES_NEEDING_SHEET as readonly string[]).includes(r.state);
      if (!ok) dropped.push({ orderItemId: p.id, reason: r ? `state ${r.state}` : "missing" });
      return ok;
    });
    if (!keep.length) return { sheet: null, transfers: [] as TransferRow[], dropped };
    const day = new Date().toISOString().slice(0, 10);
    let sheet: SheetRow | undefined;
    for (let attempt = 0; !sheet && attempt < 20; attempt++) {
      [sheet] = await tx
        .insert(gangSheets)
        .values({
          companyId,
          batchId,
          sheetNo,
          name: await nextSheetName(tx, day, attempt),
          vendorConnectionId: vendor.id,
          widthIn: vendor.spec.widthIn,
          lengthIn: planned.length,
          utilization: planned.utilization,
          status: "building",
        })
        .onConflictDoNothing()
        .returning();
    }
    if (!sheet) throw new Error("could not allocate a sheet name");
    const rows = await tx
      .insert(transfers)
      .values(
        keep.map((p) => {
          const c = byId.get(p.id) as Candidate;
          const v = c.view;
          return {
            companyId,
            gangSheetId: (sheet as SheetRow).id,
            orderItemId: p.id,
            xIn: p.x_in,
            yIn: p.y_in,
            widthIn: p.width_in,
            heightIn: p.height_in,
            rotated: p.rotated,
            isReprint: v.item.isReprint,
            label: {
              order_no: v.orderNo,
              item_no:
                v.item.unitsInLine > 1 ? `${v.item.lineNo}.${v.item.unitNo}` : `${v.item.lineNo}`,
              size: v.blank?.size ?? "",
              color: v.blank?.color ?? "",
              design: v.design?.name ?? v.item.title,
              reprint: v.item.isReprint,
            },
          };
        }),
      )
      .returning();
    for (const t of rows) {
      await tx
        .update(orderItems)
        .set({ transferId: t.id, gangSheetId: t.gangSheetId })
        .where(eq(orderItems.id, t.orderItemId));
    }
    await tx
      .update(gangSheets)
      .set({ transferCount: rows.length, reprintCount: rows.filter((r) => r.isReprint).length })
      .where(eq(gangSheets.id, sheet.id));
    return { sheet, transfers: rows, dropped };
  });
}

/** Resolve each transfer's print file: rendered artwork for personalized items, else the design file. */
async function printFiles(tx: Tx, rows: TransferRow[]) {
  const views = await loadItemViews(
    tx,
    rows.map((r) => r.orderItemId),
  );
  const files = await designFilesFor(tx, [...views.values()]);
  const out = new Map<string, string>();
  for (const r of rows) {
    const v = views.get(r.orderItemId);
    if (!v) continue;
    const key = v.design?.templateId
      ? v.item.artworkKey
      : v.design
        ? files.get(`${v.design.id}:${placementOf(v.item.placement)}`)?.fileKey
        : null;
    if (key) out.set(r.id, key);
  }
  return out;
}

/** Compose one sheet's files and mark it ready (items ready -> on_sheet), or failed. */
export async function composeSheet(
  companyId: string,
  sheetId: string,
  spec: SheetSpec,
): Promise<{ ok: boolean; error: string | null }> {
  const prep = await withTenant(companyId, async (tx) => {
    const [sheet] = await tx.select().from(gangSheets).where(eq(gangSheets.id, sheetId)).limit(1);
    if (!sheet) throw notFound("gang sheet", sheetId);
    const rows = await tx
      .select()
      .from(transfers)
      .where(and(eq(transfers.gangSheetId, sheetId), eq(transfers.scrapped, false)));
    return { sheet, rows, files: await printFiles(tx, rows) };
  });
  const { sheet, rows, files } = prep;
  const pngKey = objectKey(companyId, "sheet", "png");
  const pdfKey = spec.format === "pdf" ? objectKey(companyId, "sheet", "pdf") : undefined;
  const previewKey = objectKey(companyId, "preview", "png");
  let error: string | null = null;
  try {
    const missing = rows.filter((r) => !files.has(r.id));
    if (missing.length) throw new Error(`${missing.length} transfer(s) have no print file`);
    for (const key of new Set(files.values())) {
      if (!(await headObject(key)).exists) throw new Error(`print file missing in storage: ${key}`);
    }
    // AC2 (B-79): the sheet id and order numbers, so CADlink or a human can look the job up by
    // name or by scanning the header code imaging draws for this (not the opaque S3 key).
    const orderNos = [
      ...new Set(rows.map((r) => r.label?.order_no).filter((v): v is string => !!v)),
    ];
    const filenameHint = [sheet.name, ...orderNos].join(" ").slice(0, 150);
    await imaging.compose({
      width_in: sheet.widthIn,
      length_in: sheet.lengthIn,
      dpi: spec.dpi,
      placements: rows.map((r) => ({
        transfer_id: r.id,
        file_key: files.get(r.id) as string,
        x_in: r.xIn,
        y_in: r.yIn,
        width_in: r.widthIn,
        height_in: r.heightIn,
        rotated: r.rotated,
        label: r.label,
      })),
      out_key: pngKey,
      ...(pdfKey ? { pdf_key: pdfKey } : {}),
      preview_key: previewKey,
      label_gap_in: spec.labelGapIn,
      filename_hint: filenameHint,
      header_height_in: HEADER_HEIGHT_IN,
    });
  } catch (err) {
    error =
      err instanceof ImagingError
        ? `imaging: ${err.detail}`
        : String(err instanceof Error ? err.message : err);
    log.warn("compose failed", { sheetId, error });
  }

  await withTenant(companyId, async (tx) => {
    const [cur] = await tx
      .select()
      .from(gangSheets)
      .where(eq(gangSheets.id, sheetId))
      .for("update");
    if (cur?.status !== "building") return;
    const actor: Actor = { kind: "system" };
    if (error) {
      await transitionSheet(tx, companyId, actor, cur, "failed", { error });
      await emit(tx, companyId, "sheet.build_failed", { sheetId, batchId: cur.batchId, error });
      return;
    }
    await transitionSheet(tx, companyId, actor, cur, "ready", {
      pngKey,
      pdfKey: pdfKey ?? null,
      previewKey,
      error: null,
      costCents: Math.round(cur.lengthIn * spec.pricePerInch),
    });
    const items = await tx
      .select({ id: orderItems.id, state: orderItems.state, transferId: orderItems.transferId })
      .from(orderItems)
      .where(
        inArray(
          orderItems.id,
          rows.map((r) => r.orderItemId),
        ),
      );
    for (const it of items) {
      if (it.state === "ready" && it.transferId && rows.some((r) => r.id === it.transferId)) {
        await transitionItem(tx, it.id, "on_sheet", {
          actor,
          reason: `on sheet ${cur.name}`,
          data: { sheetId, transferId: it.transferId },
        });
      }
    }
    for (const r of rows.filter((x) => x.isReprint)) {
      await tx
        .update(reprints)
        .set({ status: "on_sheet", newTransferId: r.id })
        .where(and(eq(reprints.orderItemId, r.orderItemId), eq(reprints.status, "requested")));
    }
    await emit(tx, companyId, "sheet.built", {
      sheetId,
      batchId: cur.batchId,
      transferIds: rows.map((r) => r.id),
    });
  });
  return { ok: !error, error };
}

/** Worker body of `production.buildSheets`: nest, create sheets, compose each. */
export async function runBuildSheets(companyId: string, batchId: string, jobId: string) {
  await updateJobRow(companyId, jobId, {
    status: "running",
    progress: 0.02,
    message: "Collecting items",
  });
  const plan = await withTenant(companyId, async (tx) => {
    const [batch] = await tx
      .select()
      .from(gangSheetBatches)
      .where(eq(gangSheetBatches.id, batchId))
      .limit(1);
    if (!batch) throw notFound("gang sheet batch", batchId);
    const o = batch.options as Partial<BatchOptionsInput>;
    const vendor = await resolveVendor(tx, batch.vendorConnectionId);
    const cands = await collectCandidates(
      tx,
      {
        dueBefore: o.dueBefore ?? new Date().toISOString(),
        rushFirst: o.rushFirst ?? true,
        includeReprints: o.includeReprints ?? true,
        vendorConnectionId: batch.vendorConnectionId,
        orderItemIds: o.orderItemIds ?? [],
        maxSheets: o.maxSheets ?? null,
      },
      vendor.spec,
    );
    return { batch, vendor, cands, maxSheets: o.maxSheets ?? null };
  });
  const skipped: SkippedItem[] = plan.cands
    .filter((c) => c.reason)
    .map((c) => ({ orderItemId: c.view.item.id, reason: c.reason as string }));
  const eligible = plan.cands.filter((c) => !c.reason);
  const finish = async (
    status: "ready" | "failed",
    sheetIds: string[],
    message: string,
    error: string | null,
  ) => {
    await withTenant(companyId, (tx) =>
      tx
        .update(gangSheetBatches)
        .set({
          status,
          sheetCount: sheetIds.length,
          error,
          options: { ...(plan.batch.options as object), skipped },
        })
        .where(eq(gangSheetBatches.id, batchId)),
    );
    await updateJobRow(companyId, jobId, {
      status: status === "ready" ? "done" : "failed",
      progress: 1,
      message,
      resultIds: sheetIds,
      error,
    });
  };
  if (!eligible.length) {
    await finish("failed", [], "Nothing to build", "No eligible items left for this batch");
    return { sheetIds: [] };
  }

  let nest: NestResult;
  try {
    await updateJobRow(companyId, jobId, {
      progress: 0.08,
      message: `Nesting ${eligible.length} designs`,
    });
    nest = await imaging.nest(nestRequest(eligible, plan.vendor.spec));
  } catch (err) {
    const error = err instanceof ImagingError ? `imaging: ${err.detail}` : String(err);
    await finish("failed", [], "Nesting failed", error);
    return { sheetIds: [] };
  }
  const placedIds = new Set(nest.sheets.flatMap((s) => s.placements.map((p) => p.id)));
  for (const c of eligible)
    if (!placedIds.has(c.view.item.id))
      skipped.push({ orderItemId: c.view.item.id, reason: "oversize" });
  const sheetsPlanned = plan.maxSheets ? nest.sheets.slice(0, plan.maxSheets) : nest.sheets;
  for (const s of nest.sheets.slice(sheetsPlanned.length))
    for (const p of s.placements) skipped.push({ orderItemId: p.id, reason: "max_sheets" });

  const byId = new Map(eligible.map((c) => [c.view.item.id, c]));
  const sheetIds: string[] = [];
  let failed = 0;
  let itemsOnSheets = 0;
  for (const [k, planned] of sheetsPlanned.entries()) {
    const base = 0.1 + (0.88 * k) / sheetsPlanned.length;
    const created = await createSheetRows(
      companyId,
      batchId,
      plan.vendor,
      {
        placements: planned.placements,
        length: planned.length_in,
        utilization: planned.utilization,
      },
      byId,
      k + 1,
    );
    skipped.push(...created.dropped);
    if (!created.sheet) continue;
    sheetIds.push(created.sheet.id);
    await updateJobRow(companyId, jobId, {
      progress: base,
      message: `Composing sheet ${k + 1} of ${sheetsPlanned.length} (${created.transfers.length} transfers)`,
      resultIds: sheetIds,
    });
    const res = await composeSheet(companyId, created.sheet.id, plan.vendor.spec);
    if (res.ok) itemsOnSheets += created.transfers.length;
    else failed++;
  }
  const allFailed = sheetIds.length === 0 || failed === sheetIds.length;
  const msg = `Built ${sheetIds.length - failed} sheet(s) with ${itemsOnSheets} transfers${
    failed ? `, ${failed} failed` : ""
  }${skipped.length ? `; ${skipped.length} item(s) left ready` : ""}`;
  await finish(
    allFailed ? "failed" : "ready",
    sheetIds,
    msg,
    allFailed ? "Every sheet failed to build" : null,
  );
  return { sheetIds, skipped };
}

/* ------------------------------ regenerate -------------------------------- */

export async function regenerateSheet(tx: Tx, ctx: TenantContext, id: string) {
  const sheet = await lockSheet(tx, id);
  if (sheet.status !== "ready" && sheet.status !== "failed")
    throw invalidTransition("sheet", id, sheet.status, "building");
  await transitionSheet(tx, ctx.companyId, ctx.actor, sheet, "building", { error: null });
  const job = await createJobRow(tx, ctx, "regenerate_sheet", { sheetId: id });
  await emit(tx, ctx.companyId, "sheet.regenerate_requested", { sheetId: id, jobId: job.id });
  return { jobId: job.id };
}

/** Worker body of `production.regenerateSheet`: drop scrapped/cancelled units, re-nest, re-compose. */
export async function runRegenerateSheet(companyId: string, sheetId: string, jobId: string) {
  await updateJobRow(companyId, jobId, {
    status: "running",
    progress: 0.05,
    message: "Re-nesting",
  });
  const prep = await withTenant(companyId, async (tx) => {
    const [sheet] = await tx.select().from(gangSheets).where(eq(gangSheets.id, sheetId)).limit(1);
    if (!sheet) throw notFound("gang sheet", sheetId);
    const vendor = await resolveVendor(tx, sheet.vendorConnectionId);
    const rows = await tx
      .select({ t: transfers, state: orderItems.state, itemTransferId: orderItems.transferId })
      .from(transfers)
      .innerJoin(orderItems, eq(orderItems.id, transfers.orderItemId))
      .where(and(eq(transfers.gangSheetId, sheetId), eq(transfers.scrapped, false)));
    const live = rows.filter((r) => r.state !== "cancelled" && r.itemTransferId === r.t.id);
    const dead = rows.filter((r) => !live.includes(r)).map((r) => r.t.id);
    if (dead.length)
      await tx
        .update(transfers)
        .set({ scrapped: true, status: "scrap" })
        .where(inArray(transfers.id, dead));
    return { sheet, vendor, live: live.map((r) => r.t) };
  });
  if (!prep.live.length) {
    await withTenant(companyId, async (tx) => {
      const cur = await lockSheet(tx, sheetId);
      await transitionSheet(tx, companyId, { kind: "system" }, cur, "failed", {
        error: "No live transfers left on this sheet",
      });
    });
    await updateJobRow(companyId, jobId, {
      status: "failed",
      progress: 1,
      error: "Nothing left on the sheet",
    });
    return;
  }
  try {
    const nest = await imaging.nest({
      items: prep.live.map((t) => ({
        id: t.id,
        width_in: t.rotated ? t.heightIn : t.widthIn,
        height_in: t.rotated ? t.widthIn : t.heightIn,
      })),
      sheet_width_in: prep.vendor.spec.widthIn,
      spacing_in: prep.vendor.spec.spacingIn,
      margin_in: prep.vendor.spec.marginIn,
      max_length_in: prep.vendor.spec.maxLengthIn,
      allow_rotation: true,
      label_height_in: LABEL_HEIGHT_IN,
      header_height_in: HEADER_HEIGHT_IN,
    });
    const [first, ...rest] = nest.sheets;
    await withTenant(companyId, async (tx) => {
      for (const p of first?.placements ?? []) {
        await tx
          .update(transfers)
          .set({
            xIn: p.x_in,
            yIn: p.y_in,
            widthIn: p.width_in,
            heightIn: p.height_in,
            rotated: p.rotated,
          })
          .where(eq(transfers.id, p.id));
      }
      // Overflow (only possible with a smaller spec now) goes back to the pool.
      const overflow = rest.flatMap((s) => s.placements.map((p) => p.id));
      if (overflow.length) await scrapTransfers(tx, overflow);
      await tx
        .update(gangSheets)
        .set({
          lengthIn: first?.length_in ?? 0,
          utilization: first?.utilization ?? 0,
          widthIn: prep.vendor.spec.widthIn,
          transferCount: first?.placements.length ?? 0,
        })
        .where(eq(gangSheets.id, sheetId));
    });
  } catch (err) {
    const error = err instanceof ImagingError ? `imaging: ${err.detail}` : String(err);
    await withTenant(companyId, async (tx) => {
      const cur = await lockSheet(tx, sheetId);
      if (cur.status === "building")
        await transitionSheet(tx, companyId, { kind: "system" }, cur, "failed", { error });
    });
    await updateJobRow(companyId, jobId, { status: "failed", progress: 1, error });
    return;
  }
  await updateJobRow(companyId, jobId, { progress: 0.4, message: "Composing" });
  const res = await composeSheet(companyId, sheetId, prep.vendor.spec);
  await updateJobRow(companyId, jobId, {
    status: res.ok ? "done" : "failed",
    progress: 1,
    message: res.ok ? "Sheet regenerated" : "Compose failed",
    resultIds: [sheetId],
    error: res.error,
  });
}

/* ----------------------------- sheet lifecycle ----------------------------- */

export async function lockSheet(tx: Tx, id: string): Promise<SheetRow> {
  const [row] = await tx.select().from(gangSheets).where(eq(gangSheets.id, id)).for("update");
  if (!row) throw notFound("gang sheet", id);
  return row;
}

const STAMP: Partial<Record<SheetState, keyof SheetRow>> = {
  sent: "sentAt",
  acknowledged: "acknowledgedAt",
  printed: "printedAt",
  shipped: "shippedAt",
  received: "receivedAt",
};

export type SheetPatch = Partial<
  Pick<
    SheetRow,
    | "pngKey"
    | "pdfKey"
    | "previewKey"
    | "error"
    | "costCents"
    | "vendorConnectionId"
    | "vendorNotes"
    | "trackingCarrier"
    | "trackingCode"
  >
>;

/**
 * Move a sheet along SHEET_TRANSITIONS: stamps the matching timestamp, writes audit + outbox
 * `sheet.status_changed`, rolls the batch status up and pushes realtime to the shop after commit.
 * `force` allows the vendor's reject (sent/acknowledged -> failed), which the table doesn't list.
 */
export async function transitionSheet(
  tx: Tx,
  companyId: string,
  actor: Actor,
  sheet: SheetRow,
  to: SheetState,
  patch: SheetPatch = {},
  opts: { force?: boolean } = {},
): Promise<SheetRow> {
  const from = sheet.status;
  if (!opts.force && !SHEET_TRANSITIONS[from].includes(to))
    throw invalidTransition("sheet", sheet.id, from, to);
  const now = new Date();
  const stamp = STAMP[to];
  const [row] = await tx
    .update(gangSheets)
    .set({ ...patch, status: to, updatedAt: now, ...(stamp ? { [stamp]: now } : {}) })
    .where(eq(gangSheets.id, sheet.id))
    .returning();
  if (!row) throw notFound("gang sheet", sheet.id);
  await audit(tx, {
    companyId,
    actor,
    action: "sheet.status_changed",
    entityType: "gang_sheet",
    entityId: sheet.id,
    summary: `${sheet.name}: ${from} -> ${to}`,
    data: { from, to },
  });
  await emit(tx, companyId, "sheet.status_changed", { sheetId: sheet.id, from, to });
  await rollupBatch(tx, sheet.batchId);
  afterCommit(tx, async () => {
    await publish(companyId, {
      type: "sheet.status_changed",
      data: { sheetId: sheet.id, from, to },
    });
    await publish(companyId, { type: "today.changed", data: { reason: "sheet" } });
  });
  return row;
}

async function rollupBatch(tx: Tx, batchId: string) {
  const rows = await tx
    .select({ status: gangSheets.status })
    .from(gangSheets)
    .where(eq(gangSheets.batchId, batchId));
  if (!rows.length) return;
  const s = rows.map((r) => r.status).filter((x) => x !== "cancelled");
  const status =
    s.length === 0
      ? "cancelled"
      : s.some((x) => x === "building")
        ? "building"
        : s.every((x) => x === "received")
          ? "complete"
          : s.every((x) => ["sent", "acknowledged", "printed", "shipped", "received"].includes(x))
            ? "sent"
            : s.every((x) => x === "failed")
              ? "failed"
              : "ready";
  await tx.update(gangSheetBatches).set({ status }).where(eq(gangSheetBatches.id, batchId));
}

/** Scrap transfers and free their items for the next batch (pointers cleared, state kept). */
export async function scrapTransfers(tx: Tx, transferIds: string[]) {
  if (!transferIds.length) return;
  await tx
    .update(transfers)
    .set({ scrapped: true, status: "scrap" })
    .where(inArray(transfers.id, transferIds));
  await tx
    .update(orderItems)
    .set({ transferId: null, gangSheetId: null })
    .where(inArray(orderItems.transferId, transferIds));
  await tx
    .update(reprints)
    .set({ status: "requested", newTransferId: null })
    .where(and(inArray(reprints.newTransferId, transferIds), eq(reprints.status, "on_sheet")));
}

export async function cancelSheet(tx: Tx, ctx: TenantContext, id: string): Promise<GangSheet> {
  const sheet = await lockSheet(tx, id);
  await transitionSheet(tx, ctx.companyId, ctx.actor, sheet, "cancelled");
  const live = await tx
    .select({ id: transfers.id })
    .from(transfers)
    .where(and(eq(transfers.gangSheetId, id), eq(transfers.scrapped, false)));
  await scrapTransfers(
    tx,
    live.map((t) => t.id),
  );
  await tx
    .update(vendorAccess)
    .set({ revokedAt: new Date() })
    .where(and(eq(vendorAccess.gangSheetId, id), isNull(vendorAccess.revokedAt)));
  return getSheet(tx, ctx, id);
}

export async function markSheetReceived(
  tx: Tx,
  ctx: TenantContext,
  id: string,
): Promise<GangSheet> {
  const sheet = await lockSheet(tx, id);
  await transitionSheet(tx, ctx.companyId, ctx.actor, sheet, "received");
  const live = await tx
    .select()
    .from(transfers)
    .where(and(eq(transfers.gangSheetId, id), eq(transfers.scrapped, false)));
  await tx
    .update(transfers)
    .set({ status: "received" })
    .where(
      and(
        eq(transfers.gangSheetId, id),
        eq(transfers.scrapped, false),
        eq(transfers.status, "placed"),
      ),
    );
  const items = live.length
    ? await tx
        .select({ id: orderItems.id, state: orderItems.state, transferId: orderItems.transferId })
        .from(orderItems)
        .where(
          inArray(
            orderItems.id,
            live.map((t) => t.orderItemId),
          ),
        )
    : [];
  const moved: string[] = [];
  for (const it of items) {
    if (it.state === "on_sheet" && it.transferId && live.some((t) => t.id === it.transferId)) {
      await transitionItem(tx, it.id, "transfer_in", {
        actor: ctx.actor,
        stationKind: ctx.station?.kind ?? null,
        reason: `sheet ${sheet.name} received`,
        data: { sheetId: id },
      });
      moved.push(it.id);
    }
  }
  await emit(tx, ctx.companyId, "sheet.received", { sheetId: id, orderItemIds: moved });
  afterCommit(tx, () =>
    publish(ctx.companyId, {
      type: "queue.changed",
      data: { station: "pick", waiting: moved.length },
    }).then(() => undefined),
  );
  return getSheet(tx, ctx, id);
}

async function companyPrintsInHouse(tx: Tx, companyId: string): Promise<boolean> {
  const [company] = await tx
    .select({ settings: companies.settings })
    .from(companies)
    .where(eq(companies.id, companyId));
  return company?.settings?.printsInHouse === true;
}

/**
 * In-house path: skips the vendor entirely. Only succeeds when the company prints in-house and
 * the sheet is `ready` (SHEET_TRANSITIONS enforces the latter via transitionSheet).
 */
export async function markSheetPrinting(
  tx: Tx,
  ctx: TenantContext,
  id: string,
): Promise<GangSheetDetail> {
  if (!(await companyPrintsInHouse(tx, ctx.companyId)))
    throw new ORPCError("FORBIDDEN", {
      status: 403,
      message: "Company does not print in-house",
    });
  const sheet = await lockSheet(tx, id);
  await transitionSheet(tx, ctx.companyId, ctx.actor, sheet, "printing");
  return getSheet(tx, ctx, id);
}

/**
 * `printing` -> `printed`. Units then flow to the floor exactly as a vendor-printed sheet does:
 * `printed -> received` is already a valid transition, so the shop marks the same sheet
 * received (markSheetReceived) once the transfers are cut and ready for pick, no branch needed.
 *
 * This is the in-house-only counterpart to the vendor path's `printed` (reached through the
 * vendor status webhook, `sendSheetToVendor`'s `transitionSheet(..., "printed")`, never through
 * here). `SHEET_TRANSITIONS` alone allows `sent`/`acknowledged` -> `printed` too (that's the
 * vendor path), so this procedure must refuse those explicitly or a shop user could force a
 * vendor sheet straight to `printed` with no vendor confirmation.
 */
export async function markSheetPrinted(
  tx: Tx,
  ctx: TenantContext,
  id: string,
): Promise<GangSheetDetail> {
  const sheet = await lockSheet(tx, id);
  if (sheet.status !== "printing" || !(await companyPrintsInHouse(tx, ctx.companyId)))
    throw invalidTransition("sheet", sheet.id, sheet.status, "printed");
  await transitionSheet(tx, ctx.companyId, ctx.actor, sheet, "printed");
  return getSheet(tx, ctx, id);
}

/* ---------------------------------- reads ---------------------------------- */

export function toGangSheet(row: SheetRow, vendorName: string | null): GangSheet {
  return {
    id: row.id,
    batchId: row.batchId,
    sheetNo: Math.max(1, row.sheetNo),
    name: row.name,
    vendorConnectionId: row.vendorConnectionId,
    vendorName,
    widthIn: row.widthIn,
    lengthIn: row.lengthIn,
    utilization: Math.min(1, Math.max(0, row.utilization)),
    status: row.status,
    transferCount: row.transferCount,
    reprintCount: row.reprintCount,
    files: { pngKey: row.pngKey, pdfKey: row.pdfKey, previewKey: row.previewKey },
    cost: row.costCents,
    tracking:
      row.trackingCarrier && row.trackingCode
        ? { carrier: row.trackingCarrier, code: row.trackingCode }
        : null,
    sentAt: row.sentAt?.toISOString() ?? null,
    acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
    printedAt: row.printedAt?.toISOString() ?? null,
    shippedAt: row.shippedAt?.toISOString() ?? null,
    receivedAt: row.receivedAt?.toISOString() ?? null,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toPlacement(t: TransferRow): SheetPlacement {
  return {
    transferId: t.id,
    orderItemId: t.orderItemId,
    orderNo: t.label.order_no ?? "",
    designName: t.label.design ?? "",
    size: t.label.size ?? "",
    color: t.label.color ?? "",
    xIn: Math.max(0, t.xIn),
    yIn: Math.max(0, t.yIn),
    widthIn: t.widthIn,
    heightIn: t.heightIn,
    rotated: t.rotated,
    isReprint: t.isReprint,
    scrapped: t.scrapped,
  };
}

/** Transfers of a sheet in reading order (placements for the detail view and vendor portal). */
export async function sheetPlacements(tx: Tx, sheetId: string) {
  const rows = await tx
    .select()
    .from(transfers)
    .where(eq(transfers.gangSheetId, sheetId))
    .orderBy(asc(transfers.yIn), asc(transfers.xIn));
  return rows.map(toPlacement);
}

export type SheetListInput = PageInput & {
  status?: SheetState[] | undefined;
  batchId?: string | undefined;
  vendorConnectionId?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
};

export async function listSheets(tx: Tx, _ctx: TenantContext, input: SheetListInput) {
  const page = keyset(gangSheets.createdAt, gangSheets.id, input);
  const filters: (SQL | undefined)[] = [page.where];
  if (input.status?.length) filters.push(inArray(gangSheets.status, input.status));
  if (input.batchId) filters.push(eq(gangSheets.batchId, input.batchId));
  if (input.vendorConnectionId)
    filters.push(eq(gangSheets.vendorConnectionId, input.vendorConnectionId));
  if (input.from) filters.push(gte(gangSheets.createdAt, new Date(input.from)));
  if (input.to) filters.push(lte(gangSheets.createdAt, new Date(input.to)));
  const rows = await tx
    .select({ sheet: gangSheets, vendorName: vendorConnections.name })
    .from(gangSheets)
    .leftJoin(vendorConnections, eq(vendorConnections.id, gangSheets.vendorConnectionId))
    .where(and(...filters))
    .orderBy(...page.orderBy)
    .limit(page.limit + 1);
  return page.result(
    rows.map((r) => ({ ...r, createdAt: r.sheet.createdAt, id: r.sheet.id })),
    (r) => toGangSheet(r.sheet, r.vendorName),
  );
}

export async function getSheet(tx: Tx, _ctx: TenantContext, id: string): Promise<GangSheetDetail> {
  const [row] = await tx
    .select({ sheet: gangSheets, vendorName: vendorConnections.name })
    .from(gangSheets)
    .leftJoin(vendorConnections, eq(vendorConnections.id, gangSheets.vendorConnectionId))
    .where(eq(gangSheets.id, id))
    .limit(1);
  if (!row) throw notFound("gang sheet", id);
  return { ...toGangSheet(row.sheet, row.vendorName), placements: await sheetPlacements(tx, id) };
}

export async function sheetItems(tx: Tx, _ctx: TenantContext, id: string) {
  const [sheet] = await tx
    .select({ id: gangSheets.id })
    .from(gangSheets)
    .where(eq(gangSheets.id, id));
  if (!sheet) throw notFound("gang sheet", id);
  const rows = await tx
    .select({ itemId: transfers.orderItemId })
    .from(transfers)
    .where(eq(transfers.gangSheetId, id))
    .orderBy(asc(transfers.yIn), asc(transfers.xIn));
  const views = await loadItemViews(
    tx,
    rows.map((r) => r.itemId),
  );
  const seen = new Set<string>();
  const items = [];
  for (const r of rows) {
    const v = views.get(r.itemId);
    if (v && !seen.has(r.itemId)) {
      seen.add(r.itemId);
      items.push(toOrderItem(v));
    }
  }
  return { items };
}

export const DOWNLOAD_TTL_SEC = 3600;

export async function sheetDownloadUrls(sheet: SheetRow, ttlSec = DOWNLOAD_TTL_SEC) {
  const base = sheet.name.replace(/[^0-9A-Za-z-]+/g, "_");
  return {
    png: sheet.pngKey ? await presignGet(sheet.pngKey, ttlSec, `${base}.png`) : null,
    pdf: sheet.pdfKey ? await presignGet(sheet.pdfKey, ttlSec, `${base}.pdf`) : null,
    preview: sheet.previewKey ? await presignGet(sheet.previewKey, ttlSec) : null,
    expiresAt: new Date(Date.now() + ttlSec * 1000).toISOString(),
  };
}

export async function downloadUrls(tx: Tx, _ctx: TenantContext, id: string) {
  const [sheet] = await tx.select().from(gangSheets).where(eq(gangSheets.id, id)).limit(1);
  if (!sheet) throw notFound("gang sheet", id);
  return sheetDownloadUrls(sheet);
}

export function assertSheetFiles(sheet: SheetRow) {
  if (!sheet.pngKey && !sheet.pdfKey) throw badRequest("Sheet has no files yet");
}
