import type {
  DeadStock,
  DeadStockRow,
  InventoryHealth,
  InventoryHealthInput,
  SizeMixGapGroup,
  SizeMixSizeRow,
  StockoutExposure,
  StockoutExposureRow,
  Supplier,
  SupplierTrendRow,
  SupplierTrends,
  SupplierTrendsInput,
} from "@invai/contracts";
import { eq, type SQL, sql } from "drizzle-orm";
import type { TenantContext } from "../../api/context";
import type { Tx } from "../../db/client";
import { companies } from "../../db/schema";
import { loadSettings } from "../inventory/service";
import { assertPeriod } from "./finance-service";

/*
 * `analytics.inventoryHealth` and `analytics.supplierTrends` (T-A5, spec Track C). Read-only
 * numbers about blank stock and supplier POs: on-hand value, turns, dead stock, size-mix gaps,
 * stockout exposure (`invai-docs/metrics/definitions/blank_stock_health.md`, `size_mix_gap.md`,
 * `stockout_exposure.md`), and supplier unit cost / lead time
 * (`invai-docs/metrics/definitions/supplier_trends.md`). Each block's SQL matches the metric's
 * `metrics/sql/*.sql` file (checked by `inventory-service.test.ts`'s parity block) so the
 * numbers on screen match the data-analyst's own query. Runs inside the caller's `withTenant`;
 * every query also filters `company_id` explicitly. No buyer PII is read.
 */

type Ctx = Pick<TenantContext, "companyId">;
type Row = Record<string, unknown>;

/** Minimum samples (metric definitions). */
const MIN = {
  /** size_mix_gap.md: units sold per style x color. */
  sizeMixUnits: 30,
  /** supplier_trends.md: received POs per supplier x style x month, and overall. */
  receivedPOs: 3,
} as const;

/** supplierTrends: measured lead time vs the setting, suggest an update past this gap. */
const LEAD_TIME_GAP_DAYS = 3;

const SUPPLIER_LABELS: Record<Supplier, string> = {
  ssactivewear: "S&S Activewear",
  sanmar: "SanMar",
  other: "Other",
};

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

async function rows(tx: Tx, q: SQL): Promise<Row[]> {
  return (await tx.execute<Row>(q)).rows;
}

async function companyInfo(
  tx: Tx,
  companyId: string,
): Promise<{ createdAt: Date; timezone: string }> {
  const [row] = await tx
    .select({ createdAt: companies.createdAt, timezone: companies.timezone })
    .from(companies)
    .where(eq(companies.id, companyId));
  return { createdAt: row?.createdAt ?? new Date(), timezone: row?.timezone ?? "America/Phoenix" };
}

/* --------------------------------- blank stock health ---------------------------------- */

