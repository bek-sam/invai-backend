import type { Alert, TodaySummary } from "@invai/contracts";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { TenantContext } from "../../api/context";
import type { Tx } from "../../db/client";
import { afterCommit } from "../../db/client";
import type { CompanySettings } from "../../db/schema";
import { alerts, companies } from "../../db/schema";
import { emit } from "../../lib/outbox";
import { keyset, type PageInput } from "../../lib/pagination";
import { publish } from "../../lib/realtime";
import { getStatus as billingStatus } from "../billing/service";
import { lowStockCount, lowStockItems } from "../inventory/service";

/*
 * Today (command center) and alerts. Counts across modules are read-only aggregates
 * (tolerated reads of foreign tables); alerts are this module's own table.
 */

type Ctx = Pick<TenantContext, "companyId">;

export const DEFAULTS = {
  riskWindowHours: 24,
  itemsPerHour: 12,
  shiftStartHour: 7,
  shiftEndHour: 17,
};

const OPEN_ORDER = sql`('new','needs_attention','in_production','ready_to_ship','partially_shipped')`;
const OPEN_ITEM = sql`('imported','needs_mapping','ready','needs_artwork','on_sheet','transfer_in','pressed','packed','on_hold')`;

async function companyInfo(tx: Tx, companyId: string) {
  const [c] = await tx
    .select({ timezone: companies.timezone, settings: companies.settings })
    .from(companies)
    .where(eq(companies.id, companyId));
  const settings = (c?.settings ?? {}) as CompanySettings;
  return { timezone: c?.timezone ?? "America/Phoenix", settings };
}

/** Pure: team capacity for the rest of the day. */
export function capacity(input: {
  staff: number;
  itemsPerHour: number;
  hourNow: number;
  shiftStartHour: number;
  shiftEndHour: number;
}) {
  const start = Math.max(input.hourNow, input.shiftStartHour);
  const hoursLeft = Math.max(0, input.shiftEndHour - start);
  return {
    hoursLeft: Math.round(hoursLeft * 100) / 100,
    capacityItems: Math.floor(Math.max(1, input.staff) * input.itemsPerHour * hoursLeft),
  };
}

type Row = Record<string, number | string | null>;

async function one(tx: Tx, q: ReturnType<typeof sql>): Promise<Row> {
  const res = await tx.execute<Row>(q);
  return res.rows[0] ?? {};
}

const n = (v: unknown) => Number(v ?? 0);

