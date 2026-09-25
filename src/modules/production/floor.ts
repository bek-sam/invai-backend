import type {
  Bin,
  OrderItemState,
  PackOrderInput,
  PackOrderResult,
  PackOverride,
  QcInput as QcInputSchema,
  REPRINT_REASONS,
  Reprint,
  ScanInput as ScanInputSchema,
  ScanResult,
  StationQueue as StationQueueSchema,
} from "@invai/contracts";
import { and, desc, eq, gte, inArray, lte, or, type SQL, sql } from "drizzle-orm";
import type { z } from "zod";
import type { TenantContext } from "../../api/context";
import { afterCommit, type Tx } from "../../db/client";
import type { StationKind } from "../../db/schema";
import {
  bins,
  blankVariants,
  companies,
  floorRequests,
  orderItems,
  orders,
  reprints,
  scans,
  transfers,
  users,
} from "../../db/schema";
import { env } from "../../env";
import { audit } from "../../lib/audit";
import {
  badRequest,
  conflict,
  forbidden,
  invalidTransition,
  notFound,
  ORPCError,
  upstream,
} from "../../lib/errors";
import { emit } from "../../lib/outbox";
import { keyset, type PageInput } from "../../lib/pagination";
import { publish } from "../../lib/realtime";
import { objectKey } from "../../lib/s3";
import { consumeForItem } from "../inventory/service";
import { recomputeOrderStatus, transitionItem } from "../orders/state-machine";
import { type MatchOutcome, matchScan, type ScanAction, type SecondCode } from "./matcher";
import {
  blankRef,
  type ItemView,
  loadItemView,
  loadItemViews,
  nextOffsetCursor,
  offsetCursor,
  openUnitsByOrder,
  placementOf,
  toOrderItem,
  toQueueItem,
} from "./views";

/*
 * The production floor: station queues, the scan check, QC (pass -> packed, fail -> reprint),
 * bins/totes and staff output. Scans never throw for business outcomes; they return a
 * ScanResult and are idempotent on `clientScanId` (the stored result is returned verbatim).
 */

type ScanInput = z.infer<typeof ScanInputSchema>;
type QcInput = z.infer<typeof QcInputSchema>;
type StationQueue = z.infer<typeof StationQueueSchema>;
type Station = StationKind;
type ReprintReason = (typeof REPRINT_REASONS)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* --------------------------------- queues --------------------------------- */

export type QueueInput = PageInput & { station: Station; stationId?: string; orderId?: string };

async function startOfToday(tx: Tx, companyId: string): Promise<Date> {
  const [c] = await tx
    .select({ tz: companies.timezone })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  const tz = c?.tz ?? "UTC";
  const res = await tx.execute<{ start: string }>(
    sql`select (date_trunc('day', now() at time zone ${tz}) at time zone ${tz})::text as start`,
  );
  return new Date(res.rows[0]?.start ?? new Date().toISOString().slice(0, 10));
}

/** Item ids with an ok pick scan for their current transfer. */
async function pickedItems(tx: Tx, itemIds: string[]): Promise<Set<string>> {
  if (!itemIds.length) return new Set();
  const rows = await tx
    .select({ id: scans.orderItemId })
    .from(scans)
    .innerJoin(orderItems, eq(orderItems.id, scans.orderItemId))
    .where(
      and(
        inArray(scans.orderItemId, itemIds),
        eq(scans.action, "pick"),
        eq(scans.ok, true),
        sql`${scans.transferId} = ${orderItems.transferId}`,
      ),
    );
  return new Set(rows.map((r) => r.id as string));
}

/** Order ids whose non-cancelled units are all packed (the pack station's orders). */
async function completePackedOrders(tx: Tx, orderId?: string) {
  const rows = await tx
    .select({ orderId: orderItems.orderId })
    .from(orderItems)
    .where(orderId ? eq(orderItems.orderId, orderId) : undefined)
    .groupBy(orderItems.orderId)
    .having(
      sql`bool_and(${orderItems.state} in ('packed', 'cancelled')) and bool_or(${orderItems.state} = 'packed')`,
    );
  return rows.map((r) => r.orderId);
}

/** Orders where every packed unit already has an ok pack scan (the packer finished them). */
async function packFinishedOrders(tx: Tx, orderIds: string[]) {
  if (!orderIds.length) return new Set<string>();
  const rows = await tx
    .select({ orderId: orderItems.orderId })
    .from(orderItems)
    .where(and(inArray(orderItems.orderId, orderIds), eq(orderItems.state, "packed")))
    .groupBy(orderItems.orderId)
    .having(
      sql`bool_and(exists (select 1 from scans s where s.order_item_id = ${orderItems.id} and s.action = 'pack' and s.ok))`,
    );
  return new Set(rows.map((r) => r.orderId));
}

async function stationItemIds(tx: Tx, station: Station, orderId?: string): Promise<string[]> {
  // Receiving checks in POs and vendor sheets, not order units: it has no unit queue.
  if (station === "receiving") return [];
  const byOrder = orderId ? eq(orderItems.orderId, orderId) : undefined;
  if (station === "pack") {
    const complete = await completePackedOrders(tx, orderId);
    const finished = await packFinishedOrders(tx, complete);
    const open = complete.filter((o) => !finished.has(o));
    if (!open.length) return [];
    const rows = await tx
      .select({ id: orderItems.id })
      .from(orderItems)
      .where(and(inArray(orderItems.orderId, open), eq(orderItems.state, "packed")));
    return rows.map((r) => r.id);
  }
  const state = station === "qc" ? "pressed" : "transfer_in";
  const rows = await tx
    .select({ id: orderItems.id })
    .from(orderItems)
    .where(and(eq(orderItems.state, state), byOrder, sql`${orderItems.transferId} is not null`));
  const ids = rows.map((r) => r.id);
  if (station === "pick") {
    const picked = await pickedItems(tx, ids);
    return ids.filter((id) => !picked.has(id));
  }
  return ids;
}