/** blank_stock_health.sql, one company: consumed cost, on-hand value and turns in the window. */
async function stockHealth(
  tx: Tx,
  ctx: Ctx,
  windowStart: Date,
): Promise<{
  onHandUnits: number;
  onHandValue: number;
  consumedCost: number;
  deadStock: DeadStock;
}> {
  const list = await rows(
    tx,
    sql`with cons as (
          select blank_variant_id, (-sum(qty))::int as used
          from inventory_movements
          where company_id = ${ctx.companyId} and kind = 'consume' and created_at >= ${windowStart}
          group by 1),
        stock as (
          select blank_variant_id, sum(on_hand)::int as on_hand
          from stock_levels where company_id = ${ctx.companyId} group by 1)
        select st.blank_variant_id, bv.brand, bv.style_code, bv.style_name, bv.color, bv.size,
          bv.cost_cents, st.on_hand, c.used
        from stock st
        join blank_variants bv on bv.company_id = ${ctx.companyId} and bv.id = st.blank_variant_id
        left join cons c on c.blank_variant_id = st.blank_variant_id`,
  );
  let onHandUnits = 0;
  let onHandValue = 0;
  let consumedCost = 0;
  const deadRows: DeadStockRow[] = [];
  for (const r of list) {
    const onHand = num(r.on_hand);
    const cost = num(r.cost_cents);
    onHandUnits += onHand;
    onHandValue += onHand * cost;
    if (r.used !== null && r.used !== undefined) consumedCost += num(r.used) * cost;
    if (onHand > 0 && (r.used === null || r.used === undefined)) {
      deadRows.push({
        blankVariantId: String(r.blank_variant_id),
        label: [r.brand, r.style_code, r.style_name, r.color, r.size].filter(Boolean).join(" "),
        onHand,
        value: onHand * cost,
        lastConsumedAt: null,
      });
    }
  }
  // Last consumption ever (not limited to the window) for the dead-stock variants shown.
  if (deadRows.length) {
    const ids = deadRows.map((r) => r.blankVariantId);
    const last = await rows(
      tx,
      sql`select blank_variant_id, max(created_at) as last_at
          from inventory_movements
          where company_id = ${ctx.companyId} and kind = 'consume'
            and blank_variant_id in (${sql.join(
              ids.map((id) => sql`${id}`),
              sql`, `,
            )})
          group by 1`,
    );
    const lastBy = new Map(last.map((r) => [String(r.blank_variant_id), r.last_at]));
    for (const r of deadRows) {
      const at = lastBy.get(r.blankVariantId);
      r.lastConsumedAt = at ? new Date(String(at)).toISOString() : null;
    }
  }
  deadRows.sort((a, b) => b.value - a.value || a.blankVariantId.localeCompare(b.blankVariantId));
  const top = deadRows.slice(0, 50);
  const deadValue = deadRows.reduce((s, r) => s + r.value, 0);
  return {
    onHandUnits,
    onHandValue,
    consumedCost,
    deadStock: {
      variants: deadRows.length,
      value: deadValue,
      pctOfStockValue: onHandValue > 0 ? Math.round((1000 * deadValue) / onHandValue) / 10 : null,
      rows: top,
    },
  };
}

/* ----------------------------------- size mix gap --------------------------------------- */

/** size_mix_gap.sql, one company: sales share vs stock share per style x color x size. */
async function sizeMixGaps(tx: Tx, ctx: Ctx, windowStart: Date): Promise<SizeMixGapGroup[]> {
  const windowDays = Math.max(1, (Date.now() - windowStart.getTime()) / 86_400_000);
  const list = await rows(
    tx,
    sql`with sold as (
          select oi.blank_variant_id, count(*)::int as units
          from order_items oi
          join orders o on o.company_id = ${ctx.companyId} and o.id = oi.order_id
          where oi.company_id = ${ctx.companyId} and not oi.is_reprint and oi.state <> 'cancelled'
            and oi.blank_variant_id is not null and o.placed_at >= ${windowStart}
          group by 1),
        stock as (
          select blank_variant_id, sum(on_hand)::int as on_hand
          from stock_levels where company_id = ${ctx.companyId} group by 1),
        v as (
          select bv.id as blank_variant_id, bv.style_code, bv.color, bv.size,
            coalesce(so.units, 0) as units, coalesce(st.on_hand, 0) as on_hand
          from blank_variants bv
          left join sold so on so.blank_variant_id = bv.id
          left join stock st on st.blank_variant_id = bv.id
          where bv.company_id = ${ctx.companyId}),
        g as (
          select v.*, sum(units) over (partition by style_code, color) as g_units,
            sum(on_hand) over (partition by style_code, color) as g_stock
          from v)
        select style_code, color, blank_variant_id, size, units, on_hand, g_units, g_stock
        from g where g_units > 0 or g_stock > 0
        order by style_code, color, size, blank_variant_id`,
  );
  const groups = new Map<string, SizeMixGapGroup & { gUnits: number; gStock: number }>();
  for (const r of list) {
    const styleCode = String(r.style_code);
    const color = String(r.color);
    const key = `${styleCode}\u0000${color}`;
    const gUnits = num(r.g_units);
    const gStock = num(r.g_stock);
    const hasEnoughUnits = gUnits >= MIN.sizeMixUnits;
    let group = groups.get(key);
    if (!group) {
      group = {
        styleCode,
        color,
        label: `${styleCode} ${color}`,
        unitsSold: gUnits,
        onHand: gStock,
        hasEnoughUnits,
        sizes: [],
        gUnits,
        gStock,
      };
      groups.set(key, group);
    }
    const units = num(r.units);
    const onHand = num(r.on_hand);
    const salesSharePct = gUnits > 0 ? Math.round((1000 * units) / gUnits) / 10 : 0;
    const stockSharePct = gStock > 0 ? Math.round((1000 * onHand) / gStock) / 10 : 0;
    const dailySales = units / windowDays;
    const sizeRow: SizeMixSizeRow = {
      blankVariantId: String(r.blank_variant_id),
      size: String(r.size),
      unitsSold: units,
      onHand,
      salesSharePct,
      stockSharePct,
      gapPts: hasEnoughUnits ? Math.round((stockSharePct - salesSharePct) * 10) / 10 : null,
      coverDays: dailySales > 0 ? Math.round((onHand / dailySales) * 10) / 10 : null,
    };
    group.sizes.push(sizeRow);
  }
  return [...groups.values()]
    .map(({ gUnits: _u, gStock: _s, ...g }) => g)
    .sort((a, b) => a.styleCode.localeCompare(b.styleCode) || a.color.localeCompare(b.color));
}

