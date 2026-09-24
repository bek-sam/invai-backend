import type {
  AdjustInput as AdjustInputSchema,
  CountInput as CountInputSchema,
  InventorySettings,
  Movement,
  PurchaseOrder,
  PurchaseOrderInput as PurchaseOrderInputSchema,
  ReceiveInput as ReceiveInputSchema,
  ReorderSuggestion,
  StockLevel,
} from "@invai/contracts";
import { and, asc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import type { z } from "zod";
import type { TenantContext } from "../../api/context";
import { type Tx, withTenant } from "../../db/client";
import {
  blankVariants,
  inventoryMovements,
  inventorySettings,
  locations,
  purchaseOrderLines,
  purchaseOrderReceipts,
  purchaseOrders,
  stockLevels,
  suppliers,
  users,
} from "../../db/schema";
import { SUPPLIERS } from "../../db/schema/catalog";
import {
  getSupplierAdapter,
  type SupplierAdapter,
  type SupplierCredentials,
  SupplierError,
  SupplierNotConnectedError,
  type SupplierOrderInput,
  type SupplierOrderResult,
  supplierProvider,
} from "../../integrations/suppliers";
import { audit } from "../../lib/audit";
import { badRequest, conflict, invalidTransition, notFound, ORPCError } from "../../lib/errors";
import { logger } from "../../lib/log";
import { emit } from "../../lib/outbox";
import { keyset, type PageInput } from "../../lib/pagination";
import { defaultLocationId, recordMovement } from "./ledger";
import { daysOfCover, effectiveReorderPoint, planReorder } from "./reorder";

/*
 * Inventory service: the stock ledger (./ledger.ts), stock views with velocity and days of
 * cover, cycle counts, reorder suggestions, purchase orders and supplier accounts.
 * The ledger primitives other modules call are re-exported here: orders reserve/release on
 * ready/cancel, production consumes on press and reads shelves for the pick queue.
 */
export {
  consumeForItem,
  getShelvesForBlanks,
  releaseForItems,
  reserveForItems,
} from "./ledger";

const log = logger("inventory");

type BlankRow = typeof blankVariants.$inferSelect;
type Ctx = TenantContext;
type AdjustInput = z.infer<typeof AdjustInputSchema>;
type CountInput = z.infer<typeof CountInputSchema>;
type PurchaseOrderInput = z.infer<typeof PurchaseOrderInputSchema>;
type ReceiveInput = z.infer<typeof ReceiveInputSchema>;
type Supplier = (typeof SUPPLIERS)[number];

const SUPPLIER_NAMES: Record<Supplier, string> = {
  ssactivewear: "S&S Activewear",
  sanmar: "SanMar",
  other: "Other",
};
const DEFAULT_FREE_FREIGHT: Record<Supplier, number> = {
  ssactivewear: 20000,
  sanmar: 20000,
  other: 0,
};
const DEFAULT_COVER_DAYS = 14;

export function toBlankSummary(b: BlankRow) {
  return {
    variantId: b.id,
    brand: b.brand,
    style: b.style,
    styleCode: b.styleCode,
    color: b.color,
    colorCode: b.colorCode,
    size: b.size,
    supplier: b.supplier,
    supplierSku: b.supplierSku,
    cost: b.costCents,
  };
}

async function locationOrDefault(tx: Tx, ctx: Ctx, locationId?: string) {
  if (!locationId) return defaultLocationId(tx, ctx.companyId);
  const [row] = await tx
    .select({ id: locations.id })
    .from(locations)
    .where(and(eq(locations.companyId, ctx.companyId), eq(locations.id, locationId)));
  if (!row) throw notFound("location", locationId);
  return row.id;
}

/* -------------------------------- settings -------------------------------- */

type SettingsRow = typeof inventorySettings.$inferSelect;

export async function loadSettings(tx: Tx, companyId: string): Promise<SettingsRow> {
  const [row] = await tx
    .select()
    .from(inventorySettings)
    .where(eq(inventorySettings.companyId, companyId));
  if (row) return row;
  const [created] = await tx
    .insert(inventorySettings)
    .values({ companyId })
    .onConflictDoNothing()
    .returning();
  if (created) return created;
  const [again] = await tx
    .select()
    .from(inventorySettings)
    .where(eq(inventorySettings.companyId, companyId));
  if (!again) throw new Error("inventory settings missing");
  return again;
}

async function supplierRows(tx: Tx, companyId: string) {
  return tx.select().from(suppliers).where(eq(suppliers.companyId, companyId));
}

function thresholdsOf(rows: (typeof suppliers.$inferSelect)[]) {
  const out: Record<string, number> = { ...DEFAULT_FREE_FREIGHT };
  for (const r of rows) out[r.supplier] = r.freeFreightThresholdCents;
  return out;
}

export async function getSettings(tx: Tx, ctx: Ctx): Promise<InventorySettings> {
  const s = await loadSettings(tx, ctx.companyId);
  const rows = await supplierRows(tx, ctx.companyId);
  return {
    suppliers: SUPPLIERS.map((supplier) => {
      const r = rows.find((x) => x.supplier === supplier);
      return {
        supplier,
        freeFreightThreshold: r?.freeFreightThresholdCents ?? DEFAULT_FREE_FREIGHT[supplier],
        accountNumber: r?.accountNumber ?? null,
        apiKey: null, // write-only
      };
    }),
    velocityWindowDays: s.velocityWindowDays,
    leadTimeDays: s.leadTimeDays,
    safetyDays: s.safetyDays,
    reserveOnImport: s.reserveOnImport,
  };
}

export async function updateSettings(
  tx: Tx,
  ctx: Ctx,
  input: Partial<InventorySettings>,
): Promise<InventorySettings> {
  await loadSettings(tx, ctx.companyId);
  const patch: Partial<typeof inventorySettings.$inferInsert> = {};
  if (input.velocityWindowDays !== undefined) patch.velocityWindowDays = input.velocityWindowDays;
  if (input.leadTimeDays !== undefined) patch.leadTimeDays = input.leadTimeDays;
  if (input.safetyDays !== undefined) patch.safetyDays = input.safetyDays;
  if (input.reserveOnImport !== undefined) patch.reserveOnImport = input.reserveOnImport;
  if (Object.keys(patch).length) {
    await tx
      .update(inventorySettings)
      .set(patch)
      .where(eq(inventorySettings.companyId, ctx.companyId));
  }
  for (const s of input.suppliers ?? []) {
    const set: Partial<typeof suppliers.$inferInsert> = {
      freeFreightThresholdCents: s.freeFreightThreshold,
      accountNumber: s.accountNumber,
    };
    // apiKey: null = unchanged, "" = clear, otherwise replace (stored encrypted).
    if (s.apiKey !== null && s.apiKey !== undefined) set.apiKey = s.apiKey === "" ? null : s.apiKey;
    await tx
      .insert(suppliers)
      .values({
        companyId: ctx.companyId,
        supplier: s.supplier,
        name: SUPPLIER_NAMES[s.supplier],
        freeFreightThresholdCents: s.freeFreightThreshold,
        accountNumber: s.accountNumber,
        apiKey: set.apiKey ?? null,
      })
      .onConflictDoUpdate({ target: [suppliers.companyId, suppliers.supplier], set });
  }
  await audit(tx, {
    companyId: ctx.companyId,
    actor: ctx.actor,
    action: "inventory.settings.update",
    entityType: "inventory_settings",
    summary: "Inventory settings updated",
    data: {
      ...input,
      suppliers: input.suppliers?.map((s) => ({ ...s, apiKey: s.apiKey ? "***" : s.apiKey })),
    },
  });
  return getSettings(tx, ctx);
}

/* ---------------------------------- stock --------------------------------- */

/** Units consumed (consume + scrap) per day over the window, per blank variant. */
export async function dailyVelocities(
  tx: Tx,
  companyId: string,
  windowDays: number,
  locationId?: string,
): Promise<Map<string, number>> {
  const since = new Date(Date.now() - windowDays * 86_400_000);
  const rows = await tx
    .select({
      id: inventoryMovements.blankVariantId,
      used: sql<number>`coalesce(-sum(${inventoryMovements.qty}), 0)::int`,
    })
    .from(inventoryMovements)
    .where(
      and(
        eq(inventoryMovements.companyId, companyId),
        inArray(inventoryMovements.kind, ["consume", "scrap"]),
        gte(inventoryMovements.createdAt, since),
        locationId ? eq(inventoryMovements.locationId, locationId) : undefined,
      ),
    )
    .groupBy(inventoryMovements.blankVariantId);
  return new Map(rows.map((r) => [r.id, Math.max(0, r.used) / windowDays]));
}

/** Open PO quantity (ordered − received) per blank variant. */
async function incomingByVariant(tx: Tx, companyId: string, locationId?: string) {
  const rows = await tx
    .select({
      id: purchaseOrderLines.blankVariantId,
      n: sql<number>`coalesce(sum(greatest(${purchaseOrderLines.qty} - ${purchaseOrderLines.receivedQty}, 0)), 0)::int`,
    })
    .from(purchaseOrderLines)
    .innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseOrderLines.purchaseOrderId))
    .where(
      and(
        eq(purchaseOrderLines.companyId, companyId),
        inArray(purchaseOrders.status, ["submitted", "partially_received"]),
        locationId ? eq(purchaseOrders.locationId, locationId) : undefined,
      ),
    )
    .groupBy(purchaseOrderLines.blankVariantId);
  return new Map(rows.map((r) => [r.id, r.n]));
}

