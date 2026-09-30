import {
  CHANNEL_RULES,
  type Channel,
  type LateDriver,
  type LateDriverRow,
  type Operations,
  type OperationsInput,
  type OrderItemState,
  type PressStationRow,
  type REPRINT_REASONS,
  type ReprintCostRow,
  type StageWait,
} from "@invai/contracts";
import { ORPCError } from "@orpc/server";
import { type SQL, sql } from "drizzle-orm";
import type { TenantContext } from "../../api/context";
import type { Tx } from "../../db/client";
import { getCostSettings } from "../finance/service";

/*
 * `analytics.operations` (T-A4, spec Track B). Read-only numbers about the floor and shipping:
 * reprint cost, film waste, how long work waits in each state, measured press time per station
 * and which kinds of orders were more often shipped late. Each block implements a metric in
 * `invai-docs/metrics/definitions/` and follows its SQL (`metrics/sql/*.sql`) so the numbers
 * match; below a metric's minimum sample the number is null and its count stays next to it.
 *
 * Stations only, never a named person. No buyer PII is read. Runs inside the caller's
 * `withTenant`; every query also filters `company_id` explicitly.
 */

type Ctx = Pick<TenantContext, "companyId">;
type Row = Record<string, unknown>;

/** Minimum samples (metric definitions). */
export const MIN = {
  itemsPressed: 30,
  sheets: 10,
  stateEntries: 30,
  timedUnits: 100,
  shippedOrders: 30,
} as const;

/** Measured median vs the labor setting: suggest an update above this relative gap. */
const LABOR_GAP = 0.25;
const MAX_PERIOD_DAYS = 400;

/** Sheets that went to the vendor (sent or later), as `film_waste_cost.sql`. */
const SENT_SHEET_STATES = ["sent", "acknowledged", "printing", "printed", "shipped", "received"];
/** States measured by `stage_wait_hours.sql`, in floor order. */
const WAIT_STATES: OrderItemState[] = [
  "needs_mapping",
  "needs_artwork",
  "ready",
  "on_sheet",
  "transfer_in",
  "pressed",
  "packed",
];
/** The critical path a bottleneck is picked from. */
const CRITICAL_PATH: OrderItemState[] = ["ready", "on_sheet", "transfer_in", "pressed", "packed"];

const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const numOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const inList = (values: readonly string[]) =>
  sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  );

async function rows(tx: Tx, q: SQL): Promise<Row[]> {
  return (await tx.execute<Row>(q)).rows;
}

function periodOf(input: OperationsInput) {
  const from = new Date(input.period.from);
  const to = new Date(input.period.to);
  const days = (to.getTime() - from.getTime()) / 86_400_000;
  if (!(days > 0) || days > MAX_PERIOD_DAYS)
    throw new ORPCError("PERIOD_INVALID", {
      status: 400,
      message: "The period must end after it starts and cover at most 400 days",
    });
  return { from, to };
}

const humanize = (key: string) => {
  const s = key.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
};

/* ------------------------------- reprint cost ------------------------------ */

