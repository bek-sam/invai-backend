import {
  type AnalyticsCostLine,
  type BreakEven,
  type BreakEvenInput,
  CHANNEL_RULES,
  type Channel,
  type ContributionLadder,
  type Leakage,
  type LeakageInput,
  type LosingOrders,
  type LosingOrdersInput,
  type ProfitBridge,
  type ProfitBridgeInput,
  type ProfitBridgeMover,
  type ShippingMargin,
  type ShippingMarginInput,
  type ShippingMarginRow,
  type UnitEconomics,
  type UnitEconomicsInput,
  type UnitEconomicsRow,
} from "@invai/contracts";
import { ORPCError } from "@orpc/server";
import { type SQL, sql } from "drizzle-orm";
import type { TenantContext } from "../../api/context";
import type { Tx } from "../../db/client";
import { finalize } from "../finance/profit";
import { getCostSettings } from "../finance/service";
import { computeNet, countOrdersWithoutProfitLine, type NetGroup, type NetPeriod } from "./shared";

/*
 * Finance analytics (T-A3, spec `specs/business-analytics-v2.md` Track A). Read-only views over
 * the shop's own profit lines, refunds, orders and labels. Every function runs inside the
 * caller's `withTenant` and also filters `company_id` explicitly. Each implements one definition
 * in `invai-docs/metrics/definitions/` and matches its SQL in `invai-docs/metrics/sql/` (the
 * `finance-parity.test.ts` runs both on the same data):
 * - unitEconomics → contribution_margin (via `computeNet`, so CM3 = the Profit page's Net);
 * - losingOrders → losing_order_rate; leakage → revenue_leakage; shippingMargin →
 *   shipping_margin; profitBridge → profit_bridge; breakEven → break_even.
 * Business outcomes ("not enough orders", "no fixed costs set") are values, never errors.
 */

type Ctx = Pick<TenantContext, "companyId">;
type Row = Record<string, unknown>;

const MAX_PERIOD_DAYS = 400;
const DAY_MS = 86_400_000;

/** The contract's only domain error: a period that ends before it starts or is too long. */
export function assertPeriod(p: NetPeriod): void {
  const from = Date.parse(p.from);
  const to = Date.parse(p.to);
  if (!(to > from) || to - from > MAX_PERIOD_DAYS * DAY_MS)
    throw new ORPCError("PERIOD_INVALID", {
      status: 400,
      message: "The period must end after it starts and cover at most 400 days",
    });
}

/** Postgres `round()` on numeric: half away from zero (JS Math.round goes half up). */
export function pgRound(x: number): number {
  return Math.sign(x) * Math.round(Math.abs(x));
}

const n = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const pct1 = (num: number, den: number): number => pgRound((1000 * num) / den) / 10;
const channelLabel = (c: string) => CHANNEL_RULES[c as Channel]?.label ?? c;
const bounds = (p: NetPeriod) => ({ from: p.from, to: p.to });
const ms = (iso: string) => Date.parse(iso);

async function rows(tx: Tx, q: SQL): Promise<Row[]> {
  return (await tx.execute<Row>(q)).rows;
}

// ---------------------------------------------------------------------------------------------
// unitEconomics (contribution_margin.md)

const MIN_UNITS_FOR_PCT = 30;

function ladder(
  g: Omit<NetGroup, "key" | "label" | "computedAt">,
  orders: number,
): ContributionLadder {
  const b = finalize(g);
  const cm1 = b.revenue - b.channelFees - b.blankCost - b.transferCost;
  const cm2 = cm1 - b.labelCost - b.packagingCost - b.laborCost - b.refunds;
  const cm3 = b.net;
  const pct = (cm: number) =>
    b.revenue > 0 && g.units >= MIN_UNITS_FOR_PCT ? pct1(cm, b.revenue) : null;
  return {
    revenue: b.revenue,
    cm1,
    cm2,
    cm3,
    cm1Pct: pct(cm1),
    cm2Pct: pct(cm2),
    cm3Pct: pct(cm3),
    orders,
    units: g.units,
    estimatedShare: g.units > 0 ? Math.min(1, g.estimatedUnits / g.units) : 0,
  };
}