export type StockView = StockLevel & {
  shelf: string | null;
  reorderPointSource: "manual" | "velocity" | null;
};

/** Every active blank variant with its stock at one location (zeros when never stocked). */
export async function stockViews(
  tx: Tx,
  ctx: Pick<Ctx, "companyId">,
  opts: { locationId: string; blankVariantIds?: string[] },
): Promise<StockView[]> {
  const settings = await loadSettings(tx, ctx.companyId);
  const blanks = await tx
    .select()
    .from(blankVariants)
    .where(
      and(
        eq(blankVariants.companyId, ctx.companyId),
        opts.blankVariantIds
          ? inArray(blankVariants.id, opts.blankVariantIds)
          : eq(blankVariants.status, "active"),
      ),
    )
    .orderBy(asc(blankVariants.brand), asc(blankVariants.styleCode), asc(blankVariants.colorCode));
  if (!blanks.length) return [];
  const levels = await tx
    .select()
    .from(stockLevels)
    .where(
      and(eq(stockLevels.companyId, ctx.companyId), eq(stockLevels.locationId, opts.locationId)),
    );
  const levelBy = new Map(levels.map((l) => [l.blankVariantId, l]));
  const velocity = await dailyVelocities(tx, ctx.companyId, settings.velocityWindowDays);
  const incoming = await incomingByVariant(tx, ctx.companyId, opts.locationId);
  return blanks.map((b) => {
    const l = levelBy.get(b.id);
    const v = Math.round((velocity.get(b.id) ?? 0) * 100) / 100;
    const available = l?.available ?? 0;
    const manual = l?.reorderPoint ?? b.reorderPoint ?? null;
    const point = effectiveReorderPoint(manual, v, settings);
    return {
      blankVariantId: b.id,
      blank: toBlankSummary(b),
      locationId: opts.locationId,
      onHand: l?.onHand ?? 0,
      reserved: l?.reserved ?? 0,
      available,
      incoming: incoming.get(b.id) ?? 0,
      reorderPoint: point,
      reorderQty: l?.reorderQty ?? b.reorderQty ?? null,
      dailyVelocity: v,
      daysOfCover: (() => {
        const d = daysOfCover(available, v);
        return d == null ? null : Math.round(d * 10) / 10;
      })(),
      belowReorderPoint: point != null && available < point,
      updatedAt: (l?.updatedAt ?? b.updatedAt).toISOString(),
      shelf: l?.shelf ?? null,
      reorderPointSource: manual != null ? "manual" : point != null ? "velocity" : null,
    };
  });
}

function stripView(v: StockView): StockLevel {
  const { shelf: _s, reorderPointSource: _r, ...rest } = v;
  return rest;
}

export type StockListInput = PageInput & {
  locationId?: string;
  search?: string;
  brand?: string;
  styleCode?: string;
  colorCode?: string;
  supplier?: Supplier;
  belowReorderPoint?: boolean;
  sort?: "style" | "available" | "daysOfCover";
};

const SIZE_ORDER = ["XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL", "5XL"];

export async function listStock(tx: Tx, ctx: Ctx, input: StockListInput) {
  const locationId = await locationOrDefault(tx, ctx, input.locationId);
  const all = await stockViews(tx, ctx, { locationId });
  const q = input.search?.trim().toLowerCase();
  const rows = all.filter(
    (r) =>
      (!q ||
        `${r.blank.brand} ${r.blank.style} ${r.blank.styleCode} ${r.blank.color} ${r.blank.size} ${r.blank.supplierSku}`
          .toLowerCase()
          .includes(q)) &&
      (!input.brand || r.blank.brand === input.brand) &&
      (!input.styleCode || r.blank.styleCode === input.styleCode) &&
      (!input.colorCode || r.blank.colorCode === input.colorCode) &&
      (!input.supplier || r.blank.supplier === input.supplier) &&
      (input.belowReorderPoint === undefined || r.belowReorderPoint === input.belowReorderPoint),
  );
  const sort = input.sort ?? "style";
  rows.sort((a, b) => {
    if (sort === "available") return a.available - b.available;
    if (sort === "daysOfCover") return (a.daysOfCover ?? 1e9) - (b.daysOfCover ?? 1e9);
    return (
      a.blank.brand.localeCompare(b.blank.brand) ||
      a.blank.styleCode.localeCompare(b.blank.styleCode) ||
      a.blank.color.localeCompare(b.blank.color) ||
      SIZE_ORDER.indexOf(a.blank.size) - SIZE_ORDER.indexOf(b.blank.size)
    );
  });
  const offset = input.cursor ? Number.parseInt(input.cursor, 10) || 0 : 0;
  const page = rows.slice(offset, offset + input.limit);
  return {
    items: page.map(stripView),
    nextCursor: offset + input.limit < rows.length ? String(offset + input.limit) : null,
    lowStockCount: all.filter((r) => r.belowReorderPoint).length,
  };
}