export async function stationQueue(
  tx: Tx,
  ctx: TenantContext,
  input: QueueInput,
): Promise<StationQueue> {
  const ids = await stationItemIds(tx, input.station, input.orderId);
  const views = [...(await loadItemViews(tx, ids)).values()];
  const picked = input.station === "press" ? await pickedItems(tx, ids) : new Set<string>();
  views.sort(
    (a, b) =>
      Number(picked.has(b.item.id)) - Number(picked.has(a.item.id)) ||
      Number(b.item.isRush) - Number(a.item.isRush) ||
      a.item.shipBy.getTime() - b.item.shipBy.getTime() ||
      (input.station === "pick" ? (a.blank?.sku ?? "").localeCompare(b.blank?.sku ?? "") : 0) ||
      a.orderNo.localeCompare(b.orderNo) ||
      a.item.unitNo - b.item.unitNo,
  );
  if (input.station === "pack") {
    // Keep each order's units together, orders in ship-by order.
    const firstIdx = new Map<string, number>();
    views.forEach((v, i) => {
      if (!firstIdx.has(v.item.orderId)) firstIdx.set(v.item.orderId, i);
    });
    views.sort(
      (a, b) =>
        (firstIdx.get(a.item.orderId) ?? 0) - (firstIdx.get(b.item.orderId) ?? 0) ||
        a.item.lineNo - b.item.lineNo ||
        a.item.unitNo - b.item.unitNo,
    );
  }
  const offset = offsetCursor(input.cursor);
  const page = views.slice(offset, offset + input.limit);
  const open = await openUnitsByOrder(
    tx,
    page.map((v) => v.item.orderId),
  );
  const since = await startOfToday(tx, ctx.companyId);
  const [done] = await tx
    .select({ n: sql<number>`count(distinct ${scans.orderItemId})`.mapWith(Number) })
    .from(scans)
    .where(and(eq(scans.station, input.station), eq(scans.ok, true), gte(scans.scannedAt, since)));
  return {
    station: input.station,
    items: page.map((v) => {
      const o = open.get(v.item.orderId);
      return toQueueItem(v, (input.station === "pack" ? o?.unshipped : o?.beforePacked) ?? 0);
    }),
    nextCursor: nextOffsetCursor(offset, page.length, views.length),
    counts: { waiting: views.length, doneToday: done?.n ?? 0 },
  };
}

async function publishQueues(tx: Tx, companyId: string, stationsTouched: Station[]) {
  const counts: { station: Station; waiting: number }[] = [];
  for (const s of new Set(stationsTouched))
    counts.push({ station: s, waiting: (await stationItemIds(tx, s)).length });
  afterCommit(tx, async () => {
    for (const c of counts) await publish(companyId, { type: "queue.changed", data: c });
  });
}

/* ---------------------------------- scans ---------------------------------- */

type ResolvedTransfer = {
  transfer: typeof transfers.$inferSelect | null;
  view: ItemView | null;
};

/** `T:<transferId>`, a bare transfer id, or an order item id (the item's current transfer). */
async function resolveTransfer(tx: Tx, code: string): Promise<ResolvedTransfer> {
  const raw = code.trim();
  const id = /^t:/i.test(raw) ? raw.slice(2).trim() : raw;
  if (!UUID.test(id)) return { transfer: null, view: null };
  let [transfer] = await tx.select().from(transfers).where(eq(transfers.id, id)).limit(1);
  let itemId = transfer?.orderItemId ?? null;
  if (!transfer) {
    const [item] = await tx
      .select({ id: orderItems.id, transferId: orderItems.transferId })
      .from(orderItems)
      .where(eq(orderItems.id, id))
      .limit(1);
    if (!item?.transferId) return { transfer: null, view: null };
    [transfer] = await tx
      .select()
      .from(transfers)
      .where(eq(transfers.id, item.transferId))
      .limit(1);
    itemId = item.id;
  }
  if (!transfer || !itemId) return { transfer: null, view: null };
  // Serialize concurrent scans of the same unit.
  await tx
    .select({ id: orderItems.id })
    .from(orderItems)
    .where(eq(orderItems.id, itemId))
    .for("update");
  return { transfer, view: await loadItemView(tx, itemId) };
}

/** Blank label `B:<variantId|sku>`, a supplier UPC/SKU, a tote `BIN:<code>` or another transfer. */
async function resolveSecond(
  tx: Tx,
  code: string | null,
  itemId: string | null,
): Promise<SecondCode> {
  const raw = code?.trim();
  if (!raw) return { kind: "none" };
  if (/^bin:/i.test(raw)) {
    const binCode = raw.slice(4).trim();
    const [bin] = await tx.select().from(bins).where(eq(bins.code, binCode)).limit(1);
    const picked = itemId ? (await pickedItems(tx, [itemId])).has(itemId) : false;
    return { kind: "bin", code: binCode, orderId: bin?.orderId ?? null, picked };
  }
  if (/^t:/i.test(raw)) {
    const r = await resolveTransfer(tx, raw);
    return {
      kind: "transfer",
      orderId: r.view?.item.orderId ?? null,
      designId: r.view?.item.designId ?? null,
    };
  }
  const value = /^b:/i.test(raw) ? raw.slice(2).trim() : raw;
  const [blank] = UUID.test(value)
    ? await tx.select().from(blankVariants).where(eq(blankVariants.id, value)).limit(1)
    : await tx
        .select()
        .from(blankVariants)
        .where(or(eq(blankVariants.sku, value), eq(blankVariants.supplierSku, value)))
        .limit(1);
  return { kind: "blank", blank: blank ? blankRef(blank) : null };
}

/** Null: the station has no transfer-scan step (receiving uses its own procedures). */
const DEFAULT_ACTION: Record<Station, ScanAction | null> = {
  pick: "pick",
  press: "press",
  qc: "qc_pass",
  pack: "pack",
  receiving: null,
};