export async function unitEconomics(
  tx: Tx,
  ctx: Ctx,
  input: UnitEconomicsInput,
): Promise<UnitEconomics> {
  assertPeriod(input.period);
  const net = await computeNet(tx, ctx, input.period, {
    dimension: input.dimension,
    channel: input.channel,
  });
  const unmapped = input.dimension === "design" ? "Unmapped design" : "Unmapped blank";
  const out: UnitEconomicsRow[] = net.groups.map((g) => ({
    key: g.key,
    label:
      input.dimension === "channel"
        ? channelLabel(g.key)
        : g.key === "unmapped"
          ? unmapped
          : (g.label ?? g.key),
    ...ladder(g, g.orders),
  }));
  out.sort((a, b) => b.cm3 - a.cm3 || a.key.localeCompare(b.key));
  return {
    period: input.period,
    dimension: input.dimension,
    rows: out.slice(0, input.limit ?? 200),
    totals: ladder(
      { ...net.totals, units: net.units, orders: net.orders, estimatedUnits: net.estimatedUnits },
      net.orders,
    ),
    ordersWithoutProfitLine: net.ordersWithoutProfitLine,
    computedAt: (net.computedAt ?? new Date()).toISOString(),
  };
}

// ---------------------------------------------------------------------------------------------
// losingOrders (losing_order_rate.md, sql/losing_orders.sql)

const MIN_ORDERS_FOR_LOSING_PCT = 30;

/**
 * Per order placed in the window: its lines' CM2 (net + ads) less every non-voided refund event
 * of that order, whatever its date (an order view, not a period P&L). Reprint lines included.
 */
function losingCte(ctx: Ctx, input: LosingOrdersInput): SQL {
  const w = bounds(input.period);
  return sql`
    o as (
      select pl.order_id, min(pl.channel) as channel,
        sum(pl.revenue_cents) as revenue,
        sum(pl.channel_fees_cents) as fees, sum(pl.blank_cost_cents) as blank,
        sum(pl.transfer_cost_cents) as transfer, sum(pl.label_cost_cents) as label,
        sum(pl.packaging_cost_cents) as packaging, sum(pl.labor_cost_cents) as labor,
        sum(pl.refunds_cents) as line_refunds,
        sum(pl.net_cents + pl.ads_cost_cents) as cm2_lines,
        count(*) filter (where not pl.is_reprint) as units,
        bool_or(cardinality(pl.estimated) > 0) as estimated
      from profit_lines pl
      where pl.company_id = ${ctx.companyId}
        and pl.placed_at >= ${w.from}::timestamptz and pl.placed_at < ${w.to}::timestamptz
        ${input.channel ? sql`and pl.channel = ${input.channel}` : sql``}
      group by pl.order_id),
    r as (
      select order_id, sum(amount_cents) as amount, sum(fee_recovered_cents) as recovered
      from refund_events
      where company_id = ${ctx.companyId} and voided_at is null
        and order_id in (select order_id from o)
      group by 1),
    x as (
      select o.*, coalesce(r.amount, 0) as refund_amount, coalesce(r.recovered, 0) as recovered,
        o.cm2_lines - coalesce(r.amount, 0) + coalesce(r.recovered, 0) as cm2
      from o left join r on r.order_id = o.order_id)`;
}

const COST_LINE_COLUMNS: [AnalyticsCostLine, (r: Row) => number][] = [
  ["channelFees", (r) => n(r.fees) - n(r.recovered)],
  ["blankCost", (r) => n(r.blank)],
  ["transferCost", (r) => n(r.transfer)],
  ["labelCost", (r) => n(r.label)],
  ["packagingCost", (r) => n(r.packaging)],
  ["laborCost", (r) => n(r.labor)],
  ["refunds", (r) => n(r.line_refunds) + n(r.refund_amount)],
];