/* --------------------------------- stockout exposure ------------------------------------ */

/** stockout_exposure.sql, one company: sold units waiting on a blank with no stock, right now. */
async function stockoutExposure(tx: Tx, ctx: Ctx): Promise<StockoutExposure> {
  const list = await rows(
    tx,
    sql`with avail as (
          select blank_variant_id, sum(available)::int as available
          from stock_levels where company_id = ${ctx.companyId} group by 1)
        select oi.id, oi.blank_variant_id, bv.brand, bv.style_code, bv.style_name, bv.color, bv.size,
          oi.unit_price_cents, oi.ship_by
        from order_items oi
        join blank_variants bv on bv.company_id = ${ctx.companyId} and bv.id = oi.blank_variant_id
        where oi.company_id = ${ctx.companyId}
          and oi.state in ('ready', 'needs_artwork', 'on_sheet', 'transfer_in')
          and oi.blank_variant_id in (select blank_variant_id from avail where available <= 0)`,
  );
  const byBlank = new Map<string, StockoutExposureRow>();
  let earliest: Date | null = null;
  for (const r of list) {
    const id = String(r.blank_variant_id);
    const shipBy = r.ship_by ? new Date(String(r.ship_by)) : null;
    const row = byBlank.get(id) ?? {
      blankVariantId: id,
      label: [r.brand, r.style_code, r.style_name, r.color, r.size].filter(Boolean).join(" "),
      units: 0,
      revenueAtRisk: 0,
      earliestShipBy: null,
    };
    row.units += 1;
    row.revenueAtRisk += num(r.unit_price_cents);
    if (shipBy && (!row.earliestShipBy || shipBy < new Date(row.earliestShipBy)))
      row.earliestShipBy = shipBy.toISOString();
    if (shipBy && (!earliest || shipBy < earliest)) earliest = shipBy;
    byBlank.set(id, row);
  }
  const out = [...byBlank.values()].sort(
    (a, b) => b.revenueAtRisk - a.revenueAtRisk || a.blankVariantId.localeCompare(b.blankVariantId),
  );
  return {
    units: out.reduce((s, r) => s + r.units, 0),
    blanks: out.length,
    revenueAtRisk: out.reduce((s, r) => s + r.revenueAtRisk, 0),
    earliestShipBy: earliest ? earliest.toISOString() : null,
    rows: out,
  };
}

/* -------------------------------------- entry -------------------------------------------- */

export async function inventoryHealth(
  tx: Tx,
  ctx: Ctx,
  input: InventoryHealthInput,
): Promise<InventoryHealth> {
  const days = input.days ?? 90;
  const asOf = new Date();
  const windowStart = new Date(asOf.getTime() - days * 86_400_000);
  const company = await companyInfo(tx, ctx.companyId);

  const health = await stockHealth(tx, ctx, windowStart);
  const sizeMix = await sizeMixGaps(tx, ctx, windowStart);
  const stockout = await stockoutExposure(tx, ctx);

  const ageDays = (asOf.getTime() - company.createdAt.getTime()) / 86_400_000;
  const enoughAge = ageDays >= days;
  // AC-B/C-screen1: whole-screen "not enough history" when the shop has neither enough tenure
  // for turns (blank_stock_health.md) nor a single style x color past the size-mix minimum.
  const hasEnoughHistory = enoughAge || sizeMix.some((g) => g.hasEnoughUnits);

  const turns =
    health.onHandValue > 0 && enoughAge
      ? Math.round(((health.consumedCost * 365) / days / health.onHandValue) * 10) / 10
      : null;

  return {
    days,
    asOf: asOf.toISOString(),
    hasEnoughHistory,
    onHandUnits: health.onHandUnits,
    onHandValue: health.onHandValue,
    consumedCost: health.consumedCost,
    turns,
    deadStock: health.deadStock,
    sizeMixGaps: sizeMix,
    stockoutExposure: stockout,
  };
}