const NO_SCAN_STEP: MatchOutcome = {
  ok: false,
  mismatch: "wrong_station",
  message: "This station doesn't scan transfers",
  nextAction: "nothing",
  moveTo: null,
};

function buildResult(
  input: ScanInput,
  r: ResolvedTransfer,
  second: SecondCode,
  outcome: MatchOutcome,
  after: { state: ItemView["item"]["state"] | null; openUnits: number | null },
): ScanResult {
  const v = r.view;
  return {
    ok: outcome.ok,
    clientScanId: input.clientScanId,
    mismatch: outcome.mismatch,
    message: outcome.message,
    transferId: r.transfer?.id ?? null,
    orderItemId: v?.item.id ?? null,
    orderId: v?.item.orderId ?? null,
    orderNo: v?.orderNo ?? null,
    design: v?.design ? { id: v.design.id, name: v.design.name, code: v.design.code } : null,
    expected: v?.blank
      ? {
          blankVariantId: v.blank.variantId,
          brand: v.blank.brand,
          style: v.blank.style,
          color: v.blank.color,
          size: v.blank.size,
        }
      : null,
    scannedBlank:
      second.kind === "blank" && second.blank
        ? {
            blankVariantId: second.blank.variantId,
            brand: second.blank.brand,
            style: second.blank.style,
            color: second.blank.color,
            size: second.blank.size,
          }
        : null,
    placement: v ? placementOf(v.item.placement) : null,
    isReprint: v?.item.isReprint ?? false,
    binCode: v?.binCode ?? null,
    itemState: after.state,
    nextAction: outcome.nextAction,
    orderOpenUnits: after.openUnits,
  };
}

async function storedResult(tx: Tx, clientScanId: string): Promise<ScanResult | null> {
  const [prior] = await tx
    .select({ result: scans.result })
    .from(scans)
    .where(eq(scans.clientScanId, clientScanId))
    .limit(1);
  return prior ? (prior.result as ScanResult) : null;
}

/**
 * One station scan. Returns the stored result for a repeated clientScanId. A press match moves
 * the item transfer_in -> pressed and consumes the blank; QC actions go through `qc()`.
 */
export async function scan(tx: Tx, ctx: TenantContext, input: ScanInput): Promise<ScanResult> {
  const replay = await storedResult(tx, input.clientScanId);
  if (replay) return replay;
  const action = input.action ?? DEFAULT_ACTION[input.station];
  // Nothing to record or move: answer the same way every time, so a replay needs no stored row.
  if (!action)
    return buildResult(input, { transfer: null, view: null }, { kind: "none" }, NO_SCAN_STEP, {
      state: null,
      openUnits: null,
    });
  const stationId = input.stationId ?? ctx.station?.id ?? null;
  const resolved = await resolveTransfer(tx, input.transferCode);
  // A concurrent replay may have committed while we waited for the row lock.
  const raced = await storedResult(tx, input.clientScanId);
  if (raced) return raced;
  const v = resolved.view;
  const second = await resolveSecond(tx, input.blankCode, v?.item.id ?? null);
  const outcome = matchScan({
    action,
    scannedAt: new Date(input.scannedAt),
    transfer: resolved.transfer
      ? {
          id: resolved.transfer.id,
          scrapped: resolved.transfer.scrapped,
          status: resolved.transfer.status,
        }
      : null,
    item: v
      ? {
          id: v.item.id,
          orderId: v.item.orderId,
          state: v.item.state,
          transferId: v.item.transferId,
          designId: v.item.designId,
          stateChangedAt: v.item.stateChangedAt,
        }
      : null,
    expected: v?.blank ?? null,
    second,
  });

  let state = v?.item.state ?? null;
  if (outcome.ok && v && resolved.transfer) {
    if (outcome.moveTo === "pressed") {
      await transitionItem(tx, v.item.id, "pressed", {
        actor: ctx.actor,
        stationKind: input.station,
        reason: "scan match",
        data: { transferId: resolved.transfer.id, clientScanId: input.clientScanId },
      });
      await tx
        .update(transfers)
        .set({ status: "pressed", pressedAt: new Date() })
        .where(eq(transfers.id, resolved.transfer.id));
      await consumeForItem(tx, ctx, v.item.id);
      state = "pressed";
    } else if (action === "qc_pass" || action === "qc_fail") {
      await qcTransition(tx, ctx, v, {
        result: action === "qc_pass" ? "pass" : "fail",
        reason: "other",
        note: "QC fail by scan",
        blankReusable: false,
        stationId,
      });
      state = action === "qc_pass" ? "packed" : "ready";
    }
  }
  const openUnits = v
    ? ((await openUnitsByOrder(tx, [v.item.orderId])).get(v.item.orderId)?.beforePacked ?? 0)
    : null;
  const result = buildResult(input, resolved, second, outcome, { state, openUnits });

  const [row] = await tx
    .insert(scans)
    .values({
      companyId: ctx.companyId,
      clientScanId: input.clientScanId,
      stationId,
      station: input.station,
      action,
      userId: ctx.userId,
      transferCode: input.transferCode,
      blankCode: input.blankCode,
      transferId: resolved.transfer?.id ?? null,
      orderItemId: v?.item.id ?? null,
      ok: result.ok,
      mismatch: result.mismatch,
      result,
      scannedAt: new Date(input.scannedAt),
    })
    .onConflictDoNothing()
    .returning({ id: scans.id });
  if (!row) return (await storedResult(tx, input.clientScanId)) ?? result;

  await emit(tx, ctx.companyId, "scan.recorded", {
    scanId: row.id,
    clientScanId: input.clientScanId,
    station: input.station,
    stationId,
    ok: result.ok,
    orderItemId: result.orderItemId,
  });
  afterCommit(tx, () =>
    publish(ctx.companyId, {
      type: "scan.result",
      data: {
        clientScanId: input.clientScanId,
        stationId,
        station: input.station,
        ok: result.ok,
        orderItemId: result.orderItemId,
        orderNo: result.orderNo,
        mismatch: result.mismatch,
      },
    }).then(() => undefined),
  );
  if (outcome.ok) {
    const touched: Station[] =
      action === "pick"
        ? ["pick", "press"]
        : action === "press"
          ? ["press", "qc"]
          : action === "pack"
            ? ["pack"]
            : ["qc", "pack"];
    await publishQueues(tx, ctx.companyId, touched);
  }
  return result;
}