export async function summary(tx: Tx, ctx: Ctx, input: { date?: string }): Promise<TodaySummary> {
  const { timezone, settings } = await companyInfo(tx, ctx.companyId);
  const riskHours = settings.riskWindowHours ?? DEFAULTS.riskWindowHours;
  const clock = await one(
    tx,
    sql`select to_char((now() at time zone ${timezone})::date, 'YYYY-MM-DD') as today,
          extract(hour from now() at time zone ${timezone})
            + extract(minute from now() at time zone ${timezone}) / 60.0 as hour_now`,
  );
  const date = input.date ?? String(clock.today);
  const isToday = date === clock.today;
  // Day window [start, end) in the shop's timezone, as timestamptz.
  const dayStart = sql`(${date}::date::timestamp at time zone ${timezone})`;
  const dayEnd = sql`((${date}::date + 1)::timestamp at time zone ${timezone})`;
  const cid = ctx.companyId;

  const orders = await one(
    tx,
    sql`select
      count(*) filter (where status in ${OPEN_ORDER} and ship_by >= ${dayStart} and ship_by < ${dayEnd}) as due_today,
      count(*) filter (where status in ${OPEN_ORDER} and ship_by < ${isToday ? sql`now()` : dayStart}) as overdue,
      count(*) filter (where status in ('new','needs_attention','in_production')
        and ship_by >= now() and ship_by < now() + make_interval(hours => ${riskHours})) as at_risk,
      count(*) filter (where status = 'on_hold') as on_hold,
      count(*) filter (where created_at >= now() - interval '24 hours') as new_since_yesterday
    from orders where company_id = ${cid}`,
  );
  const items = await one(
    tx,
    sql`select
      count(*) filter (where state = 'needs_mapping') as needs_mapping,
      count(*) filter (where state = 'needs_artwork') as needs_artwork,
      count(*) filter (where state = 'transfer_in') as transfer_in,
      count(*) filter (where state = 'pressed') as pressed,
      count(*) filter (where state = 'packed') as packed,
      count(*) filter (where state in ${OPEN_ITEM} and state not in ('packed','on_hold') and ship_by < ${dayEnd}) as workload
    from order_items where company_id = ${cid}`,
  );
  const sheets = await one(
    tx,
    sql`select
      count(*) filter (where status = 'ready') as ready,
      count(*) filter (where status in ('sent','acknowledged')) as waiting,
      count(*) filter (where status in ('printed','shipped')) as printed
    from gang_sheets where company_id = ${cid}`,
  );
  const scans = await one(
    tx,
    sql`select
      count(*) filter (where action = 'pick') as pick,
      count(*) filter (where action = 'press') as press,
      count(*) filter (where action in ('qc_pass','qc_fail')) as qc,
      count(*) filter (where action = 'pack') as pack
    from scans where company_id = ${cid} and ok and scanned_at >= ${dayStart} and scanned_at < ${dayEnd}`,
  );
  // Pick waits on transfers that arrived but have no pick scan yet.
  const pickWaiting = await one(
    tx,
    sql`select count(*) as n from order_items i where i.company_id = ${cid} and i.state = 'transfer_in'
      and not exists (select 1 from scans s where s.company_id = ${cid} and s.order_item_id = i.id and s.action = 'pick' and s.ok)`,
  );
  const shipping = await one(
    tx,
    sql`select
      count(*) filter (where labeled_at >= ${dayStart} and labeled_at < ${dayEnd}) as labeled_today,
      count(*) filter (where tracking_push_status = 'failed') as push_failed
    from shipments where company_id = ${cid}`,
  );
  const staff = await one(
    tx,
    sql`select count(*) as n from members where organization_id = ${cid} and status = 'active'
      and role in ('presser','packer','receiver')`,
  );
  const alertCounts = await one(
    tx,
    sql`select count(*) filter (where read_at is null) as unread,
      count(*) filter (where severity = 'critical' and read_at is null) as critical
    from alerts where company_id = ${cid} and status = 'open'`,
  );

  const itemsPerHour = settings.itemsPerHour ?? DEFAULTS.itemsPerHour;
  const cap = capacity({
    staff: n(staff.n),
    itemsPerHour,
    hourNow: isToday ? n(clock.hour_now) : date < String(clock.today) ? 24 : 0,
    shiftStartHour: DEFAULTS.shiftStartHour,
    shiftEndHour: settings.shiftEndHour ?? DEFAULTS.shiftEndHour,
  });

  return {
    date,
    generatedAt: new Date().toISOString(),
    orders: {
      dueToday: n(orders.due_today),
      overdue: n(orders.overdue),
      atRisk: n(orders.at_risk),
      onHold: n(orders.on_hold),
      newSinceYesterday: n(orders.new_since_yesterday),
    },
    blocked: { needsMapping: n(items.needs_mapping), needsArtwork: n(items.needs_artwork) },
    sheets: {
      ready: n(sheets.ready),
      waitingOnVendor: n(sheets.waiting),
      printedNotReceived: n(sheets.printed),
    },
    stations: [
      { station: "pick", itemsWaiting: n(pickWaiting.n), itemsDoneToday: n(scans.pick) },
      { station: "press", itemsWaiting: n(items.transfer_in), itemsDoneToday: n(scans.press) },
      { station: "qc", itemsWaiting: n(items.pressed), itemsDoneToday: n(scans.qc) },
      { station: "pack", itemsWaiting: n(items.packed), itemsDoneToday: n(scans.pack) },
    ],
    capacity: {
      capacityItems: cap.capacityItems,
      workloadItems: n(items.workload),
      itemsPerHour,
      hoursLeft: cap.hoursLeft,
    },
    shipping: {
      packedUnlabeled: n(items.packed),
      labeledToday: n(shipping.labeled_today),
      trackingPushFailed: n(shipping.push_failed),
    },
    inventory: { lowStockCount: await lowStockCount(tx, ctx) },
    alerts: { unread: n(alertCounts.unread), critical: n(alertCounts.critical) },
  };
}

/* ---------------------------------- alerts ---------------------------------- */

type AlertRow = typeof alerts.$inferSelect;
type Severity = AlertRow["severity"];

