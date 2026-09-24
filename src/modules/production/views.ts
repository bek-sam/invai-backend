import type { OrderItem, QueueItem } from "@invai/contracts";
import { eq, inArray, sql } from "drizzle-orm";
import type { Tx } from "../../db/client";
import { blankVariants, designs, gangSheets, orderItems, orders } from "../../db/schema";

/*
 * Read models shared by the sheet and floor code: one order item joined with its order number,
 * design, blank and current bin/sheet. Order items belong to the orders module; production only
 * reads them here and keeps its denormalized pointers (transferId, gangSheetId, binId, isReprint).
 */

export type OrderItemRow = typeof orderItems.$inferSelect;

export type BlankRef = {
  variantId: string;
  brand: string;
  style: string;
  styleCode: string;
  color: string;
  colorCode: string;
  size: string;
  sizeCode: string;
  sku: string;
  supplierSku: string;
  weightOz: number;
};

export type ItemView = {
  item: OrderItemRow;
  orderNo: string;
  orderShipBy: Date;
  design: { id: string; name: string; code: string; templateId: string | null } | null;
  blank: BlankRef | null;
  binCode: string | null;
  sheetName: string | null;
};

const binOfOrder = sql<
  string | null
>`(select b.code from bins b where b.order_id = ${orderItems.orderId} order by b.updated_at desc limit 1)`;

export function blankRef(b: typeof blankVariants.$inferSelect): BlankRef {
  return {
    variantId: b.id,
    brand: b.brand,
    style: b.style,
    styleCode: b.styleCode,
    color: b.color,
    colorCode: b.colorCode,
    size: b.size,
    sizeCode: b.sizeCode,
    sku: b.sku,
    supplierSku: b.supplierSku,
    weightOz: b.weightOz,
  };
}

