import { and, eq, inArray, sql } from "drizzle-orm";
import type { TenantContext } from "../../api/context";
import type { Tx } from "../../db/client";
import type { MovementKind } from "../../db/schema";
import { blankVariants, inventoryMovements, orderItems, stockLevels } from "../../db/schema";
import { emit } from "../../lib/outbox";
import { defaultLocationId as tenancyDefaultLocationId } from "../tenancy/service";

/*
 * The stock ledger. Every stock change is one append-only `inventory_movements` row plus a
 * delta on the `stock_levels` cache in the same transaction. Sign conventions:
 *   receive/return/adjust/count/scrap/consume  -> qty changes onHand (signed)
 *   reserve (+n) / release (+n)                -> reserved += n / reserved -= n (onHand untouched)
 * available = onHand - reserved.
 */

/** Pure: how a movement changes the cached counters. */
export function movementDelta(
  kind: MovementKind,
  qty: number,
): { onHand: number; reserved: number } {
  if (kind === "reserve") return { onHand: 0, reserved: qty };
  if (kind === "release") return { onHand: 0, reserved: -qty };
  return { onHand: qty, reserved: 0 };
}

/** Pure: did available cross from >= point to below it? */
export function crossedBelow(before: number, after: number, point: number | null): boolean {
  if (point == null) return false;
  return before >= point && after < point;
}

/** The company's default location (tenancy owns locations). */
export function defaultLocationId(tx: Tx, _companyId: string): Promise<string> {
  return tenancyDefaultLocationId(tx);
}

export type MovementInput = {
  blankVariantId: string;
  locationId: string;
  kind: MovementKind;
  qty: number;
  unitCostCents?: number | null;
  reason?: (typeof inventoryMovements.$inferInsert)["reason"];
  refType?: (typeof inventoryMovements.$inferInsert)["refType"];
  refId?: string | null;
  note?: string | null;
  idempotencyKey?: string | null;
};

export type RecordedMovement = typeof inventoryMovements.$inferSelect;

/**
 * Append one movement and apply it to the stock cache. Returns null when the idempotency key
 * was already used (the movement is not applied twice).
 */
export async function recordMovement(
  tx: Tx,
  ctx: Pick<TenantContext, "companyId" | "userId">,
  m: MovementInput,
): Promise<RecordedMovement | null> {
  const [row] = await tx
    .insert(inventoryMovements)
    .values({
      companyId: ctx.companyId,
      blankVariantId: m.blankVariantId,
      locationId: m.locationId,
      kind: m.kind,
      qty: m.qty,
      unitCostCents: m.unitCostCents ?? null,
      reason: m.reason ?? null,
      refType: m.refType ?? null,
      refId: m.refId ?? null,
      note: m.note ?? null,
      userId: ctx.userId ?? null,
      idempotencyKey: m.idempotencyKey ?? null,
    })
    .onConflictDoNothing()
    .returning();
  if (!row) return null;

  const d = movementDelta(m.kind, m.qty);
  const [before] = await tx
    .select({ available: stockLevels.available, reorderPoint: stockLevels.reorderPoint })
    .from(stockLevels)
    .where(
      and(
        eq(stockLevels.companyId, ctx.companyId),
        eq(stockLevels.blankVariantId, m.blankVariantId),
        eq(stockLevels.locationId, m.locationId),
      ),
    )
    .for("update");
  const [after] = await tx
    .insert(stockLevels)
    .values({
      companyId: ctx.companyId,
      blankVariantId: m.blankVariantId,
      locationId: m.locationId,
      onHand: d.onHand,
      reserved: d.reserved,
      available: d.onHand - d.reserved,
    })
    .onConflictDoUpdate({
      target: [stockLevels.companyId, stockLevels.blankVariantId, stockLevels.locationId],
      set: {
        onHand: sql`${stockLevels.onHand} + ${d.onHand}`,
        reserved: sql`${stockLevels.reserved} + ${d.reserved}`,
        available: sql`${stockLevels.available} + ${d.onHand - d.reserved}`,
        updatedAt: new Date(),
      },
    })
    .returning({ available: stockLevels.available, reorderPoint: stockLevels.reorderPoint });

  await emit(tx, ctx.companyId, "stock.movement", {
    movementId: row.id,
    blankVariantId: m.blankVariantId,
    locationId: m.locationId,
    kind: m.kind,
    qty: m.qty,
  });

  if (after && d.onHand - d.reserved !== 0) {
    let point = after.reorderPoint;
    if (point == null) {
      const [bv] = await tx
        .select({ rp: blankVariants.reorderPoint })
        .from(blankVariants)
        .where(eq(blankVariants.id, m.blankVariantId));
      point = bv?.rp ?? null;
    }
    const prev = before?.available ?? 0;
    if (crossedBelow(prev, after.available, point)) {
      await emit(tx, ctx.companyId, "stock.low", {
        blankVariantId: m.blankVariantId,
        locationId: m.locationId,
        available: after.available,
        reorderPoint: point ?? 0,
      });
    }
  }
  return row;
}