/* ------------------------------------ QC ----------------------------------- */

export function toReprint(row: typeof reprints.$inferSelect, orderNo: string): Reprint {
  return {
    id: row.id,
    orderItemId: row.orderItemId,
    orderNo,
    reason: row.reason,
    note: row.note,
    status: row.status,
    originalTransferId: row.originalTransferId,
    newTransferId: row.newTransferId,
    requestedBy: row.requestedBy,
    requestedAt: row.requestedAt.toISOString(),
  };
}

/**
 * Send an item back for a new transfer: the current transfer is scrap, a reprint row is opened
 * and the item is flagged `isReprint`. From `pressed` the item moves to `ready`; items still
 * on_sheet/transfer_in (a lost transfer) keep their state and wait for the next batch.
 */
async function openReprint(
  tx: Tx,
  ctx: TenantContext,
  v: ItemView,
  input: {
    reason: ReprintReason;
    note: string | null;
    blankReusable: boolean;
    stationId: string | null;
    via: "qc" | "request";
  },
) {
  const original = v.item.transferId;
  if (original)
    await tx
      .update(transfers)
      .set({ scrapped: true, status: "scrap" })
      .where(eq(transfers.id, original));
  if (v.item.state === "pressed") {
    await transitionItem(tx, v.item.id, "ready", {
      actor: ctx.actor,
      stationKind: input.via === "qc" ? "qc" : (ctx.station?.kind ?? null),
      reason: `reprint: ${input.reason}`,
      data: { transferId: original, blankReusable: input.blankReusable },
    });
  }
  await tx
    .update(orderItems)
    .set({ isReprint: true, transferId: null, gangSheetId: null })
    .where(eq(orderItems.id, v.item.id));
  const [row] = await tx
    .insert(reprints)
    .values({
      companyId: ctx.companyId,
      orderItemId: v.item.id,
      reason: input.reason,
      note: input.note,
      status: "requested",
      originalTransferId: original,
      blankConsumed: v.item.state === "pressed" && !input.blankReusable,
      stationId: input.stationId,
      requestedBy: ctx.userId,
    })
    .returning();
  if (!row) throw new Error("reprint insert failed");
  if (input.via === "qc")
    await emit(tx, ctx.companyId, "item.qc_failed", {
      orderItemId: v.item.id,
      reprintId: row.id,
      reason: input.reason,
    });
  await emit(tx, ctx.companyId, "reprint.requested", {
    reprintId: row.id,
    orderItemId: v.item.id,
    reason: input.reason,
  });
  await audit(tx, {
    companyId: ctx.companyId,
    actor: ctx.actor,
    action: "reprint.requested",
    entityType: "order_item",
    entityId: v.item.id,
    summary: `Reprint (${input.reason}) for ${v.orderNo}`,
    data: { reprintId: row.id, originalTransferId: original },
  });
  return row;
}

async function latestOpenReprint(tx: Tx, itemId: string) {
  const [row] = await tx
    .select()
    .from(reprints)
    .where(
      and(
        eq(reprints.orderItemId, itemId),
        inArray(reprints.status, ["requested", "on_sheet", "done"]),
      ),
    )
    .orderBy(desc(reprints.requestedAt))
    .limit(1);
  return row ?? null;
}

async function qcTransition(
  tx: Tx,
  ctx: TenantContext,
  v: ItemView,
  input: {
    result: "pass" | "fail";
    reason: ReprintReason | undefined;
    note: string | null;
    blankReusable: boolean;
    stationId: string | null;
  },
) {
  if (input.result === "pass") {
    await transitionItem(tx, v.item.id, "packed", {
      actor: ctx.actor,
      stationKind: "qc",
      reason: "QC pass",
      data: { transferId: v.item.transferId },
    });
    return null;
  }
  if (!input.reason) throw badRequest("reprintReason is required when QC fails");
  return openReprint(tx, ctx, v, {
    reason: input.reason,
    note: input.note,
    blankReusable: input.blankReusable,
    stationId: input.stationId,
    via: "qc",
  });
}

/**
 * QC pass (pressed -> packed) or fail (reprint, pressed -> ready). A replay of a QC whose item
 * already moved returns success with the same outcome instead of an error.
 */
export async function qc(tx: Tx, ctx: TenantContext, input: QcInput) {
  const [locked] = await tx
    .select({ id: orderItems.id })
    .from(orderItems)
    .where(eq(orderItems.id, input.orderItemId))
    .for("update");
  if (!locked) throw notFound("order_item", input.orderItemId);
  const v = await loadItemView(tx, input.orderItemId);
  if (!v) throw notFound("order_item", input.orderItemId);
  const stationId = input.stationId ?? ctx.station?.id ?? null;
  const state = v.item.state;
  if (input.result === "fail" && !input.reprintReason)
    throw badRequest("reprintReason is required when QC fails");

  let reprint: typeof reprints.$inferSelect | null = null;
  if (state === "pressed") {
    reprint = await qcTransition(tx, ctx, v, {
      result: input.result,
      reason: input.reprintReason,
      note: input.note,
      blankReusable: input.blankReusable,
      stationId,
    });
    await tx.insert(scans).values({
      companyId: ctx.companyId,
      clientScanId: crypto.randomUUID(),
      stationId,
      station: "qc",
      action: input.result === "pass" ? "qc_pass" : "qc_fail",
      userId: ctx.userId,
      transferCode: v.item.transferId ? `T:${v.item.transferId}` : v.item.id,
      transferId: v.item.transferId,
      orderItemId: v.item.id,
      ok: true,
      mismatch: null,
      result: { ok: true, qc: input.result, reprintReason: input.reprintReason ?? null },
      scannedAt: new Date(),
    });
    await publishQueues(tx, ctx.companyId, ["qc", "pack"]);
  } else if (input.result === "pass" && ["packed", "shipped", "delivered"].includes(state)) {
    // replayed pass
  } else if (
    input.result === "fail" &&
    v.item.isReprint &&
    ["ready", "on_sheet", "transfer_in"].includes(state)
  ) {
    reprint = await latestOpenReprint(tx, v.item.id);
    if (!reprint) throw invalidTransition("order_item", v.item.id, state, "ready");
  } else {
    throw invalidTransition(
      "order_item",
      v.item.id,
      state,
      input.result === "pass" ? "packed" : "ready",
    );
  }
  const fresh = await loadItemView(tx, v.item.id);
  return { item: toOrderItem(fresh ?? v), reprint: reprint ? toReprint(reprint, v.orderNo) : null };
}

