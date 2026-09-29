import type {
  MaintenanceEndInput,
  MaintenanceEndResult,
  MaintenanceStartInput,
  MaintenanceStartResult,
  StationMaintenance,
} from "@invai/contracts";
import { and, desc, eq, gt, gte, isNotNull, isNull, lte, or, type SQL } from "drizzle-orm";
import type { TenantContext } from "../../api/context";
import { afterCommit, type Tx } from "../../db/client";
import { stationMaintenanceEvents, stations } from "../../db/schema";
import { audit } from "../../lib/audit";
import { notFound } from "../../lib/errors";
import { logger } from "../../lib/log";
import { emit } from "../../lib/outbox";
import { keyset, type PageInput } from "../../lib/pagination";
import { publish } from "../../lib/realtime";

/*
 * Station maintenance windows (B-35, T-22-4). A window is open while `endedAt` is null; while
 * it is open, `scan()` answers every transfer scan at that station with a blocked ScanResult
 * (`station_maintenance`), and so it does for a replayed scan whose `scannedAt` fell inside a window. Start and end are idempotent by result shape (`started`/`ended`),
 * and only an effective change is audited, emitted and published.
 */

const log = logger("production.maintenance");

type Row = typeof stationMaintenanceEvents.$inferSelect;

export type MaintenanceListInput = PageInput & {
  stationId?: string | undefined;
  open?: boolean | undefined;
  from?: string | undefined;
  to?: string | undefined;
};

function toMaintenance(row: Row, stationName: string): StationMaintenance {
  return {
    id: row.id,
    stationId: row.stationId,
    stationName,
    reason: row.reason,
    note: row.note,
    startedAt: row.startedAt.toISOString(),
    startedBy: row.startedBy,
    endedAt: row.endedAt?.toISOString() ?? null,
    endedBy: row.endedBy,
  };
}

/** Station under the tenant, locked so start/end on one station serialize. Stations belong to tenancy; this is a read + lock. */
async function lockStation(tx: Tx, stationId: string) {
  const [s] = await tx
    .select({ id: stations.id, name: stations.name })
    .from(stations)
    .where(eq(stations.id, stationId))
    .for("update");
  if (!s) throw notFound("station", stationId);
  return s;
}

