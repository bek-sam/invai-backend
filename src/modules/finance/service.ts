import {
  type AdSpend,
  type AdSpendInput as AdSpendInputSchema,
  CHANNEL_RULES,
  CHANNELS,
  type Channel,
  type CostSettings,
  type CostSettingsInput as CostSettingsInputSchema,
  type OrderProfit,
  type ProfitSummary,
} from "@invai/contracts";
import {
  and,
  asc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  type SQL,
  sql,
} from "drizzle-orm";
import type { z } from "zod";
import type { TenantContext } from "../../api/context";
import { afterCommit, type Tx } from "../../db/client";
import {
  adSpend,
  blankVariants,
  companies,
  costSettings,
  designFiles,
  designs,
  gangSheets,
  jobs,
  orderItems,
  orders,
  profitLines,
  refundEvents,
  shipments,
  transfers,
} from "../../db/schema";
import { audit } from "../../lib/audit";
import { col, parseCsvObjects, toCsv } from "../../lib/csv";
import { badRequest, notFound } from "../../lib/errors";
import { emit } from "../../lib/outbox";
import { keyset, type PageInput } from "../../lib/pagination";
import { publish } from "../../lib/realtime";
import { getObject, objectKey, putObject } from "../../lib/s3";
import { feeCategoryOf } from "./fees";
import {
  allocate,
  allocateAdSpend,
  type Buckets,
  defaultFeeTable,
  emptyBuckets,
  type FeeTable,
  feeTableFor,
  finalize,
  laborCost,
  orderFees,
  printAreaSqIn,
  sumBuckets,
  transferCost,
} from "./profit";
import { listRefunds } from "./refunds";

/*
 * Finance: cost settings, ad spend and true profit per order item. Profit lines are
 * materialized into `profit_lines` by `recomputeProfit` (the finance.recompute job) and read by
 * `getProfit` / `orderProfit`. Orders, items, shipments and production rows are read only.
 */

type Ctx = Pick<TenantContext, "companyId" | "userId" | "actor">;
type CostSettingsRow = typeof costSettings.$inferSelect;
type CostSettingsInput = z.infer<typeof CostSettingsInputSchema>;
type AdSpendInput = z.infer<typeof AdSpendInputSchema>;
type Period = { from: string; to: string };

/** Default label cost per order when nothing was bought yet and there is no history. */
const DEFAULT_LABEL_CENTS = 525;

/* ------------------------------- cost settings ------------------------------- */

const FEE_CHANNELS: Channel[] = ["etsy", "amazon", "shopify", "tiktok", "walmart", "ebay", "csv"];

function defaultFeeTables(): FeeTable[] {
  return FEE_CHANNELS.map(defaultFeeTable);
}

export async function ensureCostSettings(tx: Tx, companyId: string): Promise<CostSettingsRow> {
  const [row] = await tx.select().from(costSettings).where(eq(costSettings.companyId, companyId));
  if (row) return row;
  await tx
    .insert(costSettings)
    .values({ companyId, feeTables: defaultFeeTables() })
    .onConflictDoNothing();
  const [created] = await tx
    .select()
    .from(costSettings)
    .where(eq(costSettings.companyId, companyId));
  if (!created) throw new Error("cost settings insert failed");
  return created;
}

/** Saved fee tables plus CHANNEL_RULES defaults for channels the shop never edited. */
export function feeTablesOf(row: CostSettingsRow): FeeTable[] {
  const saved = row.feeTables as FeeTable[];
  return [
    ...saved,
    ...defaultFeeTables().filter((d) => !saved.some((s) => s.channel === d.channel)),
  ];
}