async function reprintCost(
  tx: Tx,
  ctx: Ctx,
  from: Date,
  to: Date,
  channel: SQL,
): Promise<Operations["reprintCost"]> {
  // reprint_cost.sql: one more transfer (the item's transfer cost split over its prints) plus the
  // blank when it was ruined; same integer arithmetic per reprint.
  const list = await rows(
    tx,
    sql`select rp.reason, rp.station_id, st.name as station_name,
          rp.original_transfer_id is null as no_transfer,
          gs.vendor_connection_id as vendor_id, vc.name as vendor_name,
          (case when rp.blank_consumed then coalesce(pl.blank_cost_cents, 0) else 0 end
            + coalesce(pl.transfer_cost_cents, 0) / (1 + (select count(*) from reprints r2
                where r2.company_id = rp.company_id and r2.order_item_id = rp.order_item_id
                  and r2.status <> 'cancelled')))::int as cost
        from reprints rp
        join order_items oi on oi.company_id = rp.company_id and oi.id = rp.order_item_id
        join orders o on o.company_id = oi.company_id and o.id = oi.order_id
        left join profit_lines pl on pl.company_id = rp.company_id and pl.order_item_id = rp.order_item_id
        left join stations st on st.company_id = rp.company_id and st.id = rp.station_id
        left join transfers t on t.company_id = rp.company_id and t.id = rp.original_transfer_id
        left join gang_sheets gs on gs.company_id = rp.company_id and gs.id = t.gang_sheet_id
        left join vendor_connections vc on vc.company_id = rp.company_id and vc.id = gs.vendor_connection_id
        where rp.company_id = ${ctx.companyId} and rp.status <> 'cancelled'
          and rp.requested_at >= ${from} and rp.requested_at < ${to} ${channel}`,
  );
  const [pressed] = await rows(
    tx,
    sql`select count(distinct tr.order_item_id)::int as n
        from order_item_transitions tr
        join orders o on o.company_id = tr.company_id and o.id = tr.order_id
        where tr.company_id = ${ctx.companyId} and tr.to_state = 'pressed'
          and tr.created_at >= ${from} and tr.created_at < ${to} ${channel}`,
  );
  const itemsPressed = num(pressed?.n);

  const cut = (keyOf: (r: Row) => [string, string]) => {
    const m = new Map<string, ReprintCostRow>();
    for (const r of list) {
      const [key, label] = keyOf(r);
      const acc = m.get(key) ?? { key, label, reprints: 0, cost: 0 };
      acc.reprints += 1;
      acc.cost += num(r.cost);
      m.set(key, acc);
    }
    return [...m.values()].sort(
      (a, b) => b.cost - a.cost || b.reprints - a.reprints || a.key.localeCompare(b.key),
    );
  };
  const reprints = list.length;
  return {
    total: list.reduce((s, r) => s + num(r.cost), 0),
    reprints,
    itemsPressed,
    ratePct:
      itemsPressed >= MIN.itemsPressed ? Math.round((1000 * reprints) / itemsPressed) / 10 : null,
    byReason: cut((r) => [String(r.reason), humanize(String(r.reason))]) as (ReprintCostRow & {
      key: (typeof REPRINT_REASONS)[number];
    })[],
    byStation: cut((r) =>
      r.station_id ? [String(r.station_id), String(r.station_name)] : ["none", "No station"],
    ),
    byVendor: cut((r) => {
      if (r.no_transfer) return ["unknown", "Unknown"];
      return r.vendor_id ? [String(r.vendor_id), String(r.vendor_name)] : ["in_house", "In-house"];
    }),
  };
}

/* -------------------------------- film waste ------------------------------- */

async function filmWaste(tx: Tx, ctx: Ctx, from: Date, to: Date): Promise<Operations["filmWaste"]> {
  // film_waste_cost.sql. Sheets carry no channel, so the channel filter doesn't apply here.
  const agg = sql`count(g.id)::int as sheets,
    round(coalesce(sum(g.cost_cents * (1 - g.utilization)), 0))::int as waste,
    round((100 * sum(g.utilization * g.length_in) / nullif(sum(g.length_in), 0))::numeric, 1) as use_pct`;
  const where = sql`g.company_id = ${ctx.companyId} and g.created_at >= ${from} and g.created_at < ${to}
    and g.status in (${inList(SENT_SHEET_STATES)})`;
  const [total] = await rows(tx, sql`select ${agg} from gang_sheets g where ${where}`);
  const byVendor = await rows(
    tx,
    sql`select g.vendor_connection_id as vendor_id, vc.name as vendor_name, ${agg}
        from gang_sheets g
        left join vendor_connections vc on vc.company_id = g.company_id and vc.id = g.vendor_connection_id
        where ${where}
        group by 1, 2 order by waste desc, coalesce(g.vendor_connection_id::text, '')`,
  );
  const sheets = num(total?.sheets);
  return {
    sheets,
    wasteCost: num(total?.waste),
    filmUsePct: sheets >= MIN.sheets ? numOrNull(total?.use_pct) : null,
    byVendor: byVendor.map((r) => ({
      key: r.vendor_id ? String(r.vendor_id) : "in_house",
      label: r.vendor_id ? String(r.vendor_name) : "In-house",
      sheets: num(r.sheets),
      wasteCost: num(r.waste),
      filmUsePct: num(r.sheets) >= MIN.sheets ? numOrNull(r.use_pct) : null,
    })),
  };
}

/* ---------------------------------- waits ---------------------------------- */