/* -------------------------------- reprints -------------------------------- */

export async function requestReprint(
  tx: Tx,
  ctx: TenantContext,
  input: { orderItemId: string; reason: ReprintReason; note: string | null },
): Promise<Reprint> {
  const [locked] = await tx
    .select({ id: orderItems.id })
    .from(orderItems)
    .where(eq(orderItems.id, input.orderItemId))
    .for("update");
  if (!locked) throw notFound("order_item", input.orderItemId);
  const v = await loadItemView(tx, input.orderItemId);
  if (!v) throw notFound("order_item", input.orderItemId);
  if (!["on_sheet", "transfer_in", "pressed"].includes(v.item.state))
    throw invalidTransition("order_item", v.item.id, v.item.state, "ready");
  const open = await tx
    .select()
    .from(reprints)
    .where(and(eq(reprints.orderItemId, v.item.id), eq(reprints.status, "requested")))
    .limit(1);
  if (open[0] && !v.item.transferId) return toReprint(open[0], v.orderNo);
  const row = await openReprint(tx, ctx, v, {
    reason: input.reason,
    note: input.note,
    blankReusable: true,
    stationId: ctx.station?.id ?? null,
    via: "request",
  });
  await publishQueues(tx, ctx.companyId, ["pick", "press", "qc"]);
  return toReprint(row, v.orderNo);
}

export async function cancelReprint(tx: Tx, ctx: TenantContext, id: string): Promise<Reprint> {
  const [row] = await tx.select().from(reprints).where(eq(reprints.id, id)).for("update");
  if (!row) throw notFound("reprint", id);
  if (row.status !== "requested") throw conflictReprint(row.status);
  const [updated] = await tx
    .update(reprints)
    .set({ status: "cancelled" })
    .where(eq(reprints.id, id))
    .returning();
  await audit(tx, {
    companyId: ctx.companyId,
    actor: ctx.actor,
    action: "reprint.cancelled",
    entityType: "reprint",
    entityId: id,
    summary: "Reprint cancelled",
  });
  const [o] = await tx
    .select({ orderNo: orders.orderNo })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(eq(orderItems.id, row.orderItemId));
  return toReprint(updated ?? row, o?.orderNo ?? "");
}

const conflictReprint = (status: string) =>
  new ORPCError("CONFLICT", {
    status: 409,
    message: `Reprint is ${status}; only requested reprints can be cancelled`,
  });

export type ReprintListInput = PageInput & {
  status?: ("requested" | "on_sheet" | "done" | "cancelled")[] | undefined;
  reason?: ReprintReason | undefined;
  from?: string | undefined;
  to?: string | undefined;
};

export async function listReprints(tx: Tx, _ctx: TenantContext, input: ReprintListInput) {
  const page = keyset(reprints.createdAt, reprints.id, input);
  const filters: (SQL | undefined)[] = [page.where];
  if (input.status?.length) filters.push(inArray(reprints.status, input.status));
  if (input.reason) filters.push(eq(reprints.reason, input.reason));
  if (input.from) filters.push(gte(reprints.requestedAt, new Date(input.from)));
  if (input.to) filters.push(lte(reprints.requestedAt, new Date(input.to)));
  const rows = await tx
    .select({ r: reprints, orderNo: orders.orderNo })
    .from(reprints)
    .innerJoin(orderItems, eq(orderItems.id, reprints.orderItemId))
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(and(...filters))
    .orderBy(...page.orderBy)
    .limit(page.limit + 1);
  return page.result(
    rows.map((x) => ({ ...x, createdAt: x.r.createdAt, id: x.r.id })),
    (x) => toReprint(x.r, x.orderNo),
  );
}

export async function reprintStats(
  tx: Tx,
  _ctx: TenantContext,
  input: { from: string; to: string },
) {
  const from = new Date(input.from);
  const to = new Date(input.to);
  const rows = await tx
    .select({ reason: reprints.reason, n: sql<number>`count(*)`.mapWith(Number) })
    .from(reprints)
    .where(
      and(
        gte(reprints.requestedAt, from),
        lte(reprints.requestedAt, to),
        sql`${reprints.status} <> 'cancelled'`,
      ),
    )
    .groupBy(reprints.reason);
  const [pressed] = await tx
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(scans)
    .where(
      and(
        eq(scans.action, "press"),
        eq(scans.ok, true),
        gte(scans.scannedAt, from),
        lte(scans.scannedAt, to),
      ),
    );
  const total = rows.reduce((s, r) => s + r.n, 0);
  const p = pressed?.n ?? 0;
  return {
    total,
    pressed: p,
    rate: p > 0 ? Math.round((total / p) * 10000) / 10000 : 0,
    byReason: Object.fromEntries(rows.map((r) => [r.reason, r.n])),
  };
}