function toAlert(r: AlertRow): Alert {
  return {
    id: r.id,
    kind: r.kind as Alert["kind"],
    severity: r.severity,
    title: r.title,
    message: r.message,
    entity: r.entityType && r.entityId ? { type: r.entityType, id: r.entityId } : null,
    readAt: r.readAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}

export type AlertInput = {
  kind: Alert["kind"];
  severity: Severity;
  title: string;
  message: string;
  entityType?: string | null;
  entityId?: string | null;
  dedupeKey: string;
  data?: Record<string, unknown>;
};

/**
 * Create or refresh an alert (idempotent per `dedupeKey`). A resolved alert that fires again is
 * reopened as unread. Returns whether it is new. Any module may call this.
 */
export async function raiseAlert(tx: Tx, companyId: string, a: AlertInput) {
  const [row] = await tx
    .insert(alerts)
    .values({
      companyId,
      kind: a.kind,
      severity: a.severity,
      title: a.title,
      message: a.message,
      entityType: a.entityType ?? null,
      entityId: a.entityId ?? null,
      dedupeKey: a.dedupeKey,
      data: a.data ?? {},
    })
    .onConflictDoUpdate({
      target: [alerts.companyId, alerts.dedupeKey],
      set: {
        severity: a.severity,
        title: a.title,
        message: a.message,
        data: a.data ?? {},
        readAt: sql`case when ${alerts.status} = 'resolved' or ${alerts.severity} <> ${a.severity} then null else ${alerts.readAt} end`,
        status: "open",
        resolvedAt: null,
      },
    })
    .returning({ id: alerts.id, inserted: sql<boolean>`(xmax = 0)` });
  if (row?.inserted) {
    const alertId = row.id;
    await emit(tx, companyId, "alert.created", { alertId, kind: a.kind, severity: a.severity });
    afterCommit(tx, () =>
      publish(companyId, "alert.created", {
        alertId,
        kind: a.kind,
        severity: a.severity,
        title: a.title,
      }).then(() => undefined),
    );
  }
  return { id: row?.id ?? null, created: !!row?.inserted };
}

/** Resolve open alerts of `kinds` whose dedupe key is not in `keep`. */
async function resolveStale(tx: Tx, companyId: string, kinds: string[], keep: Set<string>) {
  const open = await tx
    .select({ id: alerts.id, key: alerts.dedupeKey })
    .from(alerts)
    .where(
      and(eq(alerts.companyId, companyId), eq(alerts.status, "open"), inArray(alerts.kind, kinds)),
    );
  const stale = open.filter((a) => !keep.has(a.key)).map((a) => a.id);
  if (stale.length) {
    await tx
      .update(alerts)
      .set({ status: "resolved", resolvedAt: new Date() })
      .where(inArray(alerts.id, stale));
  }
  return stale.length;
}

/**
 * The 5-minute alert sweep for one company: order near ship-by without a label (or overdue),
 * sync broken 30+ min, sheet stuck with the vendor > 24h, stock below reorder point, plan limit
 * near. Idempotent per dedupe key; alerts whose condition cleared are resolved.
 */
export async function generateAlerts(tx: Tx, ctx: Ctx) {
  const cid = ctx.companyId;
  const { settings } = await companyInfo(tx, cid);
  const riskHours = settings.riskWindowHours ?? DEFAULTS.riskWindowHours;
  const keep = new Set<string>();
  let created = 0;
  const raise = async (a: AlertInput) => {
    keep.add(a.dedupeKey);
    if ((await raiseAlert(tx, cid, a)).created) created++;
  };

  const risky = await tx.execute<{ id: string; order_no: string; ship_by: Date; overdue: boolean }>(
    sql`select o.id, o.order_no, o.ship_by, o.ship_by < now() as overdue from orders o
      where o.company_id = ${cid} and o.status in ${OPEN_ORDER}
        and o.ship_by < now() + make_interval(hours => ${riskHours})
        and not exists (select 1 from shipments s where s.company_id = ${cid} and s.order_id = o.id
          and s.status in ('labeled','in_transit','delivered'))
      order by o.ship_by limit 200`,
  );
  for (const o of risky.rows) {
    const shipBy = new Date(o.ship_by);
    if (o.overdue) {
      await raise({
        kind: "order_overdue",
        severity: "critical",
        title: `Order ${o.order_no} is past its ship-by`,
        message: `Ship-by was ${shipBy.toISOString()} and no label has been bought.`,
        entityType: "order",
        entityId: o.id,
        dedupeKey: `order_overdue:${o.id}`,
      });
    } else {
      const hours = Math.max(0, Math.round((shipBy.getTime() - Date.now()) / 3_600_000));
      await raise({
        kind: "order_at_risk",
        severity: hours <= 6 ? "critical" : "warning",
        title: `Order ${o.order_no} at risk`,
        message: `Ships within ${hours}h and has no label yet.`,
        entityType: "order",
        entityId: o.id,
        dedupeKey: `order_at_risk:${o.id}`,
      });
    }
  }

  const broken = await tx.execute<{ id: string; name: string; last_error: string | null }>(
    sql`select id, name, last_error from channel_connections where company_id = ${cid}
      and status = 'error' and coalesce(last_error_at, updated_at) < now() - interval '30 minutes'`,
  );
  for (const c of broken.rows) {
    await raise({
      kind: "sync_broken",
      severity: "critical",
      title: `${c.name}: sync broken`,
      message: c.last_error ?? "The connection has been failing for more than 30 minutes.",
      entityType: "connection",
      entityId: c.id,
      dedupeKey: `sync_broken:${c.id}`,
    });
  }

  const stuck = await tx.execute<{ id: string; name: string; status: string; sent_at: Date }>(
    sql`select id, name, status, sent_at from gang_sheets where company_id = ${cid}
      and status in ('sent','acknowledged') and sent_at < now() - interval '24 hours'`,
  );
  for (const s of stuck.rows) {
    await raise({
      kind: "sheet_stuck",
      severity: "warning",
      title: `Sheet ${s.name} stuck with the vendor`,
      message: `Sent ${Math.round((Date.now() - new Date(s.sent_at).getTime()) / 3_600_000)}h ago, still ${s.status}.`,
      entityType: "gang_sheet",
      entityId: s.id,
      dedupeKey: `sheet_stuck:${s.id}`,
    });
  }

  for (const s of await lowStockItems(tx, ctx)) {
    const label = `${s.blank.brand} ${s.blank.styleCode} ${s.blank.color} ${s.blank.size}`;
    await raise({
      kind: "stock_low",
      severity: s.available <= 0 ? "critical" : "warning",
      title: `Low stock: ${label}`,
      message: `${s.available} available, reorder point ${s.reorderPoint}${s.incoming ? `, ${s.incoming} incoming` : ""}.`,
      entityType: "blank_variant",
      entityId: s.blankVariantId,
      dedupeKey: `stock_low:${s.blankVariantId}`,
      data: { available: s.available, reorderPoint: s.reorderPoint },
    });
  }

  const billing = await billingStatus(tx, ctx);
  const ordersMeter = billing.usage.orders;
  if (ordersMeter.limit != null && (ordersMeter.ratio ?? 0) >= 0.9) {
    const period = billing.usage.periodStart.slice(0, 7);
    await raise({
      kind: "plan_limit_reached",
      severity: ordersMeter.limitReached ? "critical" : "warning",
      title: ordersMeter.limitReached
        ? "Monthly order limit reached"
        : `${Math.round((ordersMeter.ratio ?? 0) * 100)}% of monthly orders used`,
      message: `${ordersMeter.used} of ${ordersMeter.limit} orders on the ${billing.plan.name} plan this month.`,
      entityType: "billing",
      entityId: null,
      dedupeKey: `plan_limit:${period}:orders`,
    });
  }

  const resolved = await resolveStale(
    tx,
    cid,
    [
      "order_at_risk",
      "order_overdue",
      "sync_broken",
      "sheet_stuck",
      "stock_low",
      "plan_limit_reached",
    ],
    keep,
  );
  return { open: keep.size, created, resolved };
}

export type AlertListInput = PageInput & {
  unreadOnly?: boolean;
  kind?: Alert["kind"][];
  severity?: Severity[];
};

export async function listAlerts(tx: Tx, ctx: Ctx, input: AlertListInput) {
  const page = keyset(alerts.createdAt, alerts.id, input);
  const rows = await tx
    .select()
    .from(alerts)
    .where(
      and(
        eq(alerts.companyId, ctx.companyId),
        eq(alerts.status, "open"),
        input.unreadOnly ? isNull(alerts.readAt) : undefined,
        input.kind?.length ? inArray(alerts.kind, input.kind) : undefined,
        input.severity?.length ? inArray(alerts.severity, input.severity) : undefined,
        page.where,
      ),
    )
    .orderBy(...page.orderBy)
    .limit(page.limit + 1);
  const [u] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(alerts)
    .where(
      and(eq(alerts.companyId, ctx.companyId), eq(alerts.status, "open"), isNull(alerts.readAt)),
    );
  return { ...page.result(rows, toAlert), unread: u?.n ?? 0 };
}

export async function markRead(tx: Tx, ctx: Ctx, ids: string[]) {
  const rows = await tx
    .update(alerts)
    .set({ readAt: new Date() })
    .where(and(eq(alerts.companyId, ctx.companyId), inArray(alerts.id, ids), isNull(alerts.readAt)))
    .returning({ id: alerts.id });
  return { updated: rows.length };
}

export async function markAllRead(tx: Tx, ctx: Ctx) {
  const rows = await tx
    .update(alerts)
    .set({ readAt: new Date() })
    .where(and(eq(alerts.companyId, ctx.companyId), isNull(alerts.readAt)))
    .returning({ id: alerts.id });
  return { updated: rows.length };
}