/** The open window at a station, or null. Used by the scan path. */
export async function openMaintenance(tx: Tx, stationId: string): Promise<Row | null> {
  const [row] = await tx
    .select()
    .from(stationMaintenanceEvents)
    .where(
      and(
        eq(stationMaintenanceEvents.stationId, stationId),
        isNull(stationMaintenanceEvents.endedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * The window that blocks a scan made at `at`: one open now, or one that covered `at` (a scan made
 * offline during a window and replayed after it ended). Leads with company_id so the lookup uses
 * the (company_id, station_id, started_at) index.
 */
export async function blockingMaintenance(
  tx: Tx,
  companyId: string,
  stationId: string,
  at: Date,
): Promise<Row | null> {
  const t = stationMaintenanceEvents;
  const [row] = await tx
    .select()
    .from(t)
    .where(
      and(
        eq(t.companyId, companyId),
        eq(t.stationId, stationId),
        or(isNull(t.endedAt), and(lte(t.startedAt, at), gt(t.endedAt, at))),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function changed(tx: Tx, ctx: TenantContext, row: Row, open: boolean) {
  await emit(tx, ctx.companyId, "station.maintenance_changed", {
    stationId: row.stationId,
    maintenanceId: row.id,
    open,
    reason: row.reason,
  });
  afterCommit(tx, () =>
    publish(ctx.companyId, {
      type: "station.maintenance_changed",
      data: { stationId: row.stationId, open },
    }).then(() => undefined),
  );
}

export async function startMaintenance(
  tx: Tx,
  ctx: TenantContext,
  input: MaintenanceStartInput,
): Promise<MaintenanceStartResult> {
  const station = await lockStation(tx, input.stationId);
  const existing = await openMaintenance(tx, station.id);
  if (existing) return { maintenance: toMaintenance(existing, station.name), started: false };
  const [row] = await tx
    .insert(stationMaintenanceEvents)
    .values({
      companyId: ctx.companyId,
      stationId: station.id,
      reason: input.reason,
      note: input.note,
      startedBy: ctx.userId,
    })
    .onConflictDoNothing()
    .returning();
  if (!row) {
    // Lost a race to a concurrent start (the partial unique index): return the winner's window.
    const winner = await openMaintenance(tx, station.id);
    if (!winner) throw new Error("maintenance start raced but no open window found");
    return { maintenance: toMaintenance(winner, station.name), started: false };
  }
  await audit(tx, {
    companyId: ctx.companyId,
    actor: ctx.actor,
    action: "station.maintenance_started",
    entityType: "station",
    entityId: station.id,
    summary: `${station.name}: maintenance started (${input.reason})`,
    data: { maintenanceId: row.id, reason: input.reason },
  });
  await changed(tx, ctx, row, true);
  log.info("maintenance started", { companyId: ctx.companyId, stationId: station.id });
  return { maintenance: toMaintenance(row, station.name), started: true };
}

export async function endMaintenance(
  tx: Tx,
  ctx: TenantContext,
  input: MaintenanceEndInput,
): Promise<MaintenanceEndResult> {
  const station = await lockStation(tx, input.stationId);
  const now = new Date();
  const [row] = await tx
    .update(stationMaintenanceEvents)
    .set({ endedAt: now, endedBy: ctx.userId, endNote: input.note, updatedAt: now })
    .where(
      and(
        eq(stationMaintenanceEvents.stationId, station.id),
        isNull(stationMaintenanceEvents.endedAt),
      ),
    )
    .returning();
  if (!row) {
    const [last] = await tx
      .select()
      .from(stationMaintenanceEvents)
      .where(eq(stationMaintenanceEvents.stationId, station.id))
      .orderBy(desc(stationMaintenanceEvents.endedAt))
      .limit(1);
    return { maintenance: last ? toMaintenance(last, station.name) : null, ended: false };
  }
  await audit(tx, {
    companyId: ctx.companyId,
    actor: ctx.actor,
    action: "station.maintenance_ended",
    entityType: "station",
    entityId: station.id,
    summary: `${station.name}: maintenance ended`,
    data: {
      maintenanceId: row.id,
      minutes: Math.round((now.getTime() - row.startedAt.getTime()) / 60000),
    },
  });
  await changed(tx, ctx, row, false);
  log.info("maintenance ended", { companyId: ctx.companyId, stationId: station.id });
  return { maintenance: toMaintenance(row, station.name), ended: true };
}

export async function listMaintenance(tx: Tx, _ctx: TenantContext, input: MaintenanceListInput) {
  const page = keyset(stationMaintenanceEvents.createdAt, stationMaintenanceEvents.id, input);
  const filters: (SQL | undefined)[] = [page.where];
  if (input.stationId) filters.push(eq(stationMaintenanceEvents.stationId, input.stationId));
  if (input.open === true) filters.push(isNull(stationMaintenanceEvents.endedAt));
  if (input.open === false) filters.push(isNotNull(stationMaintenanceEvents.endedAt));
  if (input.from) filters.push(gte(stationMaintenanceEvents.startedAt, new Date(input.from)));
  if (input.to) filters.push(lte(stationMaintenanceEvents.startedAt, new Date(input.to)));
  const rows = await tx
    .select({ m: stationMaintenanceEvents, stationName: stations.name })
    .from(stationMaintenanceEvents)
    .innerJoin(stations, eq(stations.id, stationMaintenanceEvents.stationId))
    .where(and(...filters))
    .orderBy(...page.orderBy)
    .limit(page.limit + 1);
  return page.result(
    rows.map((x) => ({ ...x, createdAt: x.m.createdAt, id: x.m.id })),
    (x) => toMaintenance(x.m, x.stationName),
  );
}
