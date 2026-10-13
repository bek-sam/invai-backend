import { type Alert, AlertMessageCode, AlertParams, type TodaySummary } from "@invai/contracts";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { TenantContext } from "../../api/context";
import type { Tx } from "../../db/client";
import { afterCommit } from "../../db/client";
import type { Channel, CompanySettings } from "../../db/schema";
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
  const dispatchAtRisk = await tx.execute<{ channel: string; n: number }>(
    sql`select o.channel, count(*)::int as n ${dispatchCandidates(cid)} group by o.channel order by o.channel`,
  );
  const dispatchUnconfirmed = await one(
    tx,
    sql`select count(*) as n from alerts where company_id = ${cid} and status = 'open'
      and data->>'messageCode' = 'dispatch_overdue_unconfirmed'`,
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
      dispatchAtRisk: dispatchAtRisk.rows
        .filter((r) => r.n > 0)
        .map((r) => ({ channel: r.channel as Channel, count: r.n })),
      dispatchUnconfirmed: n(dispatchUnconfirmed.n),
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

/**
 * 0.11.0 (B-224): `messageCode`/`params` live nested in `data` (no migration) so they can't
 * collide with a kind's other `data` keys (`available`, `intent`, `deliveryId`…). They only come
 * back out when the code is still known to this build and its params still validate; an old row,
 * a worker/AI alert (title-only) or a future code this build doesn't know yet just shows
 * title/message, same as before.
 */
function toAlert(r: AlertRow): Alert {
  const stored = (r.data ?? {}) as Record<string, unknown>;
  const code = AlertMessageCode.safeParse(stored.messageCode);
  const params = code.success ? AlertParams.safeParse(stored.params) : undefined;
  const known = code.success && params?.success;
  return {
    id: r.id,
    kind: r.kind as Alert["kind"],
    severity: r.severity,
    title: r.title,
    message: r.message,
    entity: r.entityType && r.entityId ? { type: r.entityType, id: r.entityId } : null,
    readAt: r.readAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    ...(known && code.success && params?.success
      ? { messageCode: code.data, params: params.data }
      : {}),
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
  /** 0.11.0: which translated line the web should show, with the values it needs. */
  messageCode?: Alert["messageCode"];
  params?: AlertParams;
};

/**
 * Create or refresh an alert (idempotent per `dedupeKey`). A resolved alert that fires again is
 * reopened as unread. Returns whether it is new. Any module may call this.
 */
export async function raiseAlert(tx: Tx, companyId: string, a: AlertInput) {
  // Nested, never top-level, so a code's params can't collide with the kind's own data keys.
  const data: Record<string, unknown> = { ...(a.data ?? {}) };
  if (a.messageCode) {
    data.messageCode = a.messageCode;
    data.params = a.params ?? {};
  }
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
      data,
    })
    .onConflictDoUpdate({
      target: [alerts.companyId, alerts.dedupeKey],
      set: {
        severity: a.severity,
        title: a.title,
        message: a.message,
        data,
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

/** Most tracker polls one pass hands back per company (the rest follow on the next pass). */
export const DISPATCH_POLL_CAP = 50;
/** Of those, at most this many are re-polls of already alerted labels (first checks go first). */
export const DISPATCH_REPOLL_CAP = 10;
/** An alerted label whose latest tracker check is older than this is polled again. */
export const DISPATCH_REPOLL_AFTER_MS = 6 * 3600_000;
/**
 * Re-polls stop this long after ship-by; the daily fallback sweep takes over. Mirrors
 * shipping/jobs `TRACKER_POLL_AFTER_MS` (it cannot be imported here: shipping/jobs imports this
 * module), and a test keeps the two equal.
 */
export const DISPATCH_REPOLL_MAX_AGE_MS = 3 * 86400_000;
/** Most dispatch alerts one pass raises per company, oldest ship-by first. */
export const DISPATCH_ALERT_CAP = 200;

/**
 * Labeled, unscanned shipments past the order's ship-by: not voided or in transit, order not
 * cancelled, no unit on hold. `s` is the shipment and `o` its order.
 */
const dispatchCandidates = (cid: string) => sql`from shipments s
  join orders o on o.company_id = s.company_id and o.id = s.order_id
  where s.company_id = ${cid} and s.status = 'labeled' and o.ship_by < now()
    and o.status <> 'cancelled'
    and not exists (select 1 from order_items i where i.company_id = s.company_id
      and i.order_id = o.id and i.state = 'on_hold')`;

type DispatchRow = {
  shipment_id: string;
  order_id: string;
  order_no: string;
  channel: string;
  ship_by: Date;
  latest_ok: boolean;
};

/**
 * Alerts for labels that passed ship-by unscanned. A tracker check made after ship-by decides:
 * a successful one still `labeled` is `dispatch_overdue`; a failed one (or one that could not
 * run) is `dispatch_overdue_unconfirmed`. With no check after ship-by nothing is raised yet and
 * the shipment is handed back in `toPoll` (shipping/jobs imports this module, so the job that
 * runs the pass enqueues the polls after the transaction commits).
 */
async function dispatchPass(
  tx: Tx,
  cid: string,
  timezone: string,
  shopDate: Intl.DateTimeFormat,
  raise: (a: AlertInput) => Promise<void>,
) {
  const checked = await tx.execute<DispatchRow>(
    sql`select s.id as shipment_id, o.id as order_id, o.order_no, o.channel, o.ship_by,
        (s.tracker_checked_at is not null and s.tracker_checked_at > o.ship_by
          and (s.tracker_check_failed_at is null or s.tracker_checked_at >= s.tracker_check_failed_at)) as latest_ok
      ${dispatchCandidates(cid)}
        and greatest(s.tracker_checked_at, s.tracker_check_failed_at) > o.ship_by
      order by o.ship_by, s.id limit ${DISPATCH_ALERT_CAP}`,
  );
  for (const r of checked.rows) {
    const shipBy = new Date(r.ship_by);
    const code = r.latest_ok ? "dispatch_overdue" : "dispatch_overdue_unconfirmed";
    await raise({
      kind: "order_overdue",
      severity: "critical",
      title: `Order ${r.order_no} is past its ship-by with no carrier scan`,
      message: r.latest_ok
        ? `Ship-by was ${shopDate.format(shipBy)} and the carrier has not scanned the label.`
        : `Ship-by was ${shopDate.format(shipBy)}. Carrier updates are delayed, so a scan cannot be confirmed.`,
      entityType: "order",
      entityId: r.order_id,
      dedupeKey: `dispatch_scan_missing:${r.shipment_id}:overdue`,
      messageCode: code,
      params: {
        orderNo: r.order_no,
        shipBy: shipBy.toISOString(),
        timeZone: timezone,
        channel: r.channel as Channel,
      },
    });
  }
  const unchecked = await tx.execute<{ shipment_id: string; ship_by: Date }>(
    sql`select s.id as shipment_id, o.ship_by
      ${dispatchCandidates(cid)}
        and (greatest(s.tracker_checked_at, s.tracker_check_failed_at) is null
          or greatest(s.tracker_checked_at, s.tracker_check_failed_at) <= o.ship_by)
      order by o.ship_by, s.id limit ${DISPATCH_POLL_CAP}`,
  );
  const toPoll: { shipmentId: string; shipBy: string; checkedAt: string | null }[] =
    unchecked.rows.map((r) => ({
      shipmentId: r.shipment_id,
      shipBy: new Date(r.ship_by).toISOString(),
      checkedAt: null,
    }));
  // Re-polls fill what the first checks leave of the total cap, at most DISPATCH_REPOLL_CAP.
  const room = Math.min(DISPATCH_REPOLL_CAP, DISPATCH_POLL_CAP - toPoll.length);
  if (room > 0) {
    const due = await tx.execute<{ shipment_id: string; ship_by: Date; checked_at: Date }>(
      sql`select s.id as shipment_id, o.ship_by,
          greatest(s.tracker_checked_at, s.tracker_check_failed_at) as checked_at
        ${dispatchCandidates(cid)}
          and greatest(s.tracker_checked_at, s.tracker_check_failed_at) > o.ship_by
          and greatest(s.tracker_checked_at, s.tracker_check_failed_at)
            < now() - (${DISPATCH_REPOLL_AFTER_MS} * interval '1 millisecond')
          and o.ship_by > now() - (${DISPATCH_REPOLL_MAX_AGE_MS} * interval '1 millisecond')
          and s.carrier_shipment_id is not null and s.tracking_code is not null
        order by o.ship_by, s.id limit ${room}`,
    );
    for (const r of due.rows)
      toPoll.push({
        shipmentId: r.shipment_id,
        shipBy: new Date(r.ship_by).toISOString(),
        checkedAt: new Date(r.checked_at).toISOString(),
      });
  }
  return { toPoll };
}

/**
 * The 5-minute alert sweep for one company: order near ship-by without a label (or overdue),
 * sync broken 30+ min, sheet stuck with the vendor > 24h, stock below reorder point, plan limit
 * near. Idempotent per dedupe key; alerts whose condition cleared are resolved.
 */
export async function generateAlerts(tx: Tx, ctx: Ctx) {
  const cid = ctx.companyId;
  const { settings, timezone } = await companyInfo(tx, cid);
  // "Sep 26" in the shop's time zone (B-137): alert text never shows a raw ISO timestamp.
  const shopDate = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: timezone,
  });
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
        message: `Ship-by was ${shopDate.format(shipBy)} and no label has been bought.`,
        entityType: "order",
        entityId: o.id,
        dedupeKey: `order_overdue:${o.id}`,
        messageCode: "order_overdue",
        params: { orderNo: o.order_no, shipBy: shipBy.toISOString(), timeZone: timezone },
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
        messageCode: "order_at_risk",
        params: { orderNo: o.order_no, shipBy: shipBy.toISOString(), timeZone: timezone, hours },
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
      messageCode: "sync_broken",
      params: { connectionName: c.name },
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
      messageCode: "sheet_stuck",
      params: {
        sheetName: s.name,
        hours: Math.round((Date.now() - new Date(s.sent_at).getTime()) / 3_600_000),
        sheetStatus: s.status as "sent" | "acknowledged",
      },
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
      messageCode: "stock_low",
      params: {
        blankName: label,
        available: s.available,
        reorderPoint: s.reorderPoint ?? undefined,
        incoming: s.incoming ?? 0,
      },
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
      messageCode: ordersMeter.limitReached ? "plan_limit_reached" : "plan_limit_near",
      params: ordersMeter.limitReached
        ? { used: ordersMeter.used, limit: ordersMeter.limit, planName: billing.plan.name }
        : {
            usedPct: Math.round((ordersMeter.ratio ?? 0) * 100),
            used: ordersMeter.used,
            limit: ordersMeter.limit,
            planName: billing.plan.name,
          },
    });
  }

  // Dispatch guard (B-143, default path: no pickup cutoff, only the overdue rule): a label bought,
  // the order's ship-by passed and the carrier still has not scanned the box.
  const dispatch = await dispatchPass(tx, cid, timezone, shopDate, raise);

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
  return { open: keep.size, created, resolved, toPoll: dispatch.toPoll };
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