async function waits(
  tx: Tx,
  ctx: Ctx,
  from: Date,
  to: Date,
  channel: SQL,
): Promise<{ waits: StageWait[]; bottleneckStep: OrderItemState | null }> {
  // stage_wait_hours.sql: hours from entering a state to the item's next transition. Items that
  // haven't moved on yet are counted as still waiting and left out of the median (contract).
  const hours = sql`extract(epoch from x.left_at - x.created_at) / 3600`;
  const list = await rows(
    tx,
    sql`with x as (
          select tr.order_id, tr.to_state, tr.created_at,
            lead(tr.created_at) over (partition by tr.order_item_id order by tr.created_at) as left_at
          from order_item_transitions tr
          where tr.company_id = ${ctx.companyId} and tr.order_item_id in (
            select order_item_id from order_item_transitions
            where company_id = ${ctx.companyId} and created_at >= ${from} and created_at < ${to}))
        select x.to_state as state, count(*)::int as entries,
          (count(*) filter (where x.left_at is null))::int as still_waiting,
          round((percentile_cont(0.5) within group (order by ${hours}) filter (where x.left_at is not null))::numeric, 1) as median_h,
          round((percentile_cont(0.9) within group (order by ${hours}) filter (where x.left_at is not null))::numeric, 1) as p90_h
        from x join orders o on o.company_id = ${ctx.companyId} and o.id = x.order_id
        where x.created_at >= ${from} and x.created_at < ${to}
          and x.to_state in (${inList(WAIT_STATES)}) ${channel}
        group by 1`,
  );
  const byState = new Map(list.map((r) => [String(r.state), r]));
  const out: StageWait[] = WAIT_STATES.flatMap((state) => {
    const r = byState.get(state);
    if (!r) return [];
    const enough = num(r.entries) >= MIN.stateEntries;
    return [
      {
        state,
        entries: num(r.entries),
        medianHours: enough ? numOrNull(r.median_h) : null,
        p90Hours: enough ? numOrNull(r.p90_h) : null,
        stillWaiting: num(r.still_waiting),
      },
    ];
  });
  let bottleneckStep: OrderItemState | null = null;
  let worst = -1;
  for (const w of out)
    if (CRITICAL_PATH.includes(w.state) && w.medianHours !== null && w.medianHours > worst) {
      worst = w.medianHours;
      bottleneckStep = w.state;
    }
  return { waits: out, bottleneckStep };
}

/* ------------------------------- press timing ------------------------------ */

async function pressMinutes(
  tx: Tx,
  ctx: Ctx,
  from: Date,
  to: Date,
  channel: SQL,
  settingMinutes: number,
): Promise<PressStationRow[]> {
  // press_minutes_per_unit.sql: the gap between consecutive successful press scans at a station,
  // kept when 0.1-10 minutes. Gaps are taken over all of the station's scans; the channel filter
  // then keeps the units (the later scan of each gap) from that channel.
  const timed = sql`s.gap between 0.1 and 10`;
  const list = await rows(
    tx,
    sql`with s as (
          select sc.station_id, sc.order_item_id,
            extract(epoch from sc.scanned_at - lag(sc.scanned_at)
              over (partition by sc.station_id order by sc.scanned_at)) / 60.0 as gap
          from scans sc
          where sc.company_id = ${ctx.companyId} and sc.action = 'press' and sc.ok
            and sc.station_id is not null and sc.scanned_at >= ${from} and sc.scanned_at < ${to})
        select s.station_id, st.name as station_name,
          (count(*) filter (where ${timed}))::int as timed_units,
          round((percentile_cont(0.5) within group (order by s.gap) filter (where ${timed}))::numeric, 2) as median_min,
          round((percentile_cont(0.75) within group (order by s.gap) filter (where ${timed}))::numeric, 2) as p75_min,
          round((60 * count(*) filter (where ${timed}) / nullif(sum(s.gap) filter (where ${timed}), 0))::numeric, 1) as per_hour
        from s
        join stations st on st.company_id = ${ctx.companyId} and st.id = s.station_id
        left join order_items oi on oi.company_id = ${ctx.companyId} and oi.id = s.order_item_id
        left join orders o on o.company_id = ${ctx.companyId} and o.id = oi.order_id
        where true ${channel}
        group by 1, 2 order by 2, 1`,
  );
  return list.map((r) => {
    const timedUnits = num(r.timed_units);
    const enough = timedUnits >= MIN.timedUnits;
    const median = enough ? numOrNull(r.median_min) : null;
    return {
      stationId: String(r.station_id),
      stationName: String(r.station_name),
      timedUnits,
      medianMinutes: median,
      p75Minutes: enough ? numOrNull(r.p75_min) : null,
      unitsPerActiveHour: enough ? numOrNull(r.per_hour) : null,
      settingMinutes,
      suggestUpdateLaborSetting:
        median !== null &&
        settingMinutes > 0 &&
        Math.abs(median - settingMinutes) / settingMinutes > LABOR_GAP,
    };
  });
}

/* ------------------------------- late drivers ------------------------------ */

/** Row labels name the group only; the screen says late orders "were more often" in one. */
const DRIVER_LABELS: Record<Exclude<LateDriver, "channel">, Record<"yes" | "no", string>> = {
  personalized: { yes: "Personalized", no: "Not personalized" },
  rush: { yes: "Rush", no: "Not rush" },
  multiUnit: { yes: "More than one unit", no: "One unit" },
  blockedOver24h: {
    yes: "Waited over 24 h for mapping or artwork",
    no: "No wait over 24 h for mapping or artwork",
  },
};