/** Emit one debounced availability event for the variants a call touched. */
async function availabilityChanged(tx: Tx, companyId: string, ids: Iterable<string>) {
  const blankVariantIds = [...new Set(ids)];
  if (blankVariantIds.length) {
    await emit(tx, companyId, "stock.availability_changed", { blankVariantIds });
  }
}

type ItemRow = { id: string; blankVariantId: string | null; isReprint: boolean };

async function loadItems(tx: Tx, companyId: string, itemIds: string[]): Promise<ItemRow[]> {
  if (!itemIds.length) return [];
  return tx
    .select({
      id: orderItems.id,
      blankVariantId: orderItems.blankVariantId,
      isReprint: orderItems.isReprint,
    })
    .from(orderItems)
    .where(and(eq(orderItems.companyId, companyId), inArray(orderItems.id, itemIds)));
}

/** Per item: movement counts by kind, plus the open reservation (reserve - release). */
async function itemLedger(tx: Tx, companyId: string, itemIds: string[]) {
  const out = new Map<
    string,
    {
      reserved: number;
      reserves: number;
      releases: number;
      consumes: number;
      scraps: number;
      locationId: string | null;
    }
  >();
  if (!itemIds.length) return out;
  const rows = await tx
    .select({
      refId: inventoryMovements.refId,
      kind: inventoryMovements.kind,
      n: sql<number>`count(*)::int`,
      qty: sql<number>`coalesce(sum(${inventoryMovements.qty}), 0)::int`,
      locationId: sql<string>`max(${inventoryMovements.locationId}::text)`,
    })
    .from(inventoryMovements)
    .where(
      and(
        eq(inventoryMovements.companyId, companyId),
        inArray(inventoryMovements.refType, ["order_item", "reprint"]),
        inArray(inventoryMovements.refId, itemIds),
      ),
    )
    .groupBy(inventoryMovements.refId, inventoryMovements.kind);
  for (const r of rows) {
    if (!r.refId) continue;
    const e = out.get(r.refId) ?? {
      reserved: 0,
      reserves: 0,
      releases: 0,
      consumes: 0,
      scraps: 0,
      locationId: null,
    };
    if (r.kind === "reserve") {
      e.reserves += r.n;
      e.reserved += r.qty;
      e.locationId = r.locationId;
    } else if (r.kind === "release") {
      e.releases += r.n;
      e.reserved -= r.qty;
    } else if (r.kind === "consume") e.consumes += r.n;
    else if (r.kind === "scrap") e.scraps += r.n;
    out.set(r.refId, e);
  }
  return out;
}

type Ctx = Pick<TenantContext, "companyId" | "userId">;

/**
 * Reserve one blank per item (items reaching `ready`). Items without a blank or already
 * holding a reservation are skipped. Returns the number of reservations written.
 */
export async function reserveForItems(tx: Tx, ctx: Ctx, itemIds: string[]): Promise<number> {
  const items = await loadItems(tx, ctx.companyId, itemIds);
  const ledger = await itemLedger(
    tx,
    ctx.companyId,
    items.map((i) => i.id),
  );
  const locationId = await defaultLocationId(tx, ctx.companyId);
  const touched: string[] = [];
  for (const item of items) {
    if (!item.blankVariantId) continue;
    const l = ledger.get(item.id);
    if (l && (l.reserved > 0 || l.consumes > 0)) continue;
    const row = await recordMovement(tx, ctx, {
      blankVariantId: item.blankVariantId,
      locationId,
      kind: "reserve",
      qty: 1,
      refType: "order_item",
      refId: item.id,
      idempotencyKey: `reserve:order_item:${item.id}:${l?.reserves ?? 0}`,
    });
    if (row) touched.push(item.blankVariantId);
  }
  await availabilityChanged(tx, ctx.companyId, touched);
  return touched.length;
}