export async function losingOrders(
  tx: Tx,
  ctx: Ctx,
  input: LosingOrdersInput,
): Promise<LosingOrders> {
  assertPeriod(input.period);
  const cte = losingCte(ctx, input);
  const [agg] = await rows(
    tx,
    sql`with ${cte}
      select count(*)::int as orders,
        (count(*) filter (where cm2 < 0))::int as losing,
        coalesce(sum(cm2) filter (where cm2 < 0), 0)::bigint as loss
      from x`,
  );
  const worst = await rows(
    tx,
    sql`with ${cte}
      select x.*, ord.order_no, ord.placed_at,
        d.id as design_id, d.name as design_name
      from x
      join orders ord on ord.id = x.order_id and ord.company_id = ${ctx.companyId}
      left join lateral (
        select p2.design_id from profit_lines p2
        where p2.company_id = ${ctx.companyId} and p2.order_id = x.order_id
          and not p2.is_reprint and p2.design_id is not null
        group by p2.design_id order by count(*) desc, p2.design_id limit 1) top on true
      left join designs d on d.id = top.design_id
      where x.cm2 < 0
      order by x.cm2 asc, ord.order_no asc
      limit ${input.limit ?? 20}`,
  );
  const withLine = n(agg?.orders);
  const losing = n(agg?.losing);
  return {
    period: input.period,
    orders: worst.map((r) => {
      const [line, cents] = COST_LINE_COLUMNS.map(([k, f]) => [k, f(r)] as const).reduce((a, b) =>
        b[1] > a[1] ? b : a,
      );
      return {
        orderId: String(r.order_id),
        orderNo: String(r.order_no),
        channel: r.channel as Channel,
        placedAt: new Date(r.placed_at as string).toISOString(),
        designId: r.design_id ? String(r.design_id) : null,
        designName: r.design_name ? String(r.design_name) : null,
        units: n(r.units),
        revenue: n(r.revenue),
        cm2: n(r.cm2),
        largestCostLine: line,
        largestCostLineCents: cents,
        estimated: Boolean(r.estimated),
      };
    }),
    losingOrders: losing,
    ordersWithProfitLine: withLine,
    losingPct: withLine >= MIN_ORDERS_FOR_LOSING_PCT ? pct1(losing, withLine) : null,
    lossCents: n(agg?.loss),
    ordersWithoutProfitLine: await countOrdersWithoutProfitLine(
      tx,
      ctx,
      input.period,
      input.channel,
    ),
  };
}

// ---------------------------------------------------------------------------------------------
// leakage (revenue_leakage.md, sql/revenue_leakage.sql)

const MIN_ORDERS_FOR_LEAKAGE_PCT = 30;