/** Count by reason and by week, for the reasons report chart (`stats` only has one flat total). */
export async function reprintReasonsByWeek(
  tx: Tx,
  _ctx: TenantContext,
  input: { from: string; to: string },
) {
  const from = new Date(input.from);
  const to = new Date(input.to);
  const weekStart = sql`date_trunc('week', ${reprints.requestedAt})`;
  const rows = await tx
    .select({
      weekStart: sql<string>`${weekStart}::date::text`.mapWith(String),
      reason: reprints.reason,
      n: sql<number>`count(*)`.mapWith(Number),
    })
    .from(reprints)
    .where(
      and(
        gte(reprints.requestedAt, from),
        lte(reprints.requestedAt, to),
        sql`${reprints.status} <> 'cancelled'`,
      ),
    )
    .groupBy(weekStart, reprints.reason)
    .orderBy(weekStart);
  const byWeek = new Map<
    string,
    { total: number; byReason: Partial<Record<ReprintReason, number>> }
  >();
  for (const r of rows) {
    const entry = byWeek.get(r.weekStart) ?? { total: 0, byReason: {} };
    entry.total += r.n;
    entry.byReason[r.reason] = r.n;
    byWeek.set(r.weekStart, entry);
  }
  const weeks = [...byWeek.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([weekStartDate, v]) => ({ weekStart: weekStartDate, ...v }));
  return { weeks };
}

/* ---------------------------------- bins ----------------------------------- */

async function binView(tx: Tx, row: typeof bins.$inferSelect): Promise<Bin> {
  let orderNo: string | null = null;
  let inBin = 0;
  let expected = 0;
  if (row.orderId) {
    const [o] = await tx
      .select({ orderNo: orders.orderNo })
      .from(orders)
      .where(eq(orders.id, row.orderId));
    orderNo = o?.orderNo ?? null;
    const states = await tx
      .select({ state: orderItems.state })
      .from(orderItems)
      .where(eq(orderItems.orderId, row.orderId));
    const live = states.filter((s) => s.state !== "cancelled");
    expected = live.length;
    inBin = live.filter((s) => ["transfer_in", "pressed", "packed"].includes(s.state)).length;
  }
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    locationId: row.locationId,
    orderId: row.orderId,
    orderNo,
    unitsInBin: inBin,
    unitsExpected: expected,
    station: (row.station as Bin["station"]) ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listBins(
  tx: Tx,
  _ctx: TenantContext,
  input: {
    locationId?: string | undefined;
    onlyOccupied: boolean;
    includeArchived: boolean;
  },
) {
  const filters: (SQL | undefined)[] = [];
  if (input.locationId) filters.push(eq(bins.locationId, input.locationId));
  if (input.onlyOccupied) filters.push(sql`${bins.orderId} is not null`);
  if (!input.includeArchived) filters.push(sql`${bins.archivedAt} is null`);
  const rows = await tx
    .select()
    .from(bins)
    .where(and(...filters))
    .orderBy(bins.code);
  const items: Bin[] = [];
  for (const r of rows) items.push(await binView(tx, r));
  return { items };
}

/** An order is done with its tote once nothing is left to pack or ship. */
async function orderFinished(tx: Tx, orderId: string) {
  const rows = await tx
    .select({ state: orderItems.state })
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId));
  return rows.every((r) => ["shipped", "delivered", "cancelled"].includes(r.state));
}

export async function assignBin(
  tx: Tx,
  ctx: TenantContext,
  input: { code: string; orderId: string },
): Promise<Bin> {
  const code = input.code.replace(/^bin:/i, "").trim();
  if (!code) throw badRequest("Bin code is empty");
  const [order] = await tx
    .select({ id: orders.id })
    .from(orders)
    .where(eq(orders.id, input.orderId));
  if (!order) throw notFound("order", input.orderId);
  const [existing] = await tx.select().from(bins).where(eq(bins.code, code)).for("update");
  if (
    existing?.orderId &&
    existing.orderId !== input.orderId &&
    !(await orderFinished(tx, existing.orderId))
  ) {
    const [o] = await tx
      .select({ orderNo: orders.orderNo })
      .from(orders)
      .where(eq(orders.id, existing.orderId));
    throw new ORPCError("BIN_OCCUPIED", {
      status: 409,
      message: "Bin holds another order",
      data: { orderNo: o?.orderNo ?? "" },
    });
  }
  const station = ctx.station?.kind ?? null;
  const [row] = existing
    ? await tx
        .update(bins)
        .set({ orderId: input.orderId, station, updatedAt: new Date() })
        .where(eq(bins.id, existing.id))
        .returning()
    : await tx
        .insert(bins)
        .values({ companyId: ctx.companyId, code, orderId: input.orderId, station })
        .returning();
  if (!row) throw new Error("bin upsert failed");
  // Any other tote this order sat in is free now.
  await tx
    .update(bins)
    .set({ orderId: null, updatedAt: new Date() })
    .where(and(eq(bins.orderId, input.orderId), sql`${bins.id} <> ${row.id}`));
  await tx.update(orderItems).set({ binId: row.id }).where(eq(orderItems.orderId, input.orderId));
  afterCommit(tx, () =>
    publish(ctx.companyId, { type: "bin.changed", data: { code, orderId: input.orderId } }).then(
      () => undefined,
    ),
  );
  return binView(tx, row);
}

export async function releaseBin(
  tx: Tx,
  ctx: TenantContext,
  input: { code: string },
): Promise<Bin> {
  const code = input.code.replace(/^bin:/i, "").trim();
  const [row] = await tx.select().from(bins).where(eq(bins.code, code)).for("update");
  if (!row) throw notFound("bin", code);
  const [updated] = await tx
    .update(bins)
    .set({ orderId: null, station: ctx.station?.kind ?? row.station, updatedAt: new Date() })
    .where(eq(bins.id, row.id))
    .returning();
  if (row.orderId) {
    await tx
      .update(orderItems)
      .set({ binId: null })
      .where(and(eq(orderItems.orderId, row.orderId), eq(orderItems.binId, row.id)));
    await publishQueues(tx, ctx.companyId, ["pack"]);
  }
  afterCommit(tx, () =>
    publish(ctx.companyId, { type: "bin.changed", data: { code, orderId: null } }).then(
      () => undefined,
    ),
  );
  return binView(tx, updated ?? row);
}

