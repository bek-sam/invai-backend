import type {
  DesignLifecycle,
  DesignLifecycleInput,
  DesignLifecycleRow,
  DesignLifecycleStage,
  TrendClass,
} from "@invai/contracts";
import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type { TenantContext } from "../../api/context";
import type { Tx } from "../../db/client";
import { logger } from "../../lib/log";
import { getTrendSignal } from "../market/service";
import { companyTimezone } from "./shared";

/*
 * `analytics.designLifecycle` (T-A5, spec Track C). Stage per design as of a date
 * (`invai-docs/metrics/definitions/design_lifecycle_stage.md`, `metrics/sql/design_lifecycle.sql`),
 * deferring to the market module's own statistical trend
 * (`../market/service.ts` `getTrendSignal`, read through its exported service function, never
 * its tables) when it has one for that design. Runs inside the caller's `withTenant`; every
 * query also filters `company_id` explicitly. No buyer PII is read.
 */

type Ctx = Pick<TenantContext, "companyId">;
type Row = Record<string, unknown>;

const log = logger("analytics.design");

/** design_lifecycle_stage.md: u4/p4 floor, same as MIN_UNITS in the analyst queries. */
const MIN_UNITS = 3;
const DAY_MS = 86_400_000;
const NEW_WINDOW_MS = 56 * DAY_MS;
const DEAD_WINDOW_MS = 60 * DAY_MS;
/** design_lifecycle_stage.md caveat: never-sold counts as dead only after 60 days in InvAI. */
const NEVER_SOLD_DEAD_HISTORY_MS = 60 * DAY_MS;
const STEADY_WINDOW_MS = 60 * DAY_MS;
const GROWING_RATIO = 1.25;
const DECLINING_RATIO = 0.75;

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

async function rows(tx: Tx, q: SQL): Promise<Row[]> {
  return (await tx.execute<Row>(q)).rows;
}

/** design_lifecycle.sql's CASE ladder: first match wins. */
function stageOf(
  row: {
    u4: number;
    p4: number;
    firstSaleAt: Date | null;
    lastSaleAt: Date | null;
    hasActiveListing: boolean;
  },
  t: Date,
  /** False while the shop has under 60 days in InvAI: a never-sold listing can't be dated yet. */
  neverSoldCanBeDead: boolean,
): DesignLifecycleStage {
  const { u4, p4, firstSaleAt, lastSaleAt, hasActiveListing } = row;
  if (hasActiveListing && lastSaleAt && lastSaleAt.getTime() < t.getTime() - DEAD_WINDOW_MS)
    return "dead";
  if (hasActiveListing && !lastSaleAt && neverSoldCanBeDead) return "dead";
  if (firstSaleAt && firstSaleAt.getTime() >= t.getTime() - NEW_WINDOW_MS) return "new";
  if (u4 >= MIN_UNITS && u4 >= GROWING_RATIO * p4) return "growing";
  if (p4 >= MIN_UNITS && u4 <= DECLINING_RATIO * p4) return "declining";
  if (lastSaleAt && lastSaleAt.getTime() >= t.getTime() - STEADY_WINDOW_MS) return "steady";
  return "inactive";
}

/**
 * The design's own statistical trend (market module, `subjectType design`, `source own`) wins
 * over the lifecycle-only stage when it isn't `insufficient` (AC-C4). A niche-level reading
 * (outside sources for the design's niche) is not the design's trend and never moves the stage.
 */
const STAGE_FROM_TREND: Partial<Record<TrendClass, DesignLifecycleStage>> = {
  rising: "growing",
  falling: "declining",
  flat: "steady",
};

const STAGE_ORDER: DesignLifecycleStage[] = [
  "new",
  "growing",
  "steady",
  "declining",
  "dead",
  "inactive",
];