export async function getStock(
  tx: Tx,
  ctx: Ctx,
  input: { blankVariantId: string; locationId?: string },
): Promise<StockLevel> {
  const locationId = await locationOrDefault(tx, ctx, input.locationId);
  const [row] = await stockViews(tx, ctx, {
    locationId,
    blankVariantIds: [input.blankVariantId],
  });
  if (!row) throw notFound("blank variant", input.blankVariantId);
  return stripView(row);
}

export async function setReorderPoint(
  tx: Tx,
  ctx: Ctx,
  input: {
    blankVariantId: string;
    locationId?: string;
    reorderPoint: number | null;
    reorderQty: number | null;
  },
): Promise<StockLevel> {
  const locationId = await locationOrDefault(tx, ctx, input.locationId);
  const [bv] = await tx
    .select({ id: blankVariants.id })
    .from(blankVariants)
    .where(
      and(eq(blankVariants.companyId, ctx.companyId), eq(blankVariants.id, input.blankVariantId)),
    );
  if (!bv) throw notFound("blank variant", input.blankVariantId);
  await tx
    .insert(stockLevels)
    .values({
      companyId: ctx.companyId,
      blankVariantId: input.blankVariantId,
      locationId,
      reorderPoint: input.reorderPoint,
      reorderQty: input.reorderQty,
    })
    .onConflictDoUpdate({
      target: [stockLevels.companyId, stockLevels.blankVariantId, stockLevels.locationId],
      set: {
        reorderPoint: input.reorderPoint,
        reorderQty: input.reorderQty,
        updatedAt: new Date(),
      },
    });
  await audit(tx, {
    companyId: ctx.companyId,
    actor: ctx.actor,
    action: "inventory.reorder_point.set",
    entityType: "blank_variant",
    entityId: input.blankVariantId,
    summary: `Reorder point ${input.reorderPoint ?? "auto"}, qty ${input.reorderQty ?? "auto"}`,
  });
  return getStock(tx, ctx, { blankVariantId: input.blankVariantId, locationId });
}

/** Set the shelf label for blanks (receiving screen / seed). */
export async function setShelf(
  tx: Tx,
  ctx: Pick<Ctx, "companyId">,
  input: { blankVariantId: string; locationId: string; shelf: string | null },
) {
  await tx
    .insert(stockLevels)
    .values({
      companyId: ctx.companyId,
      blankVariantId: input.blankVariantId,
      locationId: input.locationId,
      shelf: input.shelf,
    })
    .onConflictDoUpdate({
      target: [stockLevels.companyId, stockLevels.blankVariantId, stockLevels.locationId],
      set: { shelf: input.shelf },
    });
}

/** Count of blanks below their reorder point at the default location (Today screen). */
export async function lowStockCount(tx: Tx, ctx: Pick<Ctx, "companyId">): Promise<number> {
  const locationId = await defaultLocationId(tx, ctx.companyId);
  const rows = await stockViews(tx, ctx, { locationId });
  return rows.filter((r) => r.belowReorderPoint).length;
}

/** Blanks below their reorder point (alerts job). */
export async function lowStockItems(tx: Tx, ctx: Pick<Ctx, "companyId">) {
  const locationId = await defaultLocationId(tx, ctx.companyId);
  const rows = await stockViews(tx, ctx, { locationId });
  return rows.filter((r) => r.belowReorderPoint);
}

/* -------------------------------- movements ------------------------------- */

type MovementRow = typeof inventoryMovements.$inferSelect;

async function toMovements(tx: Tx, rows: MovementRow[]): Promise<Movement[]> {
  if (!rows.length) return [];
  const blankIds = [...new Set(rows.map((r) => r.blankVariantId))];
  const userIds = [...new Set(rows.map((r) => r.userId).filter((x): x is string => !!x))];
  const blanks = await tx.select().from(blankVariants).where(inArray(blankVariants.id, blankIds));
  const blankBy = new Map(blanks.map((b) => [b.id, b]));
  const names = userIds.length
    ? await tx
        .select({ id: users.id, name: users.name })
        .from(users)
        .where(inArray(users.id, userIds))
    : [];
  const nameBy = new Map(names.map((u) => [u.id, u.name]));
  return rows.flatMap((r) => {
    const b = blankBy.get(r.blankVariantId);
    if (!b) return [];
    return [
      {
        id: r.id,
        at: r.createdAt.toISOString(),
        blankVariantId: r.blankVariantId,
        blank: toBlankSummary(b),
        locationId: r.locationId,
        kind: r.kind,
        qty: r.qty,
        reason: r.reason,
        note: r.note,
        ref: r.refType && r.refId ? { type: r.refType, id: r.refId } : null,
        actor: {
          userId: r.userId,
          name: r.userId ? (nameBy.get(r.userId) ?? "Staff") : "System",
        },
      },
    ];
  });
}

export type MovementListInput = PageInput & {
  blankVariantId?: string;
  locationId?: string;
  kind?: MovementRow["kind"][];
  from?: string;
  to?: string;
};

export async function listMovements(tx: Tx, _ctx: Ctx, input: MovementListInput) {
  const page = keyset(inventoryMovements.createdAt, inventoryMovements.id, input);
  const rows = await tx
    .select()
    .from(inventoryMovements)
    .where(
      and(
        input.blankVariantId
          ? eq(inventoryMovements.blankVariantId, input.blankVariantId)
          : undefined,
        input.locationId ? eq(inventoryMovements.locationId, input.locationId) : undefined,
        input.kind?.length ? inArray(inventoryMovements.kind, input.kind) : undefined,
        input.from ? gte(inventoryMovements.createdAt, new Date(input.from)) : undefined,
        input.to ? lte(inventoryMovements.createdAt, new Date(input.to)) : undefined,
        page.where,
      ),
    )
    .orderBy(...page.orderBy)
    .limit(page.limit + 1);
  const res = page.result(rows, (r) => r);
  return { items: await toMovements(tx, res.items), nextCursor: res.nextCursor };
}