export async function leakage(tx: Tx, ctx: Ctx, input: LeakageInput): Promise<Leakage> {
  assertPeriod(input.period);
  const w = bounds(input.period);
  const c = input.channel;
  const [r] = await rows(
    tx,
    sql`
    with ord as (
      select
        (count(*) filter (where has_pl))::int as orders,
        (count(*) filter (where not has_pl))::int as without_pl,
        coalesce(sum(subtotal_cents + shipping_cents) filter (where has_pl), 0)::bigint as gross,
        coalesce(sum(discount_cents) filter (where has_pl), 0)::bigint as discounts
      from (
        select o.*, exists (select 1 from profit_lines p where p.order_id = o.id) as has_pl
        from orders o
        where o.company_id = ${ctx.companyId} and o.status <> 'cancelled'
          and o.placed_at >= ${w.from}::timestamptz and o.placed_at < ${w.to}::timestamptz
          ${c ? sql`and o.channel = ${c}` : sql``}) o),
    fee as (
      select coalesce(sum(pl.channel_fees_cents), 0)::bigint as fees
      from profit_lines pl
      where pl.company_id = ${ctx.companyId}
        and pl.placed_at >= ${w.from}::timestamptz and pl.placed_at < ${w.to}::timestamptz
        ${c ? sql`and pl.channel = ${c}` : sql``}),
    ref as (
      select coalesce(sum(amount_cents), 0)::bigint as refunds,
        coalesce(sum(fee_recovered_cents), 0)::bigint as recovered
      from refund_events
      where company_id = ${ctx.companyId} and voided_at is null
        and refunded_at >= ${w.from}::timestamptz and refunded_at < ${w.to}::timestamptz
        ${c ? sql`and channel = ${c}` : sql``}),
    shp as (
      select coalesce(sum(greatest(x.label - o.shipping_cents, 0)), 0)::bigint as ship_loss
      from (select order_id, sum(postage_cents + label_fee_cents) as label
            from shipments
            where company_id = ${ctx.companyId} and voided_at is null and labeled_at is not null
            group by 1) x
      join orders o on o.id = x.order_id and o.company_id = ${ctx.companyId}
        and o.placed_at >= ${w.from}::timestamptz and o.placed_at < ${w.to}::timestamptz
        ${c ? sql`and o.channel = ${c}` : sql``}),
    rp as (
      select coalesce(sum(case when rp.blank_consumed then coalesce(pl.blank_cost_cents, 0) else 0 end
          + coalesce(pl.transfer_cost_cents, 0) / (1 + (select count(*) from reprints r2
              where r2.company_id = ${ctx.companyId} and r2.order_item_id = rp.order_item_id
                and r2.status <> 'cancelled'))), 0)::bigint as reprint_cost
      from reprints rp
      join order_items oi on oi.id = rp.order_item_id
      join orders o on o.id = oi.order_id
      left join profit_lines pl on pl.order_item_id = rp.order_item_id
      where rp.company_id = ${ctx.companyId} and rp.status <> 'cancelled'
        and rp.requested_at >= ${w.from}::timestamptz and rp.requested_at < ${w.to}::timestamptz
        ${c ? sql`and o.channel = ${c}` : sql``})
    select * from ord, fee, ref, shp, rp`,
  );
  const gross = n(r?.gross);
  const orders = n(r?.orders);
  const parts: [Leakage["waterfall"][number]["component"], number][] = [
    ["discounts", n(r?.discounts)],
    ["fees", n(r?.fees) - n(r?.recovered)],
    ["refunds", n(r?.refunds)],
    ["shippingLoss", n(r?.ship_loss)],
    ["reprints", n(r?.reprint_cost)],
  ];
  const leaked = parts.reduce((s, [, v]) => s + v, 0);
  return {
    period: input.period,
    grossSales: gross,
    waterfall: parts.map(([component, cents]) => ({
      component,
      cents,
      pctOfGross: gross !== 0 ? pct1(cents, gross) : null,
    })),
    remaining: gross - leaked,
    leakagePct: gross !== 0 && orders >= MIN_ORDERS_FOR_LEAKAGE_PCT ? pct1(leaked, gross) : null,
    orders,
    ordersWithoutProfitLine: n(r?.without_pl),
  };
}

// ---------------------------------------------------------------------------------------------
// shippingMargin (shipping_margin.md, sql/shipping_margin.sql)

/** USPS Ground Advantage price breaks (4 oz steps to 1 lb, then pounds). Keys sort in order. */
const WEIGHT_BANDS: [number, string][] = [
  [4, "0-4oz"],
  [8, "4-8oz"],
  [12, "8-12oz"],
  [16, "12-16oz"],
  [32, "1-2lb"],
  [80, "2-5lb"],
  [Number.POSITIVE_INFINITY, "5lb+"],
];

export function weightBand(oz: number): string {
  return (WEIGHT_BANDS.find(([max]) => oz <= max) ??
    WEIGHT_BANDS[WEIGHT_BANDS.length - 1])?.[1] as string;
}

type ShipOrder = {
  channel: string;
  service: string;
  weight: number;
  charged: number;
  label: number;
  /** `shipments.dest_zone` (1-9), or null when not set (labeled before T-A4, or zone lookup missed). */
  zone: number | null;
};

function shipTotals(list: ShipOrder[]) {
  const charged = list.reduce((s, o) => s + o.charged, 0);
  const labelCost = list.reduce((s, o) => s + o.label, 0);
  const margin = charged - labelCost;
  return {
    labeledOrders: list.length,
    charged,
    labelCost,
    margin,
    marginPerOrder: list.length ? pgRound(margin / list.length) : null,
    freeShippingOrders: list.filter((o) => o.charged === 0).length,
  };
}