/** Release the open reservation of each item (cancel, unmapped, hold). */
export async function releaseForItems(tx: Tx, ctx: Ctx, itemIds: string[]): Promise<number> {
  const items = await loadItems(tx, ctx.companyId, itemIds);
  const ledger = await itemLedger(
    tx,
    ctx.companyId,
    items.map((i) => i.id),
  );
  const fallback = await defaultLocationId(tx, ctx.companyId);
  const touched: string[] = [];
  for (const item of items) {
    const l = ledger.get(item.id);
    if (!item.blankVariantId || !l || l.reserved <= 0) continue;
    const row = await recordMovement(tx, ctx, {
      blankVariantId: item.blankVariantId,
      locationId: l.locationId ?? fallback,
      kind: "release",
      qty: l.reserved,
      refType: "order_item",
      refId: item.id,
      idempotencyKey: `release:order_item:${item.id}:${l.releases}`,
    });
    if (row) touched.push(item.blankVariantId);
  }
  await availabilityChanged(tx, ctx.companyId, touched);
  return touched.length;
}

/**
 * The item was pressed: release its reservation and consume one blank. A second press of the
 * same item (a reprint after QC failure) is booked as `scrap` with ref type `reprint`, so the
 * wasted shirt shows up separately. Idempotent per press count.
 */
export async function consumeForItem(
  tx: Tx,
  ctx: Ctx,
  itemId: string,
): Promise<{ kind: "consume" | "scrap"; movementId: string } | null> {
  const [item] = await loadItems(tx, ctx.companyId, [itemId]);
  if (!item?.blankVariantId) return null;
  const l = (await itemLedger(tx, ctx.companyId, [item.id])).get(item.id);
  const locationId = l?.locationId ?? (await defaultLocationId(tx, ctx.companyId));
  if (l && l.reserved > 0) {
    await recordMovement(tx, ctx, {
      blankVariantId: item.blankVariantId,
      locationId,
      kind: "release",
      qty: l.reserved,
      refType: "order_item",
      refId: item.id,
      idempotencyKey: `release:order_item:${item.id}:${l.releases}`,
    });
  }
  const firstPress = !l || l.consumes === 0;
  const row = firstPress
    ? await recordMovement(tx, ctx, {
        blankVariantId: item.blankVariantId,
        locationId,
        kind: "consume",
        qty: -1,
        refType: "order_item",
        refId: item.id,
        idempotencyKey: `consume:order_item:${item.id}`,
      })
    : await recordMovement(tx, ctx, {
        blankVariantId: item.blankVariantId,
        locationId,
        kind: "scrap",
        qty: -1,
        refType: "reprint",
        refId: item.id,
        note: "re-press after QC failure",
        idempotencyKey: `scrap:reprint:${item.id}:${l?.scraps ?? 0}`,
      });
  await availabilityChanged(tx, ctx.companyId, [item.blankVariantId]);
  return row ? { kind: firstPress ? "consume" : "scrap", movementId: row.id } : null;
}

/** Shelf labels for blanks (pick queue). Missing variants map to null. */
export async function getShelvesForBlanks(
  tx: Tx,
  ctx: Pick<TenantContext, "companyId">,
  blankVariantIds: string[],
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>(blankVariantIds.map((id) => [id, null]));
  if (!blankVariantIds.length) return out;
  const rows = await tx
    .select({ id: stockLevels.blankVariantId, shelf: stockLevels.shelf })
    .from(stockLevels)
    .where(
      and(
        eq(stockLevels.companyId, ctx.companyId),
        inArray(stockLevels.blankVariantId, blankVariantIds),
      ),
    );
  for (const r of rows) if (r.shelf && !out.get(r.id)) out.set(r.id, r.shelf);
  return out;
}