async function assertBlank(tx: Tx, ctx: Ctx, id: string) {
  const [bv] = await tx
    .select()
    .from(blankVariants)
    .where(and(eq(blankVariants.companyId, ctx.companyId), eq(blankVariants.id, id)));
  if (!bv) throw notFound("blank variant", id);
  return bv;
}

export async function adjust(tx: Tx, ctx: Ctx, input: AdjustInput): Promise<Movement> {
  const locationId = await locationOrDefault(tx, ctx, input.locationId);
  const bv = await assertBlank(tx, ctx, input.blankVariantId);
  const row = await recordMovement(tx, ctx, {
    blankVariantId: input.blankVariantId,
    locationId,
    kind: "adjust",
    qty: input.qty,
    reason: input.reason,
    note: input.note,
    unitCostCents: bv.costCents,
  });
  if (!row) throw new Error("adjust movement not written");
  await emit(tx, ctx.companyId, "stock.availability_changed", {
    blankVariantIds: [input.blankVariantId],
  });
  await audit(tx, {
    companyId: ctx.companyId,
    actor: ctx.actor,
    action: "inventory.adjust",
    entityType: "blank_variant",
    entityId: input.blankVariantId,
    summary: `${input.qty > 0 ? "+" : ""}${input.qty} ${bv.sku} (${input.reason})`,
    data: { qty: input.qty, reason: input.reason, note: input.note },
  });
  const [m] = await toMovements(tx, [row]);
  if (!m) throw new Error("movement mapping failed");
  return m;
}

export async function count(tx: Tx, ctx: Ctx, input: CountInput) {
  const locationId = await locationOrDefault(tx, ctx, input.locationId);
  const countId = crypto.randomUUID();
  const ids = input.lines.map((l) => l.blankVariantId);
  const blanks = await tx
    .select({ id: blankVariants.id, cost: blankVariants.costCents })
    .from(blankVariants)
    .where(and(eq(blankVariants.companyId, ctx.companyId), inArray(blankVariants.id, ids)));
  const known = new Map(blanks.map((b) => [b.id, b.cost]));
  const missing = ids.find((id) => !known.has(id));
  if (missing) throw notFound("blank variant", missing);
  const levels = await tx
    .select()
    .from(stockLevels)
    .where(
      and(
        eq(stockLevels.companyId, ctx.companyId),
        eq(stockLevels.locationId, locationId),
        inArray(stockLevels.blankVariantId, ids),
      ),
    );
  const onHand = new Map(levels.map((l) => [l.blankVariantId, l.onHand]));
  const variance: { blankVariantId: string; expected: number; counted: number; delta: number }[] =
    [];
  const written: MovementRow[] = [];
  for (const line of input.lines) {
    const expected = onHand.get(line.blankVariantId) ?? 0;
    const delta = line.counted - expected;
    variance.push({ blankVariantId: line.blankVariantId, expected, counted: line.counted, delta });
    if (delta === 0) continue;
    const row = await recordMovement(tx, ctx, {
      blankVariantId: line.blankVariantId,
      locationId,
      kind: "count",
      qty: delta,
      reason: "correction",
      refType: "count",
      refId: countId,
      note: input.note,
      unitCostCents: known.get(line.blankVariantId) ?? null,
    });
    if (row) written.push(row);
  }
  if (written.length) {
    await emit(tx, ctx.companyId, "stock.availability_changed", {
      blankVariantIds: written.map((w) => w.blankVariantId),
    });
  }
  await audit(tx, {
    companyId: ctx.companyId,
    actor: ctx.actor,
    action: "inventory.count",
    entityType: "count",
    entityId: countId,
    summary: `Counted ${input.lines.length} blanks, ${written.length} corrected`,
    data: { variance },
  });
  return { countId, movements: await toMovements(tx, written), variance };
}

/* ---------------------------------- suppliers ------------------------------- */

function credsOf(row: typeof suppliers.$inferSelect | undefined): SupplierCredentials | null {
  return row?.accountNumber && row.apiKey
    ? { account: row.accountNumber, apiKey: row.apiKey }
    : null;
}

/**
 * The company's own supplier account: live with its credentials, the mock outside production,
 * null for a supplier with no API in production. Throws a clear CONFLICT when production has no
 * credentials for an API supplier (InvAI's own account is never used for a tenant).
 */
export async function supplierAdapterFor(
  tx: Tx,
  companyId: string,
  supplier: string,
): Promise<SupplierAdapter | null> {
  const [row] = await tx
    .select()
    .from(suppliers)
    .where(and(eq(suppliers.companyId, companyId), eq(suppliers.supplier, supplier as Supplier)));
  try {
    return getSupplierAdapter(supplier, credsOf(row), { account: companyId });
  } catch (err) {
    if (err instanceof SupplierNotConnectedError) {
      const name = SUPPLIER_NAMES[supplier as Supplier] ?? supplier;
      throw conflict(
        `Connect your ${name} account (account number and API key) in Inventory settings before ordering from ${name}.`,
      );
    }
    throw err;
  }
}

export async function listSuppliers(tx: Tx, ctx: Ctx) {
  const rows = await supplierRows(tx, ctx.companyId);
  const counts = await tx
    .select({ supplier: blankVariants.supplier, n: sql<number>`count(*)::int` })
    .from(blankVariants)
    .where(and(eq(blankVariants.companyId, ctx.companyId), eq(blankVariants.status, "active")))
    .groupBy(blankVariants.supplier);
  return {
    items: SUPPLIERS.map((supplier) => {
      const r = rows.find((x) => x.supplier === supplier);
      return {
        supplier,
        name: r?.name ?? SUPPLIER_NAMES[supplier],
        connected: !!r,
        provider: supplier === "other" ? ("none" as const) : supplierProvider(supplier, credsOf(r)),
        freeFreightThreshold: r?.freeFreightThresholdCents ?? DEFAULT_FREE_FREIGHT[supplier],
        accountNumber: r?.accountNumber ?? null,
        hasApiKey: !!r?.apiKey,
        variantCount: counts.find((c) => c.supplier === supplier)?.n ?? 0,
      };
    }),
  };
}