export async function supplierTrends(
  tx: Tx,
  ctx: Ctx,
  input: SupplierTrendsInput,
): Promise<SupplierTrends> {
  assertPeriod(input.period);
  const from = new Date(input.period.from);
  const to = new Date(input.period.to);
  const company = await companyInfo(tx, ctx.companyId);
  const settings = await loadSettings(tx, ctx.companyId);

  const list = await rows(
    tx,
    sql`select po.supplier, bv.style_code,
          to_char(po.submitted_at at time zone ${company.timezone}, 'YYYY-MM') as month,
          count(distinct po.id)::int as purchase_orders,
          sum(l.qty)::int as units,
          round(sum(l.qty * l.unit_cost_cents)::numeric / nullif(sum(l.qty), 0), 1) as avg_unit_cost,
          round((percentile_cont(0.5) within group (order by
              extract(epoch from po.received_at - po.submitted_at) / 86400)
            filter (where po.status = 'received'))::numeric, 1) as median_lead_days,
          (count(distinct po.id) filter (where po.status = 'received'))::int as received_pos
        from purchase_orders po
        join purchase_order_lines l on l.company_id = ${ctx.companyId} and l.purchase_order_id = po.id
        join blank_variants bv on bv.company_id = ${ctx.companyId} and bv.id = l.blank_variant_id
        where po.company_id = ${ctx.companyId} and po.status <> 'cancelled'
          and po.submitted_at is not null and po.submitted_at >= ${from} and po.submitted_at < ${to}
        group by 1, 2, 3
        order by 1, 2, 3`,
  );
  const supplierAccounts = await rows(
    tx,
    sql`select supplier, name from suppliers where company_id = ${ctx.companyId}`,
  );
  const nameOf = (s: string) =>
    (supplierAccounts.find((r) => r.supplier === s)?.name as string | undefined) ??
    SUPPLIER_LABELS[s as Supplier] ??
    s;

  const outRows: SupplierTrendRow[] = list.map((r) => ({
    supplier: r.supplier as Supplier,
    supplierName: nameOf(String(r.supplier)),
    styleCode: String(r.style_code),
    month: String(r.month),
    purchaseOrders: num(r.purchase_orders),
    units: num(r.units),
    avgUnitCost: Number(r.avg_unit_cost ?? 0),
    medianLeadDays: num(r.received_pos) >= MIN.receivedPOs ? numOrNull(r.median_lead_days) : null,
  }));

  const [g] = await rows(
    tx,
    sql`select
          round((percentile_cont(0.5) within group (order by
              extract(epoch from received_at - submitted_at) / 86400))::numeric, 1) as median_lead_days,
          count(*)::int as n
        from purchase_orders
        where company_id = ${ctx.companyId} and status = 'received'
          and submitted_at is not null and submitted_at >= ${from} and submitted_at < ${to}`,
  );
  const measuredLeadDays = g && num(g.n) >= MIN.receivedPOs ? numOrNull(g.median_lead_days) : null;
  const leadTimeSettingDays = settings.leadTimeDays;
  const suggestUpdateLeadTime =
    measuredLeadDays !== null &&
    Math.abs(measuredLeadDays - leadTimeSettingDays) > LEAD_TIME_GAP_DAYS;

  return {
    period: { from: from.toISOString(), to: to.toISOString() },
    rows: outRows,
    leadTimeSettingDays,
    measuredLeadDays,
    suggestUpdateLeadTime,
  };
}