export async function shippingMargin(
  tx: Tx,
  ctx: Ctx,
  input: ShippingMarginInput,
): Promise<ShippingMargin> {
  assertPeriod(input.period);
  const w = bounds(input.period);
  const c = input.channel;
  // One row per labeled order: non-voided InvAI labels bought in the window (by labeled_at).
  const list: ShipOrder[] = (
    await rows(
      tx,
      sql`
      with lab as (
        select sh.order_id, sum(sh.postage_cents + sh.label_fee_cents) as label_cents,
          min(sh.carrier || '/' || coalesce(sh.service, '')) as service,
          sum(sh.weight_oz) as weight_oz, count(*) as shipments,
          max(sh.dest_zone) as dest_zone
        from shipments sh
        where sh.company_id = ${ctx.companyId} and sh.voided_at is null
          and sh.labeled_at >= ${w.from}::timestamptz and sh.labeled_at < ${w.to}::timestamptz
        group by 1)
      select o.channel, lab.service, lab.weight_oz, lab.label_cents, o.shipping_cents,
        lab.dest_zone
      from lab join orders o on o.id = lab.order_id and o.company_id = ${ctx.companyId}
      ${c ? sql`where o.channel = ${c}` : sql``}`,
    )
  ).map((r) => ({
    channel: String(r.channel),
    service: String(r.service ?? ""),
    weight: n(r.weight_oz),
    charged: n(r.shipping_cents),
    label: n(r.label_cents),
    zone: r.dest_zone == null ? null : n(r.dest_zone),
  }));

  // `zone` rows come only from labeled shipments with `shipments.dest_zone` set (T-A4 fills it at
  // label time). A labeled order whose shipment(s) carry no zone (labeled before T-A4, or the zone
  // lookup missed) is counted in `shipmentsWithoutZone` and left out of `rows`, per the contract
  // (`ShippingMargin.shipmentsWithoutZone`) -- never turned into a made-up row.
  let shipmentsWithoutZone = 0;
  const groups = new Map<string, ShipOrder[]>();
  if (input.groupBy === "zone") {
    for (const o of list) {
      if (o.zone == null) {
        shipmentsWithoutZone++;
        continue;
      }
      const key = String(o.zone);
      groups.set(key, [...(groups.get(key) ?? []), o]);
    }
  } else {
    for (const o of list) {
      const key =
        input.groupBy === "channel"
          ? o.channel
          : input.groupBy === "service"
            ? o.service
            : weightBand(o.weight);
      groups.set(key, [...(groups.get(key) ?? []), o]);
    }
  }
  const label = (key: string) =>
    input.groupBy === "channel"
      ? channelLabel(key)
      : input.groupBy === "service"
        ? key.replace("/", " ").trim()
        : key;
  const bandOrder = (k: string) => WEIGHT_BANDS.findIndex(([, b]) => b === k);
  const out: ShippingMarginRow[] = [...groups.entries()].map(([key, l]) => ({
    key,
    label: label(key),
    ...shipTotals(l),
  }));
  out.sort((a, b) =>
    input.groupBy === "weightBand"
      ? bandOrder(a.key) - bandOrder(b.key)
      : input.groupBy === "zone"
        ? Number(a.key) - Number(b.key)
        : a.margin - b.margin,
  );
  return {
    period: input.period,
    groupBy: input.groupBy,
    rows: out,
    totals: shipTotals(list),
    shipmentsWithoutZone,
  };
}

// ---------------------------------------------------------------------------------------------
// profitBridge (profit_bridge.md, sql/profit_bridge.sql)

const MIN_ORDERS_FOR_BRIDGE = 20;
const BUCKET_COLUMNS: [string, string, number][] = [
  // [mover key, profit_lines column, sign in CM3]
  ["revenue", "revenue_cents", 1],
  ["channelFees", "channel_fees_cents", -1],
  ["blankCost", "blank_cost_cents", -1],
  ["transferCost", "transfer_cost_cents", -1],
  ["labelCost", "label_cost_cents", -1],
  ["packagingCost", "packaging_cost_cents", -1],
  ["laborCost", "labor_cost_cents", -1],
  ["adsCost", "ads_cost_cents", -1],
  ["refunds", "refunds_cents", -1],
];
const COST_LINE_LABELS: Record<string, string> = {
  revenue: "Sales",
  channelFees: "Channel fees",
  blankCost: "Blanks",
  transferCost: "Transfers",
  labelCost: "Labels",
  packagingCost: "Packaging",
  laborCost: "Labor",
  adsCost: "Ads",
  refunds: "Refunds",
};

/** volume = (u1 − u0) × cm0/u0; a key with no units in one period puts all change in volume. */
export function bridgeSplit(u0: number, u1: number, cm0: number, cm1: number) {
  const change = cm1 - cm0;
  if (u0 === 0 || u1 === 0) return { change, volumePart: change, ratePart: 0 };
  const volumePart = pgRound(((u1 - u0) * cm0) / u0);
  return { change, volumePart, ratePart: change - volumePart };
}