/** Live supplier stock keyed by blank variant id (null when the supplier can't be asked). */
export async function supplierStock(
  tx: Tx,
  ctx: Pick<Ctx, "companyId">,
  blankVariantIds: string[],
): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>(blankVariantIds.map((id) => [id, null]));
  if (!blankVariantIds.length) return out;
  const blanks = await tx
    .select()
    .from(blankVariants)
    .where(
      and(eq(blankVariants.companyId, ctx.companyId), inArray(blankVariants.id, blankVariantIds)),
    );
  const bySupplier = new Map<string, BlankRow[]>();
  for (const b of blanks) {
    if (b.supplier === "other" || !b.supplierSku) continue;
    bySupplier.set(b.supplier, [...(bySupplier.get(b.supplier) ?? []), b]);
  }
  const rows = await supplierRows(tx, ctx.companyId);
  for (const [supplier, list] of bySupplier) {
    try {
      const creds = credsOf(rows.find((r) => r.supplier === supplier));
      if (supplierProvider(supplier, creds) === "none") continue;
      const adapter = getSupplierAdapter(supplier, creds, { account: ctx.companyId });
      if (!adapter) continue;
      const stock = await adapter.stock(list.map((b) => b.supplierSku));
      const bySku = new Map(stock.map((s) => [s.sku, s.quantity]));
      for (const b of list) out.set(b.id, bySku.get(b.supplierSku) ?? null);
    } catch (err) {
      log.warn("supplier stock failed", { supplier, error: (err as Error).message });
    }
  }
  return out;
}

export async function suppliersStock(tx: Tx, ctx: Ctx, blankVariantIds: string[]) {
  const stock = await supplierStock(tx, ctx, blankVariantIds);
  const checkedAt = new Date().toISOString();
  return {
    items: blankVariantIds.map((id) => ({
      blankVariantId: id,
      supplierStock: stock.get(id) ?? null,
      checkedAt,
    })),
  };
}

/* ----------------------------- reorder suggestions ---------------------------- */

export async function reorderSuggestions(
  tx: Tx,
  ctx: Ctx,
  input: { locationId?: string; supplier?: Supplier; coverDays?: number },
): Promise<{ items: ReorderSuggestion[]; generatedAt: string }> {
  const locationId = await locationOrDefault(tx, ctx, input.locationId);
  const settings = await loadSettings(tx, ctx.companyId);
  const views = (await stockViews(tx, ctx, { locationId })).filter(
    (v) => v.blank.supplier !== "other" && (!input.supplier || v.blank.supplier === input.supplier),
  );
  const live = await supplierStock(
    tx,
    ctx,
    views.map((v) => v.blankVariantId),
  );
  const rows = await supplierRows(tx, ctx.companyId);
  const thresholds = thresholdsOf(rows);
  const params = {
    leadTimeDays: settings.leadTimeDays,
    safetyDays: settings.safetyDays,
    coverDays: input.coverDays ?? DEFAULT_COVER_DAYS,
  };
  const manualBy = new Map<string, number | null>();
  for (const v of views)
    manualBy.set(v.blankVariantId, v.reorderPointSource === "manual" ? v.reorderPoint : null);
  const plans = planReorder(
    views.map((v) => ({
      blankVariantId: v.blankVariantId,
      supplier: v.blank.supplier,
      available: v.available,
      incoming: v.incoming,
      manualReorderPoint: manualBy.get(v.blankVariantId) ?? null,
      reorderQty: v.reorderQty,
      dailyVelocity: v.dailyVelocity,
      unitCostCents: v.blank.cost,
      supplierStock: live.get(v.blankVariantId) ?? null,
    })),
    thresholds,
    params,
  );
  const viewBy = new Map(views.map((v) => [v.blankVariantId, v]));
  return {
    generatedAt: new Date().toISOString(),
    items: plans.map((p) => ({
      supplier: p.supplier as Supplier,
      supplierName:
        rows.find((r) => r.supplier === p.supplier)?.name ?? SUPPLIER_NAMES[p.supplier as Supplier],
      freeFreightThreshold: p.threshold,
      subtotal: p.subtotal,
      meetsThreshold: p.meetsThreshold,
      shortfall: p.shortfall,
      lines: p.lines.flatMap((l) => {
        const v = viewBy.get(l.blankVariantId);
        if (!v || l.qty <= 0) return [];
        return [
          {
            blankVariantId: l.blankVariantId,
            blank: v.blank,
            available: v.available,
            incoming: v.incoming,
            reorderPoint: l.reorderPoint,
            dailyVelocity: v.dailyVelocity,
            daysOfCover: v.daysOfCover,
            suggestedQty: l.qty,
            unitCost: v.blank.cost,
            lineCost: l.qty * v.blank.cost,
            supplierStock: live.get(l.blankVariantId) ?? null,
            reason: l.reason,
          },
        ];
      }),
    })),
  };
}

/* ------------------------------ purchase orders ------------------------------ */

type PoRow = typeof purchaseOrders.$inferSelect;
type PoLineRow = typeof purchaseOrderLines.$inferSelect;