async function selectViews(tx: Tx, where: ReturnType<typeof inArray>) {
  const rows = await tx
    .select({
      item: orderItems,
      orderNo: orders.orderNo,
      orderShipBy: orders.shipBy,
      design: designs,
      blank: blankVariants,
      binCode: binOfOrder,
      sheetName: gangSheets.name,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .leftJoin(designs, eq(designs.id, orderItems.designId))
    .leftJoin(blankVariants, eq(blankVariants.id, orderItems.blankVariantId))
    .leftJoin(gangSheets, eq(gangSheets.id, orderItems.gangSheetId))
    .where(where);
  return rows.map(
    (r): ItemView => ({
      item: r.item,
      orderNo: r.orderNo,
      orderShipBy: r.orderShipBy,
      design: r.design
        ? {
            id: r.design.id,
            name: r.design.name,
            code: r.design.code,
            templateId: r.design.personalizationTemplateId,
          }
        : null,
      blank: r.blank ? blankRef(r.blank) : null,
      binCode: r.binCode,
      sheetName: r.sheetName ?? null,
    }),
  );
}

export async function loadItemViews(tx: Tx, itemIds: string[]): Promise<Map<string, ItemView>> {
  if (!itemIds.length) return new Map();
  const views = await selectViews(tx, inArray(orderItems.id, itemIds));
  return new Map(views.map((v) => [v.item.id, v]));
}

export async function loadItemView(tx: Tx, itemId: string): Promise<ItemView | null> {
  return (await loadItemViews(tx, [itemId])).get(itemId) ?? null;
}

export async function loadOrderViews(tx: Tx, orderIds: string[]): Promise<ItemView[]> {
  if (!orderIds.length) return [];
  return selectViews(tx, inArray(orderItems.orderId, orderIds));
}

type Placement = QueueItem["placement"];
const PLACEMENTS: Placement[] = ["front", "back", "left_chest", "sleeve_left", "sleeve_right"];
export const placementOf = (p: string | null): Placement =>
  PLACEMENTS.includes(p as Placement) ? (p as Placement) : "front";

const OPEN_BEFORE_PACKED = new Set([
  "imported",
  "needs_mapping",
  "ready",
  "needs_artwork",
  "on_sheet",
  "transfer_in",
  "pressed",
  "on_hold",
]);

/** Units of an order still short of `packed` (cancelled units don't count). */
export async function openUnitsByOrder(tx: Tx, orderIds: string[]) {
  const out = new Map<string, { beforePacked: number; unshipped: number }>();
  if (!orderIds.length) return out;
  const rows = await tx
    .select({ orderId: orderItems.orderId, state: orderItems.state })
    .from(orderItems)
    .where(inArray(orderItems.orderId, [...new Set(orderIds)]));
  for (const r of rows) {
    const cur = out.get(r.orderId) ?? { beforePacked: 0, unshipped: 0 };
    if (OPEN_BEFORE_PACKED.has(r.state)) cur.beforePacked++;
    if (r.state !== "cancelled" && r.state !== "shipped" && r.state !== "delivered")
      cur.unshipped++;
    out.set(r.orderId, cur);
  }
  return out;
}

const emptyBlank = (id: string | null) => ({
  variantId: id ?? "00000000-0000-0000-0000-000000000000",
  brand: "",
  style: "",
  color: "",
  size: "",
});

export function toQueueItem(v: ItemView, orderOpenUnits: number): QueueItem {
  const i = v.item;
  return {
    orderItemId: i.id,
    orderId: i.orderId,
    orderNo: v.orderNo,
    state: i.state,
    shipBy: i.shipBy.toISOString(),
    isRush: i.isRush,
    isReprint: i.isReprint,
    design: v.design
      ? { id: v.design.id, name: v.design.name, code: v.design.code }
      : { id: i.designId ?? "00000000-0000-0000-0000-000000000000", name: i.title, code: "" },
    placement: placementOf(i.placement),
    blank: v.blank
      ? {
          variantId: v.blank.variantId,
          brand: v.blank.brand,
          style: v.blank.style,
          color: v.blank.color,
          size: v.blank.size,
        }
      : emptyBlank(i.blankVariantId),
    artworkPreviewKey: i.artworkPreviewKey,
    transferId: i.transferId,
    sheetId: i.gangSheetId,
    sheetName: v.sheetName,
    binCode: v.binCode,
    orderOpenUnits,
  };
}

export function toOrderItem(v: ItemView): OrderItem {
  const i = v.item;
  return {
    id: i.id,
    orderId: i.orderId,
    orderNo: v.orderNo,
    lineNo: Math.max(1, i.lineNo),
    unitNo: Math.max(1, i.unitNo),
    unitsInLine: Math.max(1, i.unitsInLine),
    channelSku: i.channelSku,
    channelListingId: i.channelListingId,
    title: i.title,
    variantTitle: i.variantTitle,
    unitPrice: i.unitPriceCents,
    personalization: i.personalization,
    state: i.state,
    heldFromState: i.heldFromState,
    design: v.design ? { id: v.design.id, name: v.design.name } : null,
    product: null,
    blank: v.blank
      ? {
          variantId: v.blank.variantId,
          brand: v.blank.brand,
          style: v.blank.style,
          color: v.blank.color,
          size: v.blank.size,
        }
      : null,
    placement: i.placement,
    artwork: { status: i.artworkStatus, fileKey: i.artworkKey, previewKey: i.artworkPreviewKey },
    flags: i.flags.filter((f) => f.active) as OrderItem["flags"],
    isRush: i.isRush,
    isReprint: i.isReprint,
    transferId: i.transferId,
    sheetId: i.gangSheetId,
    binCode: v.binCode,
    shipmentId: i.shipmentId,
    shipBy: i.shipBy.toISOString(),
    updatedAt: i.updatedAt.toISOString(),
  };
}

/** Offset cursors for computed (non keyset) lists such as station queues. */
export function offsetCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const n = Number.parseInt(Buffer.from(cursor, "base64url").toString("utf8"), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
export const nextOffsetCursor = (offset: number, pageLen: number, total: number) =>
  offset + pageLen < total ? Buffer.from(String(offset + pageLen)).toString("base64url") : null;