async function lateDrivers(
  tx: Tx,
  ctx: Ctx,
  from: Date,
  to: Date,
  channel: SQL,
): Promise<Operations["lateDrivers"]> {
  // late_rate_drivers.sql: orders shipped in the window (not cancelled), late when shipped after
  // ship_by, cut by channel, personalization, rush, multi-unit and a > 24 h block.
  const list = await rows(
    tx,
    sql`with shipped as (
          select o.id, o.channel, o.has_personalization, o.is_rush, o.item_count > 1 as multi_unit,
            o.shipped_at > o.ship_by as late
          from orders o
          where o.company_id = ${ctx.companyId} and o.shipped_at >= ${from} and o.shipped_at < ${to}
            and o.status <> 'cancelled' ${channel}),
        blocked as (
          select distinct tr.order_id from (
            select order_id, to_state, created_at,
              lead(created_at) over (partition by order_item_id order by created_at) as left_at
            from order_item_transitions
            where company_id = ${ctx.companyId} and order_id in (select id from shipped)) tr
          where tr.to_state in ('needs_mapping', 'needs_artwork')
            and coalesce(tr.left_at, now()) - tr.created_at > interval '24 hours'),
        cut as (
          select 'channel' as driver, s.channel as value, s.late from shipped s
          union all select 'personalized', case when s.has_personalization then 'yes' else 'no' end, s.late from shipped s
          union all select 'rush', case when s.is_rush then 'yes' else 'no' end, s.late from shipped s
          union all select 'multiUnit', case when s.multi_unit then 'yes' else 'no' end, s.late from shipped s
          union all select 'blockedOver24h', case when b.order_id is not null then 'yes' else 'no' end, s.late
            from shipped s left join blocked b on b.order_id = s.id)
        select driver, value, count(*)::int as shipped, (count(*) filter (where late))::int as late
        from cut group by 1, 2`,
  );
  const pct = (late: number, shipped: number) =>
    shipped >= MIN.shippedOrders ? Math.round((1000 * late) / shipped) / 10 : null;
  const order: LateDriver[] = ["channel", "personalized", "rush", "multiUnit", "blockedOver24h"];
  const out: LateDriverRow[] = list
    .map((r) => {
      const driver = String(r.driver) as LateDriver;
      const value = String(r.value);
      const label =
        driver === "channel"
          ? (CHANNEL_RULES[value as Channel]?.label ?? value)
          : DRIVER_LABELS[driver][value as "yes" | "no"];
      return {
        driver,
        value,
        label,
        shippedOrders: num(r.shipped),
        lateOrders: num(r.late),
        latePct: pct(num(r.late), num(r.shipped)),
      };
    })
    .sort(
      (a, b) =>
        order.indexOf(a.driver) - order.indexOf(b.driver) ||
        b.shippedOrders - a.shippedOrders ||
        a.value.localeCompare(b.value),
    );
  // Every order appears once in the channel cut, so it gives the totals.
  const channelRows = out.filter((r) => r.driver === "channel");
  const shippedOrders = channelRows.reduce((s, r) => s + r.shippedOrders, 0);
  const lateOrders = channelRows.reduce((s, r) => s + r.lateOrders, 0);
  return { shippedOrders, lateOrders, latePct: pct(lateOrders, shippedOrders), rows: out };
}

/* ---------------------------------- entry ---------------------------------- */

export async function getOperations(tx: Tx, ctx: Ctx, input: OperationsInput): Promise<Operations> {
  const { from, to } = periodOf(input);
  const channel = input.channel ? sql`and o.channel = ${input.channel}` : sql``;
  const settings = await getCostSettings(tx, ctx);
  const reprint = await reprintCost(tx, ctx, from, to, channel);
  const film = await filmWaste(tx, ctx, from, to);
  const wait = await waits(tx, ctx, from, to, channel);
  const press = await pressMinutes(tx, ctx, from, to, channel, settings.laborMinutesPerItem);
  const late = await lateDrivers(tx, ctx, from, to, channel);
  // AC-B/C-screen1: one whole-screen "not enough history yet" when no metric has its sample.
  const hasEnoughHistory =
    reprint.itemsPressed >= MIN.itemsPressed ||
    film.sheets >= MIN.sheets ||
    wait.waits.some((w) => w.entries >= MIN.stateEntries) ||
    press.some((p) => p.timedUnits >= MIN.timedUnits) ||
    late.shippedOrders >= MIN.shippedOrders;
  return {
    period: { from: from.toISOString(), to: to.toISOString() },
    hasEnoughHistory,
    reprintCost: reprint,
    filmWaste: film,
    waits: wait.waits,
    bottleneckStep: wait.bottleneckStep,
    pressMinutesPerUnit: press,
    lateDrivers: late,
    computedAt: new Date().toISOString(),
  };
}