async function toPurchaseOrders(tx: Tx, rows: PoRow[]): Promise<PurchaseOrder[]> {
  if (!rows.length) return [];
  const lines = await tx
    .select()
    .from(purchaseOrderLines)
    .where(
      inArray(
        purchaseOrderLines.purchaseOrderId,
        rows.map((r) => r.id),
      ),
    )
    .orderBy(asc(purchaseOrderLines.createdAt), asc(purchaseOrderLines.id));
  const blankIds = [...new Set(lines.map((l) => l.blankVariantId))];
  const blanks = blankIds.length
    ? await tx.select().from(blankVariants).where(inArray(blankVariants.id, blankIds))
    : [];
  const blankBy = new Map(blanks.map((b) => [b.id, b]));
  return rows.map((r) => ({
    id: r.id,
    poNo: r.poNo,
    supplier: r.supplier,
    // `submitting` is internal until contracts PO_STATES has it; nothing is confirmed yet.
    status: r.status === "submitting" ? "draft" : r.status,
    locationId: r.locationId,
    lines: lines
      .filter((l) => l.purchaseOrderId === r.id)
      .flatMap((l) => {
        const b = blankBy.get(l.blankVariantId);
        return b
          ? [
              {
                id: l.id,
                blankVariantId: l.blankVariantId,
                blank: toBlankSummary(b),
                qty: l.qty,
                receivedQty: l.receivedQty,
                unitCost: l.unitCostCents,
              },
            ]
          : [];
      }),
    subtotal: r.subtotalCents,
    freight: r.freightCents,
    total: r.totalCents,
    supplierOrderId: r.supplierOrderId,
    expectedAt: r.expectedAt?.toISOString() ?? null,
    notes: r.notes,
    submittedAt: r.submittedAt?.toISOString() ?? null,
    receivedAt: r.receivedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));
}

async function loadPo(tx: Tx, ctx: Ctx, id: string): Promise<PoRow> {
  const [row] = await tx
    .select()
    .from(purchaseOrders)
    .where(and(eq(purchaseOrders.companyId, ctx.companyId), eq(purchaseOrders.id, id)))
    .for("update");
  if (!row) throw notFound("purchase order", id);
  return row;
}

export async function getPo(tx: Tx, ctx: Ctx, id: string): Promise<PurchaseOrder> {
  const [po] = await toPurchaseOrders(tx, [await loadPo(tx, ctx, id)]);
  if (!po) throw notFound("purchase order", id);
  return po;
}

export async function listPos(
  tx: Tx,
  _ctx: Ctx,
  input: PageInput & { status?: PoRow["status"][]; supplier?: Supplier },
) {
  const page = keyset(purchaseOrders.createdAt, purchaseOrders.id, input);
  const status = input.status?.includes("draft")
    ? [...input.status, "submitting" as const]
    : input.status;
  const rows = await tx
    .select()
    .from(purchaseOrders)
    .where(
      and(
        status?.length ? inArray(purchaseOrders.status, status) : undefined,
        input.supplier ? eq(purchaseOrders.supplier, input.supplier) : undefined,
        page.where,
      ),
    )
    .orderBy(...page.orderBy)
    .limit(page.limit + 1);
  const res = page.result(rows, (r) => r);
  return { items: await toPurchaseOrders(tx, res.items), nextCursor: res.nextCursor };
}

async function nextPoNo(tx: Tx, companyId: string) {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(purchaseOrders)
    .where(
      and(
        eq(purchaseOrders.companyId, companyId),
        sql`${purchaseOrders.poNo} like ${`PO-${day}-%`}`,
      ),
    );
  return `PO-${day}-${String((row?.n ?? 0) + 1).padStart(2, "0")}`;
}

async function writeLines(
  tx: Tx,
  ctx: Ctx,
  poId: string,
  lines: PurchaseOrderInput["lines"],
): Promise<number> {
  const blanks = await tx
    .select()
    .from(blankVariants)
    .where(
      and(
        eq(blankVariants.companyId, ctx.companyId),
        inArray(
          blankVariants.id,
          lines.map((l) => l.blankVariantId),
        ),
      ),
    );
  const blankBy = new Map(blanks.map((b) => [b.id, b]));
  // Merge duplicate variants into one line.
  const merged = new Map<string, { qty: number; unitCost: number }>();
  for (const l of lines) {
    const b = blankBy.get(l.blankVariantId);
    if (!b) throw notFound("blank variant", l.blankVariantId);
    const prev = merged.get(l.blankVariantId);
    merged.set(l.blankVariantId, {
      qty: (prev?.qty ?? 0) + l.qty,
      unitCost: l.unitCost ?? prev?.unitCost ?? b.costCents,
    });
  }
  let subtotal = 0;
  for (const [blankVariantId, l] of merged) {
    subtotal += l.qty * l.unitCost;
    await tx.insert(purchaseOrderLines).values({
      companyId: ctx.companyId,
      purchaseOrderId: poId,
      blankVariantId,
      qty: l.qty,
      unitCostCents: l.unitCost,
    });
  }
  return subtotal;
}

async function freightFor(
  tx: Tx,
  companyId: string,
  supplier: string,
  subtotal: number,
  requested: number,
) {
  const thresholds = thresholdsOf(await supplierRows(tx, companyId));
  const threshold = thresholds[supplier] ?? 0;
  return threshold > 0 && subtotal >= threshold ? 0 : requested;
}

export async function createPo(
  tx: Tx,
  ctx: Ctx,
  input: PurchaseOrderInput,
): Promise<PurchaseOrder> {
  const locationId = await locationOrDefault(tx, ctx, input.locationId);
  const [po] = await tx
    .insert(purchaseOrders)
    .values({
      companyId: ctx.companyId,
      supplier: input.supplier,
      locationId,
      poNo: await nextPoNo(tx, ctx.companyId),
      status: "draft",
      expectedAt: input.expectedAt ? new Date(input.expectedAt) : null,
      notes: input.notes,
      createdBy: ctx.userId,
    })
    .returning();
  if (!po) throw new Error("PO insert failed");
  const subtotal = await writeLines(tx, ctx, po.id, input.lines);
  const freight = await freightFor(tx, ctx.companyId, input.supplier, subtotal, input.freight ?? 0);
  await tx
    .update(purchaseOrders)
    .set({ subtotalCents: subtotal, freightCents: freight, totalCents: subtotal + freight })
    .where(eq(purchaseOrders.id, po.id));
  await audit(tx, {
    companyId: ctx.companyId,
    actor: ctx.actor,
    action: "purchase_order.create",
    entityType: "purchase_order",
    entityId: po.id,
    summary: `${po.poNo} draft, ${input.lines.length} lines`,
  });
  return getPo(tx, ctx, po.id);
}

export async function createPoFromSuggestion(
  tx: Tx,
  ctx: Ctx,
  input: {
    supplier: Supplier;
    locationId?: string;
    lines: { blankVariantId: string; qty: number }[];
  },
) {
  return createPo(tx, ctx, {
    supplier: input.supplier,
    locationId: input.locationId,
    lines: input.lines,
    freight: 0,
    expectedAt: null,
    notes: "Created from reorder suggestion",
  });
}

export async function updatePo(
  tx: Tx,
  ctx: Ctx,
  input: Partial<PurchaseOrderInput> & { id: string },
): Promise<PurchaseOrder> {
  const po = await loadPo(tx, ctx, input.id);
  if (po.status !== "draft") throw invalidTransition("purchase_order", po.id, po.status, "draft");
  const set: Partial<typeof purchaseOrders.$inferInsert> = {};
  if (input.supplier) set.supplier = input.supplier;
  if (input.locationId) set.locationId = await locationOrDefault(tx, ctx, input.locationId);
  // The contract's partial input still applies defaults (freight 0, notes/expectedAt null), so
  // those values mean "unchanged" on update.
  if (input.expectedAt) set.expectedAt = new Date(input.expectedAt);
  if (input.notes) set.notes = input.notes;
  let subtotal = po.subtotalCents;
  if (input.lines) {
    await tx.delete(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, po.id));
    subtotal = await writeLines(tx, ctx, po.id, input.lines);
  }
  const freight = await freightFor(
    tx,
    ctx.companyId,
    set.supplier ?? po.supplier,
    subtotal,
    input.freight || po.freightCents,
  );
  await tx
    .update(purchaseOrders)
    .set({ ...set, subtotalCents: subtotal, freightCents: freight, totalCents: subtotal + freight })
    .where(eq(purchaseOrders.id, po.id));
  return getPo(tx, ctx, po.id);
}

async function shipToFor(tx: Tx, locationId: string) {
  const [loc] = await tx.select().from(locations).where(eq(locations.id, locationId));
  const a = loc?.address;
  if (!a) return null;
  return {
    name: a.name,
    company: a.company ?? null,
    street1: a.street1,
    street2: a.street2 ?? null,
    city: a.city,
    state: a.state,
    zip: a.zip,
  };
}

/** A `submitting` PO whose call started this recently may still be in flight: don't resume it. */
export const SUBMIT_IN_FLIGHT_MS = 2 * 60_000;

type SubmitPlan =
  | { kind: "done" }
  | { kind: "call"; resume: boolean; adapter: SupplierAdapter; order: SupplierOrderInput };