export async function profitBridge(
  tx: Tx,
  ctx: Ctx,
  input: ProfitBridgeInput,
): Promise<ProfitBridge> {
  assertPeriod(input.period);
  const cur = bounds(input.period);
  const len = ms(cur.to) - ms(cur.from);
  const basePeriod = input.basePeriod ?? {
    from: new Date(ms(cur.from) - len).toISOString(),
    to: input.period.from,
  };
  assertPeriod(basePeriod);
  const base = bounds(basePeriod);
  const by = input.by ?? "design";
  const c = input.channel;
  const inBase = sql`pl.placed_at >= ${base.from}::timestamptz and pl.placed_at < ${base.to}::timestamptz`;
  const inCur = sql`pl.placed_at >= ${cur.from}::timestamptz and pl.placed_at < ${cur.to}::timestamptz`;
  const scope = sql`pl.company_id = ${ctx.companyId} and ((${inBase}) or (${inCur}))
    ${c ? sql`and pl.channel = ${c}` : sql``}`;

  const [counts] = await rows(
    tx,
    sql`select (count(distinct pl.order_id) filter (where ${inBase}))::int as base_orders,
        (count(distinct pl.order_id) filter (where ${inCur}))::int as cur_orders
      from profit_lines pl where ${scope}`,
  );

  let movers: ProfitBridgeMover[];
  let totals: { baseCm3: number; currentCm3: number; volumePart: number; ratePart: number };
  if (by === "costLine") {
    // Whole-shop units; the change splits by bucket with the same per-unit deltas.
    const sel = BUCKET_COLUMNS.map(
      ([k, col]) =>
        sql`coalesce(sum(pl.${sql.raw(col)}) filter (where ${inBase}), 0)::bigint as ${sql.raw(`"b_${k}"`)},
        coalesce(sum(pl.${sql.raw(col)}) filter (where ${inCur}), 0)::bigint as ${sql.raw(`"c_${k}"`)}`,
    );
    const [r] = await rows(
      tx,
      sql`select (count(*) filter (where ${inBase} and not pl.is_reprint))::int as u0,
          (count(*) filter (where ${inCur} and not pl.is_reprint))::int as u1,
          coalesce(sum(pl.net_cents) filter (where ${inBase}), 0)::bigint as cm0,
          coalesce(sum(pl.net_cents) filter (where ${inCur}), 0)::bigint as cm1,
          ${sql.join(sel, sql`, `)}
        from profit_lines pl where ${scope}`,
    );
    const u0 = n(r?.u0);
    const u1 = n(r?.u1);
    const whole = bridgeSplit(u0, u1, n(r?.cm0), n(r?.cm1));
    totals = {
      baseCm3: n(r?.cm0),
      currentCm3: n(r?.cm1),
      volumePart: whole.volumePart,
      ratePart: whole.ratePart,
    };
    movers = BUCKET_COLUMNS.map(([k, , sign]) => {
      const cm0 = sign * n(r?.[`b_${k}`]);
      const cm1 = sign * n(r?.[`c_${k}`]);
      return {
        key: k,
        label: COST_LINE_LABELS[k] ?? k,
        baseCm3: cm0,
        currentCm3: cm1,
        ...bridgeSplit(u0, u1, cm0, cm1),
        baseUnits: u0,
        currentUnits: u1,
      };
    });
  } else {
    const key =
      by === "design" ? sql`coalesce(pl.design_id::text, 'unmapped')` : sql`pl.channel::text`;
    const list = await rows(
      tx,
      sql`select ${key} as key,
          (count(*) filter (where ${inBase} and not pl.is_reprint))::int as u0,
          coalesce(sum(pl.net_cents) filter (where ${inBase}), 0)::bigint as cm0,
          (count(*) filter (where ${inCur} and not pl.is_reprint))::int as u1,
          coalesce(sum(pl.net_cents) filter (where ${inCur}), 0)::bigint as cm1,
          max(d.name) as name
        from profit_lines pl
        left join designs d on d.id = pl.design_id
        where ${scope}
        group by 1`,
    );
    movers = list.map((r) => {
      const k = String(r.key);
      const [u0, u1, cm0, cm1] = [n(r.u0), n(r.u1), n(r.cm0), n(r.cm1)];
      return {
        key: k,
        label:
          by === "channel"
            ? channelLabel(k)
            : k === "unmapped"
              ? "Unmapped design"
              : String(r.name ?? k),
        baseCm3: cm0,
        currentCm3: cm1,
        ...bridgeSplit(u0, u1, cm0, cm1),
        baseUnits: u0,
        currentUnits: u1,
      };
    });
    totals = movers.reduce(
      (t, m) => ({
        baseCm3: t.baseCm3 + m.baseCm3,
        currentCm3: t.currentCm3 + m.currentCm3,
        volumePart: t.volumePart + m.volumePart,
        ratePart: t.ratePart + m.ratePart,
      }),
      { baseCm3: 0, currentCm3: 0, volumePart: 0, ratePart: 0 },
    );
  }

  // Dated refund events sit outside the per-row bridge: their change in effect on profit, so
  // totalChange + refundsChange = the change in the Profit page's Net.
  const [ref] = await rows(
    tx,
    sql`select
        coalesce(sum(amount_cents - fee_recovered_cents) filter (where refunded_at >= ${base.from}::timestamptz and refunded_at < ${base.to}::timestamptz), 0)::bigint as base_net,
        coalesce(sum(amount_cents - fee_recovered_cents) filter (where refunded_at >= ${cur.from}::timestamptz and refunded_at < ${cur.to}::timestamptz), 0)::bigint as cur_net
      from refund_events
      where company_id = ${ctx.companyId} and voided_at is null
        ${c ? sql`and channel = ${c}` : sql``}`,
  );

  movers.sort((a, b) => Math.abs(b.change) - Math.abs(a.change) || a.key.localeCompare(b.key));
  const baseOrders = n(counts?.base_orders);
  const currentOrders = n(counts?.cur_orders);
  return {
    period: input.period,
    basePeriod,
    by,
    baseCm3: totals.baseCm3,
    currentCm3: totals.currentCm3,
    totalChange: totals.volumePart + totals.ratePart,
    volumePart: totals.volumePart,
    ratePart: totals.ratePart,
    refundsChange: -(n(ref?.cur_net) - n(ref?.base_net)),
    topMovers: movers.slice(0, 10),
    baseOrders,
    currentOrders,
    hasEnoughOrders: baseOrders >= MIN_ORDERS_FOR_BRIDGE && currentOrders >= MIN_ORDERS_FOR_BRIDGE,
  };
}