export async function designLifecycle(
  tx: Tx,
  ctx: Ctx,
  input: DesignLifecycleInput,
): Promise<DesignLifecycle> {
  const tz = await companyTimezone(tx, ctx.companyId);
  const channel = input.channel ? sql`and o.channel = ${input.channel}` : sql``;
  const listedChannel = input.channel ? sql`and l.channel = ${input.channel}` : sql``;

  // Resolve `asOf` (default: today in the shop's tz) and its shop-midnight instant `t`, exactly
  // as design_lifecycle.sql does, so a hand computation here can never drift from Postgres's.
  const [resolved] = await rows(
    tx,
    sql`select coalesce(${input.asOf ?? null}::date, (now() at time zone ${tz})::date) as asof_date,
          (coalesce(${input.asOf ?? null}::date, (now() at time zone ${tz})::date)::timestamp
            at time zone ${tz}) as t,
          (select c.created_at from companies c where c.id = ${ctx.companyId}) as company_created_at`,
  );
  const asOfDate = String(resolved?.asof_date);
  const t = new Date(String(resolved?.t));
  const createdAt = resolved?.company_created_at
    ? new Date(String(resolved.company_created_at))
    : t;
  const historyMs = t.getTime() - createdAt.getTime();
  const neverSoldCanBeDead = historyMs >= NEVER_SOLD_DEAD_HISTORY_MS;

  const list = await rows(
    tx,
    sql`with sales as (
          select oi.design_id,
            (count(*) filter (where o.placed_at >= ${t}::timestamptz - interval '28 days'))::int as u4,
            (count(*) filter (where o.placed_at >= ${t}::timestamptz - interval '56 days'
              and o.placed_at < ${t}::timestamptz - interval '28 days'))::int as p4,
            (count(*) filter (where o.placed_at >= ${t}::timestamptz - interval '365 days'))::int as u365,
            min(o.placed_at) as first_sale, max(o.placed_at) as last_sale
          from order_items oi
          join orders o on o.company_id = ${ctx.companyId} and o.id = oi.order_id
          where oi.company_id = ${ctx.companyId} and oi.design_id is not null
            and oi.state <> 'cancelled'
            and o.placed_at < ${t}::timestamptz and o.placed_at >= ${t}::timestamptz - interval '365 days' ${channel}
          group by 1),
        listed as (
          select distinct l.design_id from listings l
          where l.company_id = ${ctx.companyId} and l.state = 'active' and l.design_id is not null
            ${listedChannel})
        select d.id as design_id, d.name as design_name,
          coalesce(s.u4, 0) as u4, coalesce(s.p4, 0) as p4, coalesce(s.u365, 0) as u365,
          s.first_sale, s.last_sale, (ls.design_id is not null) as has_active_listing
        from designs d
        left join sales s on s.design_id = d.id
        left join listed ls on ls.design_id = d.id
        where d.company_id = ${ctx.companyId} and (s.design_id is not null or ls.design_id is not null)`,
  );

  const rowsOut: DesignLifecycleRow[] = [];
  for (const r of list) {
    const firstSaleAt = r.first_sale ? new Date(String(r.first_sale)) : null;
    const lastSaleAt = r.last_sale ? new Date(String(r.last_sale)) : null;
    const hasActiveListing = Boolean(r.has_active_listing);
    const u4 = num(r.u4);
    const p4 = num(r.p4);
    let stage = stageOf(
      { u4, p4, firstSaleAt, lastSaleAt, hasActiveListing },
      t,
      neverSoldCanBeDead,
    );

    let marketTrend: TrendClass | null = null;
    let marketGrowth4w: number | null = null;
    // A savepoint, so a failed market read rolls back only itself and never leaves the outer
    // transaction aborted for the queries after it; the failure is logged, not hidden.
    const trend = await tx
      .transaction((sp) => getTrendSignal(sp, ctx, { designId: String(r.design_id) }))
      .catch((err: unknown) => {
        log.warn("market trend read failed", {
          companyId: ctx.companyId,
          designId: String(r.design_id),
          error: (err as Error).message,
        });
        return null;
      });
    const own = trend?.readings.find(
      (x) => x.provenance.source === "own" && x.trend !== "insufficient",
    );
    if (own) {
      marketTrend = own.trend;
      marketGrowth4w = own.growth4w;
      stage = STAGE_FROM_TREND[own.trend] ?? stage;
    }

    rowsOut.push({
      designId: String(r.design_id),
      designName: String(r.design_name),
      stage,
      units4w: u4,
      unitsPrior4w: p4,
      units365d: num(r.u365),
      firstSaleAt: firstSaleAt ? firstSaleAt.toISOString() : null,
      lastSaleAt: lastSaleAt ? lastSaleAt.toISOString() : null,
      hasActiveListing,
      marketTrend,
      marketGrowth4w,
    });
  }
  rowsOut.sort(
    (a, b) => a.designName.localeCompare(b.designName) || a.designId.localeCompare(b.designId),
  );

  const counts = new Map<DesignLifecycleStage, { designs: number; units4w: number }>();
  for (const r of rowsOut) {
    const c = counts.get(r.stage) ?? { designs: 0, units4w: 0 };
    c.designs += 1;
    c.units4w += r.units4w;
    counts.set(r.stage, c);
  }
  const stageCounts = STAGE_ORDER.filter((s) => counts.has(s)).map((stage) => ({
    stage,
    ...(counts.get(stage) as { designs: number; units4w: number }),
  }));

  return {
    asOf: asOfDate,
    // AC-B/C-screen1: whole-screen "not enough history yet" unless some design has the
    // metric's minimum sample (3 units in a year), or the shop is old enough in InvAI for its
    // never-sold listings to count as dead.
    hasEnoughHistory: neverSoldCanBeDead || rowsOut.some((r) => r.units365d >= MIN_UNITS),
    rows: rowsOut,
    stageCounts,
  };
}