async function markSubmitted(
  tx: Tx,
  ctx: Ctx,
  po: PoRow,
  result: SupplierOrderResult | null,
  provider: string,
) {
  await tx
    .update(purchaseOrders)
    .set({
      status: "submitted",
      submittedAt: new Date(),
      submitAttemptedAt: null,
      supplierOrderId: result?.supplierOrderId ?? null,
      expectedAt: po.expectedAt ?? (result?.expectedAt ? new Date(result.expectedAt) : null),
    })
    .where(eq(purchaseOrders.id, po.id));
  await emit(tx, ctx.companyId, "po.submitted", { purchaseOrderId: po.id, supplier: po.supplier });
  await audit(tx, {
    companyId: ctx.companyId,
    actor: ctx.actor,
    action: "purchase_order.submit",
    entityType: "purchase_order",
    entityId: po.id,
    summary: result
      ? `${po.poNo} submitted to ${po.supplier} (${provider}) as ${result.supplierOrderId}`
      : `${po.poNo} marked submitted; ${po.supplier} has no ordering API, so place it with the supplier`,
  });
}

/**
 * Sends a PO to the supplier exactly once (R8): tx 1 records the intent (`submitting`) and
 * commits, the supplier call runs outside any transaction with the PO number as its
 * idempotency key, and tx 2 records the supplier order id. A retry of a `submitting` PO reads
 * the supplier back by PO number before ordering again. Repeating a submitted PO returns it.
 */
export async function submitPo(ctx: Ctx, id: string): Promise<PurchaseOrder> {
  const plan = await withTenant(ctx.companyId, async (tx): Promise<SubmitPlan> => {
    const po = await loadPo(tx, ctx, id);
    if (
      po.status === "submitted" ||
      po.status === "partially_received" ||
      po.status === "received"
    ) {
      return { kind: "done" };
    }
    if (po.status === "submitting") {
      const since = po.submitAttemptedAt ? Date.now() - po.submitAttemptedAt.getTime() : null;
      if (since !== null && since < SUBMIT_IN_FLIGHT_MS) {
        throw conflict(
          "This purchase order is being sent to the supplier right now. Check again in a minute.",
        );
      }
    } else if (po.status !== "draft") {
      throw invalidTransition("purchase_order", po.id, po.status, "submitted");
    }
    const lines: PoLineRow[] = await tx
      .select()
      .from(purchaseOrderLines)
      .where(eq(purchaseOrderLines.purchaseOrderId, po.id));
    if (!lines.length) throw badRequest("A purchase order needs at least one line");
    const adapter = await supplierAdapterFor(tx, ctx.companyId, po.supplier);
    if (!adapter) {
      await markSubmitted(tx, ctx, po, null, "manual");
      return { kind: "done" };
    }
    const blanks = await tx
      .select()
      .from(blankVariants)
      .where(
        inArray(
          blankVariants.id,
          lines.map((l) => l.blankVariantId),
        ),
      );
    const skuBy = new Map(blanks.map((b) => [b.id, b.supplierSku || b.sku]));
    const order: SupplierOrderInput = {
      poNo: po.poNo,
      lines: lines.map((l) => ({ sku: skuBy.get(l.blankVariantId) ?? "", quantity: l.qty })),
      shipTo: await shipToFor(tx, po.locationId),
    };
    await tx
      .update(purchaseOrders)
      .set({ status: "submitting", submitAttemptedAt: new Date() })
      .where(eq(purchaseOrders.id, po.id));
    return { kind: "call", resume: po.status === "submitting", adapter, order };
  });
  if (plan.kind === "done") return withTenant(ctx.companyId, (tx) => getPo(tx, ctx, id));

  // No transaction and no row lock while the supplier is called.
  let result: SupplierOrderResult;
  try {
    const existing = plan.resume ? await plan.adapter.findOrder(plan.order.poNo) : null;
    result =
      existing && !existing.cancelled
        ? { supplierOrderId: existing.supplierOrderId, expectedAt: existing.expectedAt }
        : await plan.adapter.placeOrder(plan.order);
  } catch (err) {
    const unknown = !(err instanceof SupplierError) || err.outcome === "unknown";
    // Not placed: back to draft. Unknown: stay `submitting` with no call in flight, so the
    // next submit reads back before ordering.
    await withTenant(ctx.companyId, (tx) =>
      tx
        .update(purchaseOrders)
        .set(unknown ? { submitAttemptedAt: null } : { status: "draft", submitAttemptedAt: null })
        .where(and(eq(purchaseOrders.id, id), eq(purchaseOrders.status, "submitting"))),
    );
    const detail = (err as Error).message;
    log.warn("supplier order failed", { purchaseOrderId: id, unknown, detail });
    if (unknown) {
      throw new ORPCError("UPSTREAM_FAILED", {
        status: 502,
        message:
          "We couldn't confirm the order with the supplier. Submit again to check; it won't be ordered twice.",
        data: { service: "supplier", detail },
      });
    }
    throw new ORPCError("SUPPLIER_REJECTED", {
      status: 502,
      message: "Supplier rejected the order",
      data: { detail },
    });
  }

  try {
    return await withTenant(ctx.companyId, async (tx) => {
      const po = await loadPo(tx, ctx, id);
      if (po.status === "submitting")
        await markSubmitted(tx, ctx, po, result, plan.adapter.provider);
      return getPo(tx, ctx, id);
    });
  } catch (err) {
    // The supplier has the order but we couldn't record it: clear the in-flight mark so the
    // next submit reads it back instead of waiting out SUBMIT_IN_FLIGHT_MS.
    log.error("supplier accepted the PO but saving it failed", {
      purchaseOrderId: id,
      supplierOrderId: result.supplierOrderId,
      error: (err as Error).message,
    });
    await withTenant(ctx.companyId, (tx) =>
      tx
        .update(purchaseOrders)
        .set({ submitAttemptedAt: null })
        .where(and(eq(purchaseOrders.id, id), eq(purchaseOrders.status, "submitting"))),
    ).catch(() => {});
    throw err;
  }
}

const sameReceipt = (
  a: { lineId: string; qty: number }[],
  b: { lineId: string; qty: number }[],
) => {
  const key = (l: { lineId: string; qty: number }[]) =>
    l
      .map((x) => `${x.lineId}:${x.qty}`)
      .sort()
      .join(",");
  return key(a) === key(b);
};

/**
 * Receives lines into stock. With `idempotencyKey` a retried receipt counts once: the same key
 * and lines return the PO as it is, the same key with different lines is a CONFLICT. Without a
 * key, each call is a new delivery.
 */