export async function createBin(
  tx: Tx,
  ctx: TenantContext,
  input: { code: string; name: string | null; locationId?: string | undefined },
): Promise<Bin> {
  const code = input.code.trim();
  const [existing] = await tx.select({ id: bins.id }).from(bins).where(eq(bins.code, code));
  if (existing)
    throw new ORPCError("CODE_TAKEN", {
      status: 409,
      message: "A bin with this code already exists",
    });
  const [row] = await tx
    .insert(bins)
    .values({ companyId: ctx.companyId, code, name: input.name, locationId: input.locationId })
    .returning();
  if (!row) throw new Error("bin insert failed");
  await audit(tx, {
    companyId: ctx.companyId,
    actor: ctx.actor,
    action: "bin.created",
    entityType: "bin",
    entityId: row.id,
    summary: `Bin ${code} created`,
  });
  return binView(tx, row);
}

export async function renameBin(
  tx: Tx,
  ctx: TenantContext,
  input: { id: string; name: string },
): Promise<Bin> {
  const [row] = await tx
    .update(bins)
    .set({ name: input.name, updatedAt: new Date() })
    .where(eq(bins.id, input.id))
    .returning();
  if (!row) throw notFound("bin", input.id);
  await audit(tx, {
    companyId: ctx.companyId,
    actor: ctx.actor,
    action: "bin.renamed",
    entityType: "bin",
    entityId: row.id,
    summary: `Bin ${row.code} renamed to ${input.name}`,
  });
  return binView(tx, row);
}

export async function archiveBin(tx: Tx, ctx: TenantContext, input: { id: string }): Promise<Bin> {
  const [row] = await tx.select().from(bins).where(eq(bins.id, input.id)).for("update");
  if (!row) throw notFound("bin", input.id);
  if (row.orderId)
    throw new ORPCError("BIN_OCCUPIED", { status: 409, message: "Bin holds an order" });
  const [updated] = await tx
    .update(bins)
    .set({ archivedAt: new Date(), updatedAt: new Date() })
    .where(eq(bins.id, row.id))
    .returning();
  await audit(tx, {
    companyId: ctx.companyId,
    actor: ctx.actor,
    action: "bin.archived",
    entityType: "bin",
    entityId: row.id,
    summary: `Bin ${row.code} archived`,
  });
  return binView(tx, updated ?? row);
}

/**
 * Renders a merged PDF of `BIN:` QR labels through imaging's `/labels/qr` endpoint (imaging
 * writes the PDF to S3 itself and hands back the key; shared shape with T-6-1's
 * inventory.blankLabels, which renders `B:<variantId>` labels the same way).
 */
export async function binLabels(
  tx: Tx,
  ctx: TenantContext,
  input: { binIds: string[] },
): Promise<{ key: string }> {
  const rows = await tx.select().from(bins).where(inArray(bins.id, input.binIds));
  if (!rows.length) throw notFound("bin", input.binIds[0]);
  const labels = rows.map((r) => ({
    code: `BIN:${r.code}`,
    caption: r.name ?? r.code,
    size: "4x6" as const,
  }));
  const out_key = objectKey(ctx.companyId, "labels", "pdf");
  const res = await fetch(`${env.IMAGING_URL}/labels/qr`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ labels, out_key }),
    signal: AbortSignal.timeout(120_000),
  }).catch((err) => {
    throw upstream("imaging", err instanceof Error ? err.message : String(err));
  });
  if (!res.ok) throw upstream("imaging", await res.text().catch(() => null));
  return { key: out_key };
}

/* ------------------------------- pack order -------------------------------- */

type PackMissing = PackOrderResult["missing"];
const PACKED_OR_LATER: OrderItemState[] = ["packed", "shipped", "delivered"];

const packIncomplete = (missing: PackMissing) =>
  new ORPCError("PACK_INCOMPLETE", {
    status: 409,
    message: "Units are still missing",
    data: { missing },
  });

/** What a replay must match to get the stored result back. */
const packRequestOf = (input: PackOrderInput) => ({
  orderId: input.orderId,
  overrideReason: input.override?.reason ?? null,
});

/**
 * "Mark packed" (decision 0002): every non-cancelled unit must be packed (or already shipped).
 * Otherwise it throws PACK_INCOMPLETE with the missing units, unless `override` is set by
 * someone with `production.override`: then the order is handed to a lead, not packed. The
 * reason is recorded (`orders.pack_override`, cleared once every unit is really packed), the
 * tote is released, the status stays what the units say, and `packed: false` comes back with
 * the missing units. A split shipment isn't supported, so a short order never reaches the ship
 * queue. On a real pack the tote is released and packed units without a pack scan get one, so
 * the order leaves the pack queue. Idempotent on `idempotencyKey`: the first effective result is stored
 * in `floor_requests` and returned verbatim; a refusal has no effect and isn't stored.
 */