// ---------------------------------------------------------------------------------------------
// breakEven (break_even.md, sql/break_even.sql)

const MIN_ORDERS_FOR_BREAK_EVEN = 30;

export async function breakEven(tx: Tx, ctx: Ctx, input: BreakEvenInput): Promise<BreakEven> {
  assertPeriod(input.period);
  const settings = await getCostSettings(tx, ctx);
  const fixed = settings.fixedMonthlyCents ?? null;
  // CM3 is the Profit page's Net for the window (the shared calculation), not a second formula.
  const net = await computeNet(tx, ctx, input.period, { dimension: "channel" });
  const orders = net.orders;
  const cm3 = net.totals.net;
  const w = bounds(input.period);
  const days = Math.max(1, Math.round((ms(w.to) - ms(w.from)) / DAY_MS));
  const hasEnoughOrders = orders >= MIN_ORDERS_FOR_BREAK_EVEN;
  const ready = fixed !== null && hasEnoughOrders;
  const perOrder = orders > 0 ? cm3 / orders : null;
  return {
    period: input.period,
    fixedCostsSet: fixed !== null,
    fixedMonthlyCents: fixed,
    orders,
    cm3,
    cm3PerOrder: perOrder === null ? null : pgRound(perOrder),
    // Break-even needs a positive profit per order; at or below 0 no order count covers costs.
    breakEvenOrders:
      ready && perOrder !== null && perOrder > 0 ? Math.ceil((fixed as number) / perOrder) : null,
    pace: ready ? pgRound((orders * 30) / days) : null,
    operatingProfitPace: ready ? pgRound((cm3 * 30) / days) - (fixed as number) : null,
    hasEnoughOrders,
  };
}