export async function receivePo(tx: Tx, ctx: Ctx, input: ReceiveInput): Promise<PurchaseOrder> {
  const po = await loadPo(tx, ctx, input.purchaseOrderId);
  const lineInput = input.lines.map((l) => ({ lineId: l.lineId, qty: l.qty }));
  if (input.idempotencyKey) {
    const [prior] = await tx
      .select()
      .from(purchaseOrderReceipts)
      .where(
        and(
          eq(purchaseOrderReceipts.companyId, ctx.companyId),
          eq(purchaseOrderReceipts.idempotencyKey, input.idempotencyKey),
        ),
      );
    if (prior) {
      if (
        prior.purchaseOrderId !== po.id ||
        (input.locationId && input.locationId !== prior.locationId) ||
        !sameReceipt(prior.lines, lineInput)
      ) {
        throw conflict("This receipt was already recorded with different quantities");
      }
      return getPo(tx, ctx, po.id);
    }
  }
  if (po.status !== "submitted" && po.status !== "partially_received") {
    throw invalidTransition("purchase_order", po.id, po.status, "received");
  }
  const locationId = input.locationId
    ? await locationOrDefault(tx, ctx, input.locationId)
    : po.locationId;
  let receiptId: string | null = null;
  if (input.idempotencyKey) {
    const [receipt] = await tx
      .insert(purchaseOrderReceipts)
      .values({
        companyId: ctx.companyId,
        purchaseOrderId: po.id,
        idempotencyKey: input.idempotencyKey,
        locationId,
        lines: lineInput,
        createdBy: ctx.userId,
      })
      .onConflictDoNothing()
      .returning({ id: purchaseOrderReceipts.id });
    // Lost a race with the same key on another PO (this PO's lock serializes same-PO retries).
    if (!receipt) throw conflict("This receipt was already recorded with different quantities");
    receiptId = receipt.id;
  }
  const lines = await tx
    .select()
    .from(purchaseOrderLines)
    .where(eq(purchaseOrderLines.purchaseOrderId, po.id));
  const lineBy = new Map(lines.map((l) => [l.id, l]));
  const movementIds: string[] = [];
  const touched: string[] = [];
  for (const [i, r] of input.lines.entries()) {
    const line = lineBy.get(r.lineId);
    if (!line) throw notFound("purchase order line", r.lineId);
    const remaining = line.qty - line.receivedQty;
    if (r.qty > remaining) {
      throw badRequest(`Line ${r.lineId}: receiving ${r.qty} but only ${remaining} outstanding`);
    }
    const row = await recordMovement(tx, ctx, {
      blankVariantId: line.blankVariantId,
      locationId,
      kind: "receive",
      qty: r.qty,
      unitCostCents: line.unitCostCents,
      refType: "purchase_order",
      refId: po.id,
      note: input.note,
      idempotencyKey: receiptId ? `receive:${receiptId}:${i}` : null,
    });
    if (row) movementIds.push(row.id);
    touched.push(line.blankVariantId);
    line.receivedQty += r.qty;
    await tx
      .update(purchaseOrderLines)
      .set({ receivedQty: line.receivedQty })
      .where(eq(purchaseOrderLines.id, line.id));
  }
  const complete = lines.every((l) => l.receivedQty >= l.qty);
  const now = new Date();
  await tx
    .update(purchaseOrders)
    .set({
      status: complete ? "received" : "partially_received",
      receivedAt: complete ? now : null,
    })
    .where(eq(purchaseOrders.id, po.id));
  await emit(tx, ctx.companyId, "po.received", { purchaseOrderId: po.id, complete, movementIds });
  await emit(tx, ctx.companyId, "stock.availability_changed", {
    blankVariantIds: [...new Set(touched)],
  });
  await audit(tx, {
    companyId: ctx.companyId,
    actor: ctx.actor,
    action: "purchase_order.receive",
    entityType: "purchase_order",
    entityId: po.id,
    summary: `${po.poNo}: received ${input.lines.reduce((s, l) => s + l.qty, 0)} units${complete ? " (complete)" : ""}`,
  });
  return getPo(tx, ctx, po.id);
}

async function markCancelled(tx: Tx, ctx: Ctx, po: PoRow, summary: string) {
  await tx.update(purchaseOrders).set({ status: "cancelled" }).where(eq(purchaseOrders.id, po.id));
  await audit(tx, {
    companyId: ctx.companyId,
    actor: ctx.actor,
    action: "purchase_order.cancel",
    entityType: "purchase_order",
    entityId: po.id,
    summary,
  });
}

/**
 * Cancels a PO. A draft (or a PO never sent through an API) cancels here. A PO the supplier
 * has is cancelled at the supplier first (outside any transaction); when the supplier can't or
 * won't, it is refused until the supplier shows the order cancelled.
 */
export async function cancelPo(ctx: Ctx, id: string): Promise<PurchaseOrder> {
  const plan = await withTenant(ctx.companyId, async (tx) => {
    const po = await loadPo(tx, ctx, id);
    if (po.status === "cancelled") return null;
    if (po.status === "submitting") {
      throw conflict(
        "This purchase order is being sent to the supplier. Wait until it shows as submitted, then cancel it.",
      );
    }
    if (po.status !== "draft" && po.status !== "submitted") {
      throw invalidTransition("purchase_order", po.id, po.status, "cancelled");
    }
    if (po.status === "draft" || !po.supplierOrderId) {
      await markCancelled(tx, ctx, po, `${po.poNo} cancelled`);
      return null;
    }
    const adapter = await supplierAdapterFor(tx, ctx.companyId, po.supplier);
    return { po, adapter, supplierOrderId: po.supplierOrderId };
  });
  if (!plan) return withTenant(ctx.companyId, (tx) => getPo(tx, ctx, id));

  const name = SUPPLIER_NAMES[plan.po.supplier];
  let how: string | null = null;
  let detail: string | null = null;
  if (plan.adapter?.cancelOrder) {
    try {
      await plan.adapter.cancelOrder(plan.supplierOrderId);
      how = `cancelled at ${name}`;
    } catch (err) {
      detail = (err as Error).message;
    }
  }
  if (!how && plan.adapter) {
    // Already cancelled at the supplier (by hand, or an earlier attempt that we didn't record)?
    const found = await plan.adapter.findOrder(plan.po.poNo).catch(() => null);
    if (found?.cancelled) how = `already cancelled at ${name}`;
  }
  if (!how) {
    log.warn("supplier cancel refused", { purchaseOrderId: id, detail });
    throw conflict(
      `${name} still has order ${plan.supplierOrderId} for ${plan.po.poNo}. Cancel it with ${name} first, then cancel it here.`,
    );
  }

  return withTenant(ctx.companyId, async (tx) => {
    const po = await loadPo(tx, ctx, id);
    if (po.status === "submitted") {
      await markCancelled(tx, ctx, po, `${po.poNo} cancelled (${how}, ${plan.supplierOrderId})`);
    }
    return getPo(tx, ctx, id);
  });
}