export async function packOrder(
  tx: Tx,
  ctx: TenantContext,
  input: PackOrderInput,
): Promise<PackOrderResult> {
  if (input.override && !ctx.permissions.has("production.override"))
    throw forbidden("production.override", "Only an owner or admin can hand an order to a lead");

  // Serializes packs of one order, so a same-key retry waits and then finds the stored result.
  const [order] = await tx
    .select({
      id: orders.id,
      orderNo: orders.orderNo,
      status: orders.status,
      shipBy: orders.shipBy,
    })
    .from(orders)
    .where(eq(orders.id, input.orderId))
    .for("update");
  if (!order) throw notFound("order", input.orderId);

  const request = packRequestOf(input);
  const stored = async () => {
    const [prior] = await tx
      .select({ request: floorRequests.request, result: floorRequests.result })
      .from(floorRequests)
      .where(
        and(
          eq(floorRequests.kind, "pack_order"),
          eq(floorRequests.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);
    if (!prior) return null;
    const same =
      prior.request.orderId === request.orderId &&
      (prior.request.overrideReason ?? null) === request.overrideReason;
    if (!same) throw conflict("This idempotencyKey was already used for a different pack");
    return prior.result as PackOrderResult;
  };
  const replay = await stored();
  if (replay) return replay;

  if (order.status === "on_hold") throw conflict("Order is on hold; release it before packing");
  const items = await tx
    .select({
      id: orderItems.id,
      state: orderItems.state,
      lineNo: orderItems.lineNo,
      unitNo: orderItems.unitNo,
    })
    .from(orderItems)
    .where(eq(orderItems.orderId, order.id))
    .orderBy(orderItems.lineNo, orderItems.unitNo);
  const open = items.filter((i) => i.state !== "cancelled");
  if (!open.length) throw conflict("Order has no units left to pack");
  const missing: PackMissing = open
    .filter((i) => !PACKED_OR_LATER.includes(i.state))
    .map((i) => ({ orderItemId: i.id, state: i.state }));
  if (missing.length && !input.override) throw packIncomplete(missing);

  let override: PackOverride | null = null;
  if (missing.length && input.override) {
    if (!ctx.userId) throw forbidden("production.override", "Sign in as a person to hand it over");
    override = {
      reason: input.override.reason,
      by: ctx.userId,
      byName: ctx.user?.name ?? "",
      at: new Date().toISOString(),
      missingItemIds: missing.map((m) => m.orderItemId),
    };
    await tx.update(orders).set({ packOverride: override }).where(eq(orders.id, order.id));
    await audit(tx, {
      companyId: ctx.companyId,
      actor: ctx.actor,
      action: "order.pack_override",
      entityType: "order",
      entityId: order.id,
      summary: `${order.orderNo} handed to a lead with ${missing.length} unit(s) missing: ${override.reason}`,
      data: { reason: override.reason, missing },
    });
  }
  const status = await recomputeOrderStatus(tx, ctx.companyId, order.id);
  const packed = missing.length === 0;

  // Packed units the packer didn't scan one by one still count as packed by this person.
  const packedIds = packed ? open.filter((i) => i.state === "packed").map((i) => i.id) : [];
  const scanned = packedIds.length
    ? await tx
        .select({ id: scans.orderItemId })
        .from(scans)
        .where(
          and(inArray(scans.orderItemId, packedIds), eq(scans.action, "pack"), eq(scans.ok, true)),
        )
    : [];
  const hasScan = new Set(scanned.map((r) => r.id));
  const stationId = ctx.station?.id ?? null;
  for (const id of packedIds.filter((x) => !hasScan.has(x))) {
    const [t] = await tx
      .select({ transferId: orderItems.transferId })
      .from(orderItems)
      .where(eq(orderItems.id, id));
    await tx.insert(scans).values({
      companyId: ctx.companyId,
      clientScanId: crypto.randomUUID(),
      stationId,
      station: "pack",
      action: "pack",
      userId: ctx.userId,
      transferCode: t?.transferId ? `T:${t.transferId}` : id,
      transferId: t?.transferId ?? null,
      orderItemId: id,
      ok: true,
      mismatch: null,
      result: { ok: true, packOrder: input.idempotencyKey },
      scannedAt: new Date(),
    });
  }

  const totes = await tx.select({ code: bins.code }).from(bins).where(eq(bins.orderId, order.id));
  for (const b of totes) await releaseBin(tx, ctx, { code: b.code });

  const result: PackOrderResult = { orderId: order.id, packed, missing, override };
  const [row] = await tx
    .insert(floorRequests)
    .values({
      companyId: ctx.companyId,
      kind: "pack_order",
      idempotencyKey: input.idempotencyKey,
      orderId: order.id,
      request,
      result,
      userId: ctx.userId,
    })
    .onConflictDoNothing()
    .returning({ id: floorRequests.id });
  // Same key stored concurrently for another order (same-order packs are serialized above):
  // roll everything back rather than apply a second effect under one key.
  if (!row) throw conflict("This idempotencyKey was already used for a different pack");
  await audit(tx, {
    companyId: ctx.companyId,
    actor: ctx.actor,
    entityType: "order",
    entityId: order.id,
    action: packed ? "order.packed" : "order.handed_to_lead",
    summary: packed ? `Packed ${order.orderNo}` : `${order.orderNo} handed to a lead`,
    data: { idempotencyKey: input.idempotencyKey, override: !!override },
  });
  await publishQueues(tx, ctx.companyId, ["pack"]);
  const atRisk =
    !["shipped", "delivered", "cancelled"].includes(status) &&
    order.shipBy.getTime() <= Date.now() + 24 * 3600_000;
  afterCommit(tx, async () => {
    await publish(ctx.companyId, "order.updated", { orderId: order.id, status, atRisk });
  });
  return result;
}

/* ------------------------------ staff output ------------------------------- */

export async function staffOutput(
  tx: Tx,
  _ctx: TenantContext,
  input: { from: string; to: string },
) {
  const rows = await tx
    .select({
      userId: scans.userId,
      station: scans.station,
      units:
        sql<number>`count(distinct ${scans.orderItemId}) filter (where ${scans.ok} and ${scans.action} <> 'qc_fail')`.mapWith(
          Number,
        ),
      qcFails: sql<number>`count(*) filter (where ${scans.action} = 'qc_fail')`.mapWith(Number),
      name: users.name,
    })
    .from(scans)
    .innerJoin(users, eq(users.id, scans.userId))
    .where(
      and(gte(scans.scannedAt, new Date(input.from)), lte(scans.scannedAt, new Date(input.to))),
    )
    .groupBy(scans.userId, scans.station, users.name)
    .orderBy(users.name, scans.station);
  return {
    items: rows
      .filter((r) => r.userId && ["pick", "press", "qc", "pack"].includes(r.station))
      .map((r) => ({
        userId: r.userId as string,
        name: r.name,
        station: r.station as Station,
        units: r.units,
        qcFails: r.qcFails,
      })),
  };
}