function toCostSettings(row: CostSettingsRow): CostSettings {
  return {
    feeTables: feeTablesOf(row).map((t) => ({ ...t, channel: t.channel as Channel })),
    transferCentsPerSqIn: row.transferCentsPerSqIn,
    packagingPerOrder: row.packagingPerOrderCents,
    laborRatePerHour: row.laborRatePerHourCents,
    laborMinutesPerItem: row.laborMinutesPerItem,
    adsAllocation: row.adsAllocation,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function getCostSettings(tx: Tx, ctx: Pick<TenantContext, "companyId">) {
  return toCostSettings(await ensureCostSettings(tx, ctx.companyId));
}

export async function updateCostSettings(
  tx: Tx,
  ctx: Ctx,
  input: CostSettingsInput,
): Promise<CostSettings> {
  const current = await ensureCostSettings(tx, ctx.companyId);
  let feeTables = feeTablesOf(current);
  if (input.feeTables) {
    for (const t of input.feeTables) {
      feeTables = [...feeTables.filter((f) => f.channel !== t.channel), t];
    }
  }
  const [row] = await tx
    .update(costSettings)
    .set({
      feeTables,
      transferCentsPerSqIn: input.transferCentsPerSqIn ?? current.transferCentsPerSqIn,
      packagingPerOrderCents: input.packagingPerOrder ?? current.packagingPerOrderCents,
      laborRatePerHourCents: input.laborRatePerHour ?? current.laborRatePerHourCents,
      laborMinutesPerItem: input.laborMinutesPerItem ?? current.laborMinutesPerItem,
      adsAllocation: input.adsAllocation ?? current.adsAllocation,
      updatedAt: new Date(),
    })
    .where(eq(costSettings.companyId, ctx.companyId))
    .returning();
  if (!row) throw notFound("cost settings");
  await audit(tx, {
    companyId: ctx.companyId,
    actor: ctx.actor,
    action: "cost_settings.update",
    entityType: "cost_settings",
    entityId: row.id,
    summary: `Updated ${Object.keys(input).join(", ")}`,
    data: input as Record<string, unknown>,
  });
  if (ctx.userId) await emit(tx, ctx.companyId, "cost_settings.changed", { userId: ctx.userId });
  return toCostSettings(row);
}

/* ---------------------------------- ad spend --------------------------------- */

type AdSpendRow = typeof adSpend.$inferSelect;

function toAdSpend(row: AdSpendRow): AdSpend {
  return {
    id: row.id,
    date: row.day,
    channel: row.channel,
    amount: row.amountCents,
    campaign: row.campaign,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listAdSpend(
  tx: Tx,
  ctx: Pick<TenantContext, "companyId">,
  input: PageInput & { channel?: Channel; from?: string; to?: string },
) {
  const filters: SQL[] = [eq(adSpend.companyId, ctx.companyId)];
  if (input.channel) filters.push(eq(adSpend.channel, input.channel));
  if (input.from) filters.push(gte(adSpend.day, input.from));
  if (input.to) filters.push(lte(adSpend.day, input.to));
  const page = keyset(adSpend.createdAt, adSpend.id, input);
  const rows = await tx
    .select()
    .from(adSpend)
    .where(and(...filters, page.where))
    .orderBy(...page.orderBy)
    .limit(page.limit + 1);
  const [total] = await tx
    .select({ n: sql<number>`coalesce(sum(${adSpend.amountCents}), 0)::int` })
    .from(adSpend)
    .where(and(...filters));
  return { ...page.result(rows, toAdSpend), total: total?.n ?? 0 };
}

async function spendChanged(tx: Tx, ctx: Ctx, days: string[]) {
  // Ad allocation depends on the day's spend: queue a recompute of the affected days.
  const sorted = [...new Set(days)].sort();
  const from = sorted[0];
  const to = sorted[sorted.length - 1];
  if (!from || !to) return;
  await emit(tx, ctx.companyId, "finance.ad_spend_changed", { from, to });
}

export async function createAdSpend(tx: Tx, ctx: Ctx, input: AdSpendInput): Promise<AdSpend> {
  const [row] = await tx
    .insert(adSpend)
    .values({
      companyId: ctx.companyId,
      day: input.date,
      channel: input.channel,
      amountCents: input.amount,
      campaign: input.campaign ?? null,
      note: input.note ?? null,
    })
    .returning();
  if (!row) throw new Error("ad spend insert failed");
  await spendChanged(tx, ctx, [row.day]);
  return toAdSpend(row);
}

export async function updateAdSpend(
  tx: Tx,
  ctx: Ctx,
  input: Partial<AdSpendInput> & { id: string },
): Promise<AdSpend> {
  const [before] = await tx.select().from(adSpend).where(eq(adSpend.id, input.id));
  if (!before) throw notFound("ad spend", input.id);
  const [row] = await tx
    .update(adSpend)
    .set({
      day: input.date ?? before.day,
      channel: input.channel ?? before.channel,
      amountCents: input.amount ?? before.amountCents,
      campaign: input.campaign !== undefined ? input.campaign : before.campaign,
      note: input.note !== undefined ? input.note : before.note,
    })
    .where(eq(adSpend.id, input.id))
    .returning();
  if (!row) throw notFound("ad spend", input.id);
  await spendChanged(tx, ctx, [before.day, row.day]);
  return toAdSpend(row);
}

export async function deleteAdSpend(tx: Tx, ctx: Ctx, id: string) {
  const [row] = await tx.delete(adSpend).where(eq(adSpend.id, id)).returning();
  if (!row) throw notFound("ad spend", id);
  await spendChanged(tx, ctx, [row.day]);
  return { ok: true as const };
}

/** "2026-09-01", "9/1/2026" or "09/01/26" → YYYY-MM-DD, else null. */
export function parseCsvDate(raw: string): string | null {
  const s = raw.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return iso(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s);
  if (m) {
    const y = Number(m[3]);
    return iso(y < 100 ? 2000 + y : y, Number(m[1]), Number(m[2]));
  }
  return null;
}

function iso(y: number, mo: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d)
    return null;
  return dt.toISOString().slice(0, 10);
}

/** Dollars ("$1,234.50") → cents. `amount_cents` columns are taken as cents. */
export function parseCsvAmount(raw: string, isCents: boolean): number | null {
  const s = raw.replace(/[$,\s]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  const cents = isCents ? Math.round(n) : Math.round(n * 100);
  return cents >= 0 ? cents : null;
}

/**
 * CSV columns: `date`, `channel` (etsy, amazon, shopify, tiktok, walmart, ebay, csv), `amount`
 * in dollars (or `amount_cents` in cents), optional `campaign` and `note`.
 */
export async function importAdSpendCsv(tx: Tx, ctx: Ctx, fileKey: string) {
  if (!fileKey.startsWith(`${ctx.companyId}/`))
    throw badRequest("File does not belong to this company");
  const text = (await getObject(fileKey)).toString("utf8");
  const { rows } = parseCsvObjects(text);
  const errors: { row: number; message: string }[] = [];
  const values: (typeof adSpend.$inferInsert)[] = [];
  for (const [i, r] of rows.entries()) {
    const rowNo = i + 2;
    const date = parseCsvDate(col(r, "date", "day"));
    const channel = col(r, "channel", "platform").toLowerCase() as Channel;
    const centsRaw = col(r, "amount_cents");
    const amount = centsRaw
      ? parseCsvAmount(centsRaw, true)
      : parseCsvAmount(col(r, "amount", "spend", "cost"), false);
    if (!date) {
      errors.push({ row: rowNo, message: "Invalid or missing date" });
      continue;
    }
    if (!CHANNELS.includes(channel)) {
      errors.push({ row: rowNo, message: `Unknown channel "${channel}"` });
      continue;
    }
    if (amount == null) {
      errors.push({ row: rowNo, message: "Invalid amount" });
      continue;
    }
    values.push({
      companyId: ctx.companyId,
      day: date,
      channel,
      amountCents: amount,
      campaign: col(r, "campaign") || null,
      note: col(r, "note", "notes") || null,
    });
  }
  if (values.length) {
    await tx.insert(adSpend).values(values);
    await spendChanged(
      tx,
      ctx,
      values.map((v) => v.day),
    );
  }
  return { created: values.length, failed: errors.length, errors };
}

/* ------------------------------ profit recompute ----------------------------- */

async function companyTimezone(tx: Tx, companyId: string): Promise<string> {
  const [row] = await tx
    .select({ tz: companies.timezone })
    .from(companies)
    .where(eq(companies.id, companyId));
  return row?.tz ?? "America/Phoenix";
}

export function localDay(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

type LineOut = Omit<Buckets, "net" | "marginPct"> & {
  orderItemId: string;
  orderId: string;
  channel: Channel;
  designId: string | null;
  blankVariantId: string | null;
  styleCode: string | null;
  printAreaSqIn: number;
  laborMinutes: number;
  isReprint: boolean;
  estimated: string[];
  placedAt: Date;
};

export type RecomputeScope = { orderIds?: string[]; from?: Date; to?: Date };

/**
 * Recompute and upsert profit lines for the orders in scope (explicit ids or placed-at range).
 * Returns the recomputed order ids.
 */
export async function recomputeProfit(
  tx: Tx,
  ctx: Pick<TenantContext, "companyId">,
  scope: RecomputeScope,
  onProgress?: (done: number, total: number) => Promise<void> | void,
): Promise<{ orderIds: string[]; lines: number }> {
  const companyId = ctx.companyId;
  const filters: SQL[] = [eq(orders.companyId, companyId)];
  if (scope.orderIds) {
    if (!scope.orderIds.length) return { orderIds: [], lines: 0 };
    filters.push(inArray(orders.id, scope.orderIds));
  }
  if (scope.from) filters.push(gte(orders.placedAt, scope.from));
  if (scope.to) filters.push(lt(orders.placedAt, scope.to));
  const orderRows = await tx
    .select()
    .from(orders)
    .where(and(...filters))
    .orderBy(asc(orders.placedAt));
  if (!orderRows.length) return { orderIds: [], lines: 0 };

  const settings = await ensureCostSettings(tx, companyId);
  const feeTables = feeTablesOf(settings);
  const tz = await companyTimezone(tx, companyId);
  const labelEstimate = await estimatedLabelCents(tx, companyId);
  const adsByOrder = await adsPerOrder(tx, companyId, orderRows, tz, settings.adsAllocation);

  let lines = 0;
  const CHUNK = 200;
  for (let i = 0; i < orderRows.length; i += CHUNK) {
    const chunk = orderRows.slice(i, i + CHUNK);
    const out = await computeChunk(tx, companyId, chunk, {
      settings,
      feeTables,
      labelEstimate,
      adsByOrder,
    });
    lines += await upsertLines(tx, companyId, out);
    await onProgress?.(Math.min(i + CHUNK, orderRows.length), orderRows.length);
  }
  return { orderIds: orderRows.map((o) => o.id), lines };
}

async function estimatedLabelCents(tx: Tx, companyId: string): Promise<number> {
  const [row] = await tx
    .select({
      avg: sql<number | null>`avg(${shipments.postageCents} + ${shipments.labelFeeCents})`,
    })
    .from(shipments)
    .where(
      and(
        eq(shipments.companyId, companyId),
        ne(shipments.status, "voided"),
        isNotNull(shipments.labeledAt),
        gte(shipments.labeledAt, new Date(Date.now() - 90 * 86400_000)),
      ),
    );
  const avg = row?.avg == null ? null : Number(row.avg);
  return avg && avg > 0 ? Math.round(avg) : DEFAULT_LABEL_CENTS;
}

type OrderRow = typeof orders.$inferSelect;

/** Ad spend per order: each channel-day's spend spread over that day's live orders. */
async function adsPerOrder(
  tx: Tx,
  companyId: string,
  scoped: OrderRow[],
  tz: string,
  mode: "revenue_share" | "per_order",
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const days = scoped.map((o) => localDay(o.placedAt, tz)).sort();
  const minDay = days[0];
  const maxDay = days[days.length - 1];
  if (!minDay || !maxDay) return out;
  const spend = await tx
    .select({
      day: adSpend.day,
      channel: adSpend.channel,
      cents: sql<number>`sum(${adSpend.amountCents})::int`,
    })
    .from(adSpend)
    .where(
      and(eq(adSpend.companyId, companyId), gte(adSpend.day, minDay), lte(adSpend.day, maxDay)),
    )
    .groupBy(adSpend.day, adSpend.channel);
  if (!spend.length) return out;
  // Every order on those days (not only the scoped ones) shares the spend.
  const pad = 36 * 3600_000;
  const peers = await tx
    .select({
      id: orders.id,
      channel: orders.channel,
      placedAt: orders.placedAt,
      revenue: sql<number>`(${orders.subtotalCents} - ${orders.discountCents} + ${orders.shippingCents})::int`,
    })
    .from(orders)
    .where(
      and(
        eq(orders.companyId, companyId),
        ne(orders.status, "cancelled"),
        gte(orders.placedAt, new Date(new Date(`${minDay}T00:00:00Z`).getTime() - pad)),
        lt(orders.placedAt, new Date(new Date(`${maxDay}T00:00:00Z`).getTime() + 86400_000 + pad)),
      ),
    );
  const byKey = new Map<string, { key: string; revenueCents: number }[]>();
  for (const p of peers) {
    const k = `${p.channel}|${localDay(p.placedAt, tz)}`;
    const list = byKey.get(k) ?? [];
    list.push({ key: p.id, revenueCents: p.revenue });
    byKey.set(k, list);
  }
  for (const s of spend) {
    const list = byKey.get(`${s.channel}|${s.day}`);
    if (!list?.length) continue;
    for (const [id, cents] of allocateAdSpend(s.cents, list, mode)) {
      out.set(id, (out.get(id) ?? 0) + cents);
    }
  }
  return out;
}

async function computeChunk(
  tx: Tx,
  companyId: string,
  chunk: OrderRow[],
  env: {
    settings: CostSettingsRow;
    feeTables: FeeTable[];
    labelEstimate: number;
    adsByOrder: Map<string, number>;
  },
): Promise<LineOut[]> {
  const orderIds = chunk.map((o) => o.id);
  const items = await tx
    .select()
    .from(orderItems)
    .where(and(eq(orderItems.companyId, companyId), inArray(orderItems.orderId, orderIds)))
    .orderBy(asc(orderItems.lineNo), asc(orderItems.unitNo));
  if (!items.length) return [];

  const blankIds = [...new Set(items.map((i) => i.blankVariantId).filter((x): x is string => !!x))];
  const blanks = new Map(
    (blankIds.length
      ? await tx
          .select({
            id: blankVariants.id,
            cost: blankVariants.costCents,
            styleCode: blankVariants.styleCode,
            style: blankVariants.style,
            styleName: blankVariants.styleName,
          })
          .from(blankVariants)
          .where(inArray(blankVariants.id, blankIds))
      : []
    ).map((b) => [b.id, b]),
  );

  const designIds = [...new Set(items.map((i) => i.designId).filter((x): x is string => !!x))];
  const files = designIds.length
    ? await tx
        .select({
          designId: designFiles.designId,
          placement: designFiles.placement,
          w: designFiles.widthIn,
          h: designFiles.heightIn,
        })
        .from(designFiles)
        .where(inArray(designFiles.designId, designIds))
    : [];
  const fileArea = (designId: string | null, placement: string | null) => {
    if (!designId) return 0;
    const f =
      files.find((x) => x.designId === designId && x.placement === (placement ?? "front")) ??
      files.find((x) => x.designId === designId);
    return f ? printAreaSqIn(f.w, f.h) : 0;
  };

  const itemIds = items.map((i) => i.id);
  const transferRows = await tx
    .select({
      orderItemId: transfers.orderItemId,
      gangSheetId: transfers.gangSheetId,
      w: transfers.widthIn,
      h: transfers.heightIn,
      isReprint: transfers.isReprint,
    })
    .from(transfers)
    .where(and(eq(transfers.companyId, companyId), inArray(transfers.orderItemId, itemIds)));
  const sheetIds = [...new Set(transferRows.map((t) => t.gangSheetId))];
  const sheets = new Map<string, { cost: number; area: number }>();
  if (sheetIds.length) {
    const sheetRows = await tx
      .select({
        id: gangSheets.id,
        cost: gangSheets.costCents,
        area: sql<number>`(select coalesce(sum(t.width_in * t.height_in), 0) from transfers t where t.gang_sheet_id = ${gangSheets.id})`,
      })
      .from(gangSheets)
      .where(inArray(gangSheets.id, sheetIds));
    for (const s of sheetRows) sheets.set(s.id, { cost: s.cost, area: Number(s.area) });
  }
  const transfersByItem = new Map<string, typeof transferRows>();
  for (const t of transferRows) {
    const list = transfersByItem.get(t.orderItemId) ?? [];
    list.push(t);
    transfersByItem.set(t.orderItemId, list);
  }

  const shipRows = await tx
    .select({
      orderId: shipments.orderId,
      itemIds: shipments.orderItemIds,
      cost: sql<number>`(${shipments.postageCents} + ${shipments.labelFeeCents})::int`,
    })
    .from(shipments)
    .where(
      and(
        eq(shipments.companyId, companyId),
        inArray(shipments.orderId, orderIds),
        ne(shipments.status, "voided"),
        isNotNull(shipments.labeledAt),
      ),
    );

  const { settings, feeTables, labelEstimate, adsByOrder } = env;
  const out: LineOut[] = [];
  for (const order of chunk) {
    const its = items.filter((i) => i.orderId === order.id);
    if (!its.length) continue;
    const sellable = its.filter((i) => !i.isReprint);
    const active = its.filter((i) => i.state !== "cancelled");
    const activeSellable = sellable.filter((i) => i.state !== "cancelled");

    // Revenue: unit price − discount share + shipping share (reprints earn nothing).
    const discount = allocate(
      order.discountCents,
      sellable.map((i) => i.unitPriceCents),
    );
    const shipping = allocate(
      order.shippingCents,
      sellable.map(() => 1),
    );
    // Sales tax is never revenue (T-7-2). Shopify shops that price tax-inclusive send item and
    // shipping prices with the tax inside (total = subtotal + shipping); take it back out.
    const taxInside = taxInclusive(order);
    const gross = sellable.map(
      (it, k) => it.unitPriceCents - (discount[k] ?? 0) + (shipping[k] ?? 0),
    );
    const taxOut = taxInside ? allocate(order.taxCents, gross) : [];
    const revenue = new Map<string, number>();
    sellable.forEach((it, k) => {
      revenue.set(it.id, (gross[k] ?? 0) - (taxOut[k] ?? 0));
    });
    const rev = (id: string) => revenue.get(id) ?? 0;

    // Fees on what the buyer kept (cancelled units are refunded, fees with them).
    const activeRevenue = activeSellable.reduce((a, i) => a + rev(i.id), 0);
    const fullRevenue = sellable.reduce((a, i) => a + rev(i.id), 0);
    const taxShare =
      fullRevenue > 0 ? Math.round((order.taxCents * activeRevenue) / fullRevenue) : 0;
    const fees = orderFees(feeTableFor(feeTables, order.channel), {
      revenueCents: activeRevenue,
      buyerTotalCents: activeRevenue + taxShare,
      units: activeSellable.length,
      unitSales: activeSellable.map((i) => ({
        cents: rev(i.id),
        category: categoryOf(i.blankVariantId ? blanks.get(i.blankVariantId) : undefined),
      })),
    });
    const feeSplit = splitFees(
      fees,
      activeSellable.map((i) => rev(i.id)),
    );
    const packSplit = allocate(
      activeSellable.length ? settings.packagingPerOrderCents : 0,
      activeSellable.map(() => 1),
    );
    const adsSplit = allocate(
      adsByOrder.get(order.id) ?? 0,
      activeSellable.map((i) => rev(i.id)),
    );

    // Labels: actual postage split over the shipment's units, else an estimate per order.
    const labelCost = new Map<string, number>();
    const ships = shipRows.filter((s) => s.orderId === order.id);
    let labelEstimated = false;
    if (ships.length) {
      for (const s of ships) {
        const covered = active.filter((i) => s.itemIds.includes(i.id));
        const targets = covered.length ? covered : activeSellable;
        allocate(
          s.cost,
          targets.map(() => 1),
        ).forEach((c, k) => {
          const id = targets[k]?.id;
          if (id) labelCost.set(id, (labelCost.get(id) ?? 0) + c);
        });
      }
    } else if (activeSellable.length) {
      labelEstimated = true;
      allocate(
        labelEstimate,
        activeSellable.map(() => 1),
      ).forEach((c, k) => {
        const id = activeSellable[k]?.id;
        if (id) labelCost.set(id, c);
      });
    }

    for (const it of its) {
      const cancelled = it.state === "cancelled";
      const estimated = new Set<string>(["channelFees", "adsCost"]);
      const blank = it.blankVariantId ? blanks.get(it.blankVariantId) : undefined;
      if (!blank) estimated.add("blankCost");

      // Transfer: every transfer printed for this item (reprints add more), else an estimate.
      const trs = transfersByItem.get(it.id) ?? [];
      let transfer = 0;
      let area = 0;
      if (trs.length) {
        for (const t of trs) {
          const a = printAreaSqIn(t.w, t.h);
          const sheet = sheets.get(t.gangSheetId);
          const tc = transferCost({
            areaSqIn: a,
            centsPerSqIn: settings.transferCentsPerSqIn,
            sheetCostCents: sheet?.cost,
            sheetAreaSqIn: sheet?.area,
          });
          transfer += tc.cents;
          if (tc.estimated) estimated.add("transferCost");
          area = a;
        }
      } else if (!cancelled) {
        area =
          printAreaSqIn(it.printWidthIn, it.printHeightIn) || fileArea(it.designId, it.placement);
        transfer = transferCost({
          areaSqIn: area,
          centsPerSqIn: settings.transferCentsPerSqIn,
        }).cents;
        estimated.add("transferCost");
      }

      const k = activeSellable.indexOf(it);
      const minutes = cancelled ? 0 : settings.laborMinutesPerItem;
      if (labelEstimated && !cancelled) estimated.add("labelCost");
      const line = {
        revenue: rev(it.id),
        channelFees: k >= 0 ? (feeSplit[k] ?? 0) : 0,
        blankCost: cancelled ? 0 : (blank?.cost ?? 0),
        transferCost: transfer,
        labelCost: labelCost.get(it.id) ?? 0,
        packagingCost: k >= 0 ? (packSplit[k] ?? 0) : 0,
        laborCost: laborCost(minutes, settings.laborRatePerHourCents),
        adsCost: k >= 0 ? (adsSplit[k] ?? 0) : 0,
        refunds: cancelled ? rev(it.id) : 0,
      };
      out.push({
        ...line,
        orderItemId: it.id,
        orderId: order.id,
        channel: order.channel,
        designId: it.designId,
        blankVariantId: it.blankVariantId,
        styleCode: blank?.styleCode ?? null,
        printAreaSqIn: area,
        laborMinutes: minutes,
        isReprint: it.isReprint,
        estimated: [...estimated],
        placedAt: order.placedAt,
      });
    }
  }
  return out;
}

/** Shopify prices that already include tax: the order total adds no tax on top. */
export function taxInclusive(o: {
  channel: string;
  subtotalCents: number;
  shippingCents: number;
  taxCents: number;
  totalCents: number;
}): boolean {
  return (
    o.channel === "shopify" &&
    o.taxCents > 0 &&
    Math.abs(o.totalCents - (o.subtotalCents + o.shippingCents)) <= 1
  );
}

function categoryOf(blank: { style: string | null; styleName: string | null } | undefined) {
  return feeCategoryOf(blank?.style ? `${blank.style} ${blank.styleName ?? ""}` : null);
}

/** Per-unit fee shares: each unit's own referral fee, the rest by revenue share. */
export function splitFees(
  fees: { total: number; referralPerUnit: number[] | null },
  revenues: number[],
): number[] {
  const referral = fees.referralPerUnit ?? revenues.map(() => 0);
  const rest = allocate(fees.total - referral.reduce((a, b) => a + b, 0), revenues);
  return revenues.map((_, k) => (referral[k] ?? 0) + (rest[k] ?? 0));
}

async function upsertLines(tx: Tx, companyId: string, lines: LineOut[]): Promise<number> {
  if (!lines.length) return 0;
  const now = new Date();
  const values = lines.map((l) => {
    const b = finalize(l);
    return {
      companyId,
      orderId: l.orderId,
      orderItemId: l.orderItemId,
      channel: l.channel,
      designId: l.designId,
      blankVariantId: l.blankVariantId,
      styleCode: l.styleCode,
      revenueCents: b.revenue,
      channelFeesCents: b.channelFees,
      blankCostCents: b.blankCost,
      transferCostCents: b.transferCost,
      labelCostCents: b.labelCost,
      packagingCostCents: b.packagingCost,
      laborCostCents: b.laborCost,
      adsCostCents: b.adsCost,
      refundsCents: b.refunds,
      netCents: b.net,
      marginPct: b.marginPct,
      printAreaSqIn: l.printAreaSqIn,
      laborMinutes: l.laborMinutes,
      isReprint: l.isReprint,
      estimated: l.estimated,
      placedAt: l.placedAt,
      computedAt: now,
    };
  });
  const ex = (c: string) => sql.raw(`excluded.${c}`);
  await tx
    .insert(profitLines)
    .values(values)
    .onConflictDoUpdate({
      target: [profitLines.companyId, profitLines.orderItemId],
      set: {
        channel: ex("channel"),
        designId: ex("design_id"),
        blankVariantId: ex("blank_variant_id"),
        styleCode: ex("style_code"),
        revenueCents: ex("revenue_cents"),
        channelFeesCents: ex("channel_fees_cents"),
        blankCostCents: ex("blank_cost_cents"),
        transferCostCents: ex("transfer_cost_cents"),
        labelCostCents: ex("label_cost_cents"),
        packagingCostCents: ex("packaging_cost_cents"),
        laborCostCents: ex("labor_cost_cents"),
        adsCostCents: ex("ads_cost_cents"),
        refundsCents: ex("refunds_cents"),
        netCents: ex("net_cents"),
        marginPct: ex("margin_pct"),
        printAreaSqIn: ex("print_area_sq_in"),
        laborMinutes: ex("labor_minutes"),
        isReprint: ex("is_reprint"),
        estimated: ex("estimated"),
        placedAt: ex("placed_at"),
        computedAt: ex("computed_at"),
      },
    });
  return values.length;
}

/* ----------------------------------- reads ----------------------------------- */

export type ProfitInput = {
  dimension: "order" | "design" | "blank" | "channel" | "day";
  period: Period;
  channel?: Channel;
  designId?: string;
  limit?: number;
  sort?: "net" | "revenue" | "marginPct" | "units" | "key";
};

const sums = {
  revenue: sql<number>`coalesce(sum(${profitLines.revenueCents}), 0)::int`,
  channelFees: sql<number>`coalesce(sum(${profitLines.channelFeesCents}), 0)::int`,
  blankCost: sql<number>`coalesce(sum(${profitLines.blankCostCents}), 0)::int`,
  transferCost: sql<number>`coalesce(sum(${profitLines.transferCostCents}), 0)::int`,
  labelCost: sql<number>`coalesce(sum(${profitLines.labelCostCents}), 0)::int`,
  packagingCost: sql<number>`coalesce(sum(${profitLines.packagingCostCents}), 0)::int`,
  laborCost: sql<number>`coalesce(sum(${profitLines.laborCostCents}), 0)::int`,
  adsCost: sql<number>`coalesce(sum(${profitLines.adsCostCents}), 0)::int`,
  refunds: sql<number>`coalesce(sum(${profitLines.refundsCents}), 0)::int`,
  orders: sql<number>`count(distinct ${profitLines.orderId})::int`,
  units: sql<number>`(count(*) filter (where not ${profitLines.isReprint} and ${profitLines.refundsCents} = 0))::int`,
  computedAt: sql<Date | null>`max(${profitLines.computedAt})`,
};

/** True profit grouped by one dimension over a period (placed-at in the period). */
export async function getProfit(
  tx: Tx,
  ctx: Pick<TenantContext, "companyId">,
  input: ProfitInput,
): Promise<ProfitSummary> {
  const from = new Date(input.period.from);
  const to = new Date(input.period.to);
  const tz = await companyTimezone(tx, ctx.companyId);
  const filters: SQL[] = [
    eq(profitLines.companyId, ctx.companyId),
    gte(profitLines.placedAt, from),
    lt(profitLines.placedAt, to),
  ];
  if (input.channel) filters.push(eq(profitLines.channel, input.channel));
  if (input.designId) filters.push(eq(profitLines.designId, input.designId));

  const keyExpr: Record<ProfitInput["dimension"], SQL<string>> = {
    order: sql<string>`${profitLines.orderId}::text`,
    design: sql<string>`coalesce(${profitLines.designId}::text, 'unmapped')`,
    blank: sql<string>`coalesce(${profitLines.styleCode}, 'unmapped')`,
    channel: sql<string>`${profitLines.channel}`,
    day: sql<string>`to_char(${profitLines.placedAt} at time zone ${tz}, 'YYYY-MM-DD')`,
  };
  const key = keyExpr[input.dimension];
  const labelExpr: Record<ProfitInput["dimension"], SQL<string | null>> = {
    order: sql<string | null>`max(${orders.orderNo})`,
    design: sql<string | null>`max(${designs.name})`,
    blank: sql<
      string | null
    >`max(${blankVariants.brand} || ' ' || ${blankVariants.styleCode} || coalesce(' ' || ${blankVariants.styleName}, ''))`,
    channel: sql<string | null>`null`,
    day: sql<string | null>`null`,
  };

  let q = tx
    .select({ key, label: labelExpr[input.dimension], ...sums })
    .from(profitLines)
    .$dynamic();
  if (input.dimension === "order") q = q.leftJoin(orders, eq(orders.id, profitLines.orderId));
  if (input.dimension === "design") q = q.leftJoin(designs, eq(designs.id, profitLines.designId));
  if (input.dimension === "blank")
    q = q.leftJoin(blankVariants, eq(blankVariants.id, profitLines.blankVariantId));
  // GROUP BY the first select column: the day key binds the time zone as a parameter, and
  // Postgres won't match `$1` in the select list to `$5` in GROUP BY (500 on the day view).
  const groups = await q.where(and(...filters)).groupBy(sql`1`);
  mergeRefunds(groups, await refundGroups(tx, ctx.companyId, input, tz));

  const rows = groups.map((g) => {
    const b = finalize(g);
    const label =
      input.dimension === "channel"
        ? (CHANNEL_RULES[g.key as Channel]?.label ?? g.key)
        : g.key === "unmapped"
          ? input.dimension === "design"
            ? "Unmapped design"
            : "Unmapped blank"
          : (g.label ?? g.key);
    return { key: g.key, label, orders: g.orders, units: g.units, ...b };
  });
  const sort = input.sort ?? "net";
  rows.sort((a, b) => {
    if (sort === "key") return a.key.localeCompare(b.key);
    const va = sort === "marginPct" ? (a.marginPct ?? -Infinity) : a[sort];
    const vb = sort === "marginPct" ? (b.marginPct ?? -Infinity) : b[sort];
    return vb - va;
  });
  const totals = sumBuckets(groups);

  // Incomplete: orders in the period with items but no profit line yet.
  const [missing] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(orders)
    .where(
      and(
        eq(orders.companyId, ctx.companyId),
        gte(orders.placedAt, from),
        lt(orders.placedAt, to),
        input.channel ? eq(orders.channel, input.channel) : undefined,
        sql`exists (select 1 from order_items oi where oi.order_id = ${orders.id})`,
        sql`not exists (select 1 from profit_lines pl where pl.order_id = ${orders.id})`,
      ),
    );
  const computedAt = groups.reduce<Date | null>((m, g) => {
    const d = g.computedAt ? new Date(g.computedAt) : null;
    return d && (!m || d > m) ? d : m;
  }, null);
  return {
    dimension: input.dimension,
    period: input.period,
    rows: rows.slice(0, input.limit ?? 200),
    totals,
    incomplete: (missing?.n ?? 0) > 0,
    computedAt: (computedAt ?? new Date()).toISOString(),
  };
}

/**
 * T-7-2: refunds and the channel fee they give back, per dimension key, dated by the refund's
 * own `refundedAt` (not the order's placed-at), so a refund lands in its own period.
 */
async function refundGroups(tx: Tx, companyId: string, input: ProfitInput, tz: string) {
  const r = refundEvents;
  const keyExpr: Record<ProfitInput["dimension"], SQL<string>> = {
    order: sql<string>`${r.orderId}::text`,
    design: sql<string>`coalesce(${orderItems.designId}::text, 'unmapped')`,
    blank: sql<string>`coalesce(${blankVariants.styleCode}, 'unmapped')`,
    channel: sql<string>`${r.channel}`,
    day: sql<string>`to_char(${r.refundedAt} at time zone ${tz}, 'YYYY-MM-DD')`,
  };
  const labelExpr: Record<ProfitInput["dimension"], SQL<string | null>> = {
    order: sql<string | null>`max(${orders.orderNo})`,
    design: sql<string | null>`max(${designs.name})`,
    blank: sql<
      string | null
    >`max(${blankVariants.brand} || ' ' || ${blankVariants.styleCode} || coalesce(' ' || ${blankVariants.styleName}, ''))`,
    channel: sql<string | null>`null`,
    day: sql<string | null>`null`,
  };
  const key = keyExpr[input.dimension];
  return tx
    .select({
      key,
      label: labelExpr[input.dimension],
      amount: sql<number>`coalesce(sum(${r.amountCents}), 0)::int`,
      recovered: sql<number>`coalesce(sum(${r.feeRecoveredCents}), 0)::int`,
    })
    .from(r)
    .innerJoin(orders, eq(orders.id, r.orderId))
    .leftJoin(orderItems, eq(orderItems.id, r.orderItemId))
    .leftJoin(designs, eq(designs.id, orderItems.designId))
    .leftJoin(blankVariants, eq(blankVariants.id, orderItems.blankVariantId))
    .where(
      and(
        eq(r.companyId, companyId),
        isNull(r.voidedAt),
        gte(r.refundedAt, new Date(input.period.from)),
        lt(r.refundedAt, new Date(input.period.to)),
        input.channel ? eq(r.channel, input.channel) : undefined,
        input.designId ? eq(orderItems.designId, input.designId) : undefined,
      ),
    )
    .groupBy(sql`1`);
}

type ProfitGroup = Omit<Buckets, "net" | "marginPct"> & {
  key: string;
  label: string | null;
  orders: number;
  units: number;
  computedAt: Date | null;
};

/** Add refund events into the profit groups: refunds up, channel fees down by what came back. */
export function mergeRefunds(
  groups: ProfitGroup[],
  refunds: { key: string; label: string | null; amount: number; recovered: number }[],
): void {
  const byKey = new Map(groups.map((g) => [g.key, g]));
  for (const r of refunds) {
    let g = byKey.get(r.key);
    if (!g) {
      g = {
        key: r.key,
        label: r.label,
        revenue: 0,
        channelFees: 0,
        blankCost: 0,
        transferCost: 0,
        labelCost: 0,
        packagingCost: 0,
        laborCost: 0,
        adsCost: 0,
        refunds: 0,
        orders: 0,
        units: 0,
        computedAt: null,
      };
      groups.push(g);
      byKey.set(r.key, g);
    }
    g.refunds += r.amount;
    g.channelFees -= r.recovered;
  }
}

/* ------------------------------ export csv ----------------------------------- */

const PROFIT_CSV_MONEY_COLS = [
  "revenue",
  "channelFees",
  "blankCost",
  "transferCost",
  "labelCost",
  "packagingCost",
  "laborCost",
  "adsCost",
  "refunds",
  "net",
] as const;
const PROFIT_CSV_HEADERS = [
  "key",
  "label",
  "orders",
  "units",
  ...PROFIT_CSV_MONEY_COLS,
  "marginPct",
];

function profitCsvRow(row: {
  key: string;
  label: string;
  orders: number | "";
  units: number | "";
}): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row };
  for (const c of PROFIT_CSV_MONEY_COLS) {
    const cents = (row as unknown as Record<string, number>)[c] ?? 0;
    out[c] = (cents / 100).toFixed(2);
  }
  const margin = (row as unknown as { marginPct: number | null }).marginPct;
  out.marginPct = margin == null ? "" : (margin * 100).toFixed(1);
  return out;
}

/**
 * CSV export of a profit summary: the exact rows `getProfit` would render on screen for the same
 * filters, plus a totals row. `finance.exportCsv` (wave 6 stub 7).
 */
export async function exportProfitCsv(
  tx: Tx,
  ctx: Pick<TenantContext, "companyId">,
  input: ProfitInput,
): Promise<{ key: string }> {
  const summary = await getProfit(tx, ctx, input);
  const rows = [
    ...summary.rows.map(profitCsvRow),
    profitCsvRow({ key: "TOTAL", label: "Total", orders: "", units: "", ...summary.totals }),
  ];
  const csv = toCsv(rows, [...PROFIT_CSV_HEADERS]);
  const key = objectKey(ctx.companyId, "profit-export", "csv");
  await putObject(key, csv, "text/csv");
  return { key };
}

export async function orderProfit(
  tx: Tx,
  ctx: Pick<TenantContext, "companyId">,
  orderId: string,
): Promise<OrderProfit> {
  const [order] = await tx.select().from(orders).where(eq(orders.id, orderId));
  if (!order) throw notFound("order", orderId);
  let lines = await tx.select().from(profitLines).where(eq(profitLines.orderId, orderId));
  if (!lines.length) {
    await recomputeProfit(tx, ctx, { orderIds: [orderId] });
    lines = await tx.select().from(profitLines).where(eq(profitLines.orderId, orderId));
  }
  const itemRows = lines.length
    ? await tx
        .select({
          id: orderItems.id,
          lineNo: orderItems.lineNo,
          unitNo: orderItems.unitNo,
          title: orderItems.title,
          designName: designs.name,
          brand: blankVariants.brand,
          styleCode: blankVariants.styleCode,
          color: blankVariants.color,
          size: blankVariants.size,
          style: blankVariants.style,
          styleName: blankVariants.styleName,
        })
        .from(orderItems)
        .leftJoin(designs, eq(designs.id, orderItems.designId))
        .leftJoin(blankVariants, eq(blankVariants.id, orderItems.blankVariantId))
        .where(
          inArray(
            orderItems.id,
            lines.map((l) => l.orderItemId),
          ),
        )
    : [];
  const items = new Map(itemRows.map((r) => [r.id, r]));
  lines.sort((a, b) => {
    const ia = items.get(a.orderItemId);
    const ib = items.get(b.orderItemId);
    return (ia?.lineNo ?? 0) - (ib?.lineNo ?? 0) || (ia?.unitNo ?? 0) - (ib?.unitNo ?? 0);
  });

  // T-7-2: refunds after shipment (the ledger), on their item's line; order-level ones on totals.
  const refundRows = (await listRefunds(tx, orderId)).items.filter((r) => !r.voidedAt);
  const refundOf = (itemId: string | null) =>
    refundRows
      .filter((r) => r.orderItemId === itemId)
      .reduce((a, r) => ({ amount: a.amount + r.amountCents, fee: a.fee + r.feeRecoveredCents }), {
        amount: 0,
        fee: 0,
      });
  const toBuckets = (l: typeof profitLines.$inferSelect) =>
    finalize({
      revenue: l.revenueCents,
      channelFees: l.channelFeesCents - refundOf(l.orderItemId).fee,
      blankCost: l.blankCostCents,
      transferCost: l.transferCostCents,
      labelCost: l.labelCostCents,
      packagingCost: l.packagingCostCents,
      laborCost: l.laborCostCents,
      adsCost: l.adsCostCents,
      refunds: l.refundsCents + refundOf(l.orderItemId).amount,
    });
  const bucketLines = lines.map(toBuckets);
  const orderLevel = refundOf(null);
  const totals = sumBuckets([
    ...bucketLines,
    { ...emptyBuckets(), refunds: orderLevel.amount, channelFees: -orderLevel.fee },
  ]);

  // Fee breakdown from the same settings the lines used (kept units only).
  const settings = await ensureCostSettings(tx, ctx.companyId);
  const kept = lines.filter((l) => !l.isReprint && l.refundsCents === 0);
  const keptRevenue = kept.reduce((a, l) => a + l.revenueCents, 0);
  const fullRevenue = lines.filter((l) => !l.isReprint).reduce((a, l) => a + l.revenueCents, 0);
  const taxShare = fullRevenue > 0 ? Math.round((order.taxCents * keptRevenue) / fullRevenue) : 0;
  const fees = orderFees(feeTableFor(feeTablesOf(settings), order.channel), {
    revenueCents: keptRevenue,
    buyerTotalCents: keptRevenue + taxShare,
    units: kept.length,
    unitSales: kept.map((l) => ({
      cents: l.revenueCents,
      category: categoryOf(items.get(l.orderItemId)),
    })),
  });
  const recovered = refundRows.reduce((a, r) => a + r.feeRecoveredCents, 0);
  const feeLines = recovered
    ? [...fees.lines, { label: "Fee returned on refunds", amount: -recovered }]
    : fees.lines;

  const estimated = new Set<string>();
  for (const l of lines) for (const e of l.estimated) estimated.add(e);
  return {
    ...totals,
    orderId: order.id,
    orderNo: order.orderNo,
    channel: order.channel,
    placedAt: order.placedAt.toISOString(),
    price: order.subtotalCents,
    shippingCharged: order.shippingCents,
    feeBreakdown: feeLines,
    lines: lines.map((l, idx) => {
      const it = items.get(l.orderItemId);
      return {
        ...(bucketLines[idx] as Buckets),
        orderItemId: l.orderItemId,
        designName: it?.designName ?? it?.title ?? "Unmapped",
        blankLabel: it?.styleCode
          ? `${it.brand} ${it.styleCode} ${it.color} ${it.size}`
          : "No blank mapped",
        printAreaSqIn: l.printAreaSqIn,
        laborMinutes: l.laborMinutes,
        isReprint: l.isReprint,
      };
    }),
    estimated: [...estimated].filter((e): e is OrderProfit["estimated"][number] =>
      ["channelFees", "blankCost", "transferCost", "labelCost", "adsCost"].includes(e),
    ),
  };
}

/* ------------------------------ recompute jobs ------------------------------- */

export const RECOMPUTE_DEFAULT_DAYS = 90;

/** Create the user-visible `jobs` row for a recompute; the caller enqueues after commit. */
export async function createRecomputeJob(
  tx: Tx,
  ctx: Ctx,
  period?: Period,
): Promise<{ jobId: string; from: string; to: string }> {
  const to = period?.to ?? new Date(Date.now() + 86400_000).toISOString();
  const from =
    period?.from ?? new Date(Date.now() - RECOMPUTE_DEFAULT_DAYS * 86400_000).toISOString();
  if (new Date(from) >= new Date(to)) throw badRequest("period.from must be before period.to");
  const [row] = await tx
    .insert(jobs)
    .values({
      companyId: ctx.companyId,
      kind: "profit_recompute",
      status: "queued",
      input: { from, to },
      createdBy: ctx.userId ?? null,
      message: "Queued",
    })
    .returning({ id: jobs.id });
  if (!row) throw new Error("job insert failed");
  return { jobId: row.id, from, to };
}

export async function setJobState(
  tx: Tx,
  companyId: string,
  jobId: string,
  patch: {
    status: "queued" | "running" | "done" | "failed";
    progress?: number;
    message?: string | null;
    error?: string | null;
    resultIds?: string[];
  },
) {
  const done = patch.status === "done" || patch.status === "failed";
  const [row] = await tx
    .update(jobs)
    .set({
      status: patch.status,
      progress: patch.progress ?? (done ? 1 : undefined),
      message: patch.message,
      error: patch.error,
      resultIds: patch.resultIds,
      finishedAt: done ? new Date() : undefined,
      updatedAt: new Date(),
    })
    .where(and(eq(jobs.companyId, companyId), eq(jobs.id, jobId)))
    .returning();
  if (row) {
    afterCommit(tx, () =>
      publish(companyId, "job.progress", {
        jobId: row.id,
        kind: row.kind,
        status: row.status,
        progress: row.progress,
        message: row.message,
        resultIds: row.resultIds,
      }).then(() => undefined),
    );
  }
}
