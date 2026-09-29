import { call } from "@orpc/server";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { anonymousContext, type Context, permissionsFor } from "../../api/context";
import { router } from "../../api/router";
import { withSystem, withTenant } from "../../db/client";
import type { Role } from "../../db/schema";
import {
  auditLog,
  blankVariants,
  companies,
  gangSheetBatches,
  gangSheets,
  inventoryMovements,
  orderItems,
  outboxEvents,
  reprints,
  scans,
  stationMaintenanceEvents,
  transfers,
} from "../../db/schema";
import {
  createCompany,
  createConnection,
  createLocation,
  createOrder,
  createStation,
  createUser,
  tenantContext,
} from "../../test/fixtures";
import { setShelf } from "../inventory/service";
import * as svc from "./service";
import { transferAge } from "./views";

/*
 * T-22-4 (B-35, B-32): station maintenance blocks scans, transfer age on pick/press, the blank's
 * shelf and bin on the pick list, and the new QC fail reasons in the reasons report.
 */

type Ctx = ReturnType<typeof tenantContext>;
const DAY = 86_400_000;

async function codeOf(fn: () => Promise<unknown>) {
  try {
    await fn();
    return "OK";
  } catch (err) {
    return (err as { code?: string }).code ?? String(err);
  }
}

/** A shop with one press station and a location, plus helpers to put units on a received sheet. */
async function shop() {
  const companyId = (await createCompany()).id;
  const location = await createLocation(companyId);
  const station = await createStation(companyId, location.id, "Press 1");
  const station2 = await createStation(companyId, location.id, "Press 2");
  const connectionId = (await createConnection(companyId)).id;
  const office = tenantContext(companyId, (await createUser(companyId, "office")).id, "office");
  const presser = tenantContext(companyId, (await createUser(companyId, "presser")).id, "presser");
  const [blank] = await withSystem((tx) =>
    tx
      .insert(blankVariants)
      .values({
        companyId,
        brand: "Gildan",
        style: "64000",
        styleCode: "64000",
        color: "Black",
        colorCode: "BLK",
        size: "M",
        sizeCode: "M",
        sku: `G64000-BLK-M-${companyId.slice(0, 6)}`,
      })
      .returning(),
  );
  if (!blank) throw new Error("blank");
  const blankId = blank.id;

  /** `units` items in transfer_in on a sheet printed `printedDaysAgo` (or only received). */
  async function unitsOnSheet(
    units: number,
    sheet: { printedDaysAgo?: number | null; receivedDaysAgo?: number | null } = {
      printedDaysAgo: 2,
    },
  ) {
    const { order, items } = await createOrder(companyId, connectionId, {
      units,
      state: "transfer_in",
    });
    const transferIds = await withSystem(async (tx) => {
      const [batch] = await tx
        .insert(gangSheetBatches)
        .values({ companyId, name: `b-${order.id.slice(0, 8)}`, status: "complete" })
        .returning();
      const ago = (d: number | null | undefined) =>
        d == null ? null : new Date(Date.now() - d * DAY);
      const [sh] = await tx
        .insert(gangSheets)
        .values({
          companyId,
          batchId: batch?.id ?? "",
          name: `s-${order.id.slice(0, 8)}`,
          status: "received",
          printedAt: ago(sheet.printedDaysAgo),
          receivedAt: ago(sheet.receivedDaysAgo ?? 0),
        })
        .returning();
      const ids: string[] = [];
      for (const it of items) {
        const [t] = await tx
          .insert(transfers)
          .values({
            companyId,
            gangSheetId: sh?.id ?? "",
            orderItemId: it.id,
            widthIn: 10,
            heightIn: 12,
            status: "received",
          })
          .returning();
        ids.push(t?.id ?? "");
        await tx
          .update(orderItems)
          .set({ transferId: t?.id, gangSheetId: sh?.id, blankVariantId: blankId })
          .where(eq(orderItems.id, it.id));
      }
      return ids;
    }, companyId);
    return { order, items, transferIds };
  }

  return { companyId, location, station, station2, office, presser, blank, unitsOnSheet };
}

const press = (
  ctx: Ctx,
  companyId: string,
  input: {
    transferId: string;
    blankId: string;
    stationId: string;
    clientScanId?: string;
    scannedAt?: string;
  },
) =>
  withTenant(companyId, (tx) =>
    svc.scan(tx, ctx, {
      clientScanId: input.clientScanId ?? crypto.randomUUID(),
      station: "press",
      stationId: input.stationId,
      transferCode: `T:${input.transferId}`,
      blankCode: `B:${input.blankId}`,
      scannedAt: input.scannedAt ?? new Date().toISOString(),
    }),
  );

describe("station maintenance (B-35)", () => {
  let s: Awaited<ReturnType<typeof shop>>;
  beforeAll(async () => {
    s = await shop();
  });

  it("blocks press scans while open, is idempotent and audited, and reopens on end", async () => {
    const { companyId, office, presser, station, blank } = s;
    const start = () =>
      withTenant(companyId, (tx) =>
        svc.startMaintenance(tx, office, {
          stationId: station.id,
          reason: "cleaning",
          note: "platen",
        }),
      );
    const first = await start();
    expect(first.started).toBe(true);
    expect(first.maintenance).toMatchObject({
      stationId: station.id,
      stationName: "Press 1",
      reason: "cleaning",
      note: "platen",
      endedAt: null,
      startedBy: office.userId,
    });
    const again = await start();
    expect(again).toEqual({ maintenance: first.maintenance, started: false });

    const { items, transferIds } = await s.unitsOnSheet(1);
    const clientScanId = crypto.randomUUID();
    const blocked = await press(presser, companyId, {
      transferId: transferIds[0] ?? "",
      blankId: blank.id,
      stationId: station.id,
      clientScanId,
    });
    expect(blocked).toMatchObject({
      ok: false,
      mismatch: "station_maintenance",
      nextAction: "press",
      orderItemId: items[0]?.id,
      itemState: "transfer_in",
    });
    // Replay returns the stored blocked result; the unit didn't move.
    const replay = await press(presser, companyId, {
      transferId: transferIds[0] ?? "",
      blankId: blank.id,
      stationId: station.id,
      clientScanId,
    });
    expect(replay).toEqual(blocked);
    const [item] = await withTenant(companyId, (tx) =>
      tx
        .select()
        .from(orderItems)
        .where(eq(orderItems.id, items[0]?.id ?? "")),
    );
    expect(item?.state).toBe("transfer_in");
    const stored = await withTenant(companyId, (tx) =>
      tx.select().from(scans).where(eq(scans.clientScanId, clientScanId)),
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]?.mismatch).toBe("station_maintenance");

    // Another station stays open.
    const other = await press(presser, companyId, {
      transferId: transferIds[0] ?? "",
      blankId: blank.id,
      stationId: s.station2.id,
    });
    expect(other).toMatchObject({ ok: true, itemState: "pressed" });

    const end = () =>
      withTenant(companyId, (tx) =>
        svc.endMaintenance(tx, office, { stationId: station.id, note: "done" }),
      );
    const ended = await end();
    expect(ended.ended).toBe(true);
    expect(ended.maintenance?.endedBy).toBe(office.userId);
    const endedAgain = await end();
    expect(endedAgain).toEqual({ maintenance: ended.maintenance, ended: false });

    const audits = await withTenant(companyId, (tx) =>
      tx
        .select({ action: auditLog.action })
        .from(auditLog)
        .where(and(eq(auditLog.entityType, "station"), eq(auditLog.entityId, station.id))),
    );
    expect(audits.map((a) => a.action).sort()).toEqual([
      "station.maintenance_ended",
      "station.maintenance_started",
    ]);
    const events = await withSystem((tx) =>
      tx
        .select({ payload: outboxEvents.payload })
        .from(outboxEvents)
        .where(
          and(
            eq(outboxEvents.companyId, companyId),
            eq(outboxEvents.name, "station.maintenance_changed"),
          ),
        ),
    );
    expect(events.map((e) => (e.payload as { open: boolean }).open).sort()).toEqual([false, true]);

    // After the end, a fresh scan at the reopened station works.
    const next = await s.unitsOnSheet(1);
    const ok = await press(presser, companyId, {
      transferId: next.transferIds[0] ?? "",
      blankId: blank.id,
      stationId: station.id,
    });
    expect(ok).toMatchObject({ ok: true, mismatch: null, itemState: "pressed" });
  });

  it("blocks an offline scan replayed after the window ended when scannedAt fell inside it", async () => {
    // Own shop: a closed window must not leak into the other tests' station state.
    const t = await shop();
    const hour = 3_600_000;
    const now = Date.now();
    await withTenant(t.companyId, (tx) =>
      tx.insert(stationMaintenanceEvents).values({
        companyId: t.companyId,
        stationId: t.station.id,
        reason: "calibration",
        startedAt: new Date(now - 2 * hour),
        endedAt: new Date(now - hour),
      }),
    );
    const consumes = (itemId: string) =>
      withTenant(t.companyId, (tx) =>
        tx
          .select({ id: inventoryMovements.id })
          .from(inventoryMovements)
          .where(and(eq(inventoryMovements.refId, itemId), eq(inventoryMovements.kind, "consume"))),
      );
    const stateOf = async (itemId: string) =>
      (
        await withTenant(t.companyId, (tx) =>
          tx.select({ state: orderItems.state }).from(orderItems).where(eq(orderItems.id, itemId)),
        )
      )[0]?.state;

    // Made at the window's midpoint while offline, synced now: blocked, unit and blank untouched.
    const during = await t.unitsOnSheet(1);
    const duringItem = during.items[0]?.id ?? "";
    const blocked = await press(t.presser, t.companyId, {
      transferId: during.transferIds[0] ?? "",
      blankId: t.blank.id,
      stationId: t.station.id,
      scannedAt: new Date(now - 1.5 * hour).toISOString(),
    });
    expect(blocked).toMatchObject({
      ok: false,
      mismatch: "station_maintenance",
      itemState: "transfer_in",
    });
    expect(await stateOf(duringItem)).toBe("transfer_in");
    expect(await consumes(duringItem)).toHaveLength(0);

    // Made after the window ended: presses and uses the blank.
    const after = await t.unitsOnSheet(1);
    const afterItem = after.items[0]?.id ?? "";
    const pressed = await press(t.presser, t.companyId, {
      transferId: after.transferIds[0] ?? "",
      blankId: t.blank.id,
      stationId: t.station.id,
      scannedAt: new Date(now - 0.5 * hour).toISOString(),
    });
    expect(pressed).toMatchObject({ ok: true, mismatch: null, itemState: "pressed" });
    expect(await stateOf(afterItem)).toBe("pressed");
    expect(await consumes(afterItem)).toHaveLength(1);
  });

  it("ending with nothing ever open returns null; one open window per station", async () => {
    const { companyId, office, station2 } = s;
    const none = await withTenant(companyId, (tx) =>
      svc.endMaintenance(tx, office, { stationId: station2.id, note: null }),
    );
    expect(none).toEqual({ maintenance: null, ended: false });
    await withTenant(companyId, (tx) =>
      svc.startMaintenance(tx, office, { stationId: station2.id, reason: "repair", note: null }),
    );
    // The partial unique index refuses a second open window even past the service.
    const dup = await codeOf(() =>
      withTenant(companyId, (tx) =>
        tx
          .insert(stationMaintenanceEvents)
          .values({ companyId, stationId: station2.id, reason: "other" }),
      ),
    );
    expect(dup).not.toBe("OK");
    const open = await withTenant(companyId, (tx) =>
      svc.listMaintenance(tx, office, { limit: 50, open: true }),
    );
    expect(open.items.map((m) => m.stationId)).toEqual([station2.id]);
    const all = await withTenant(companyId, (tx) =>
      svc.listMaintenance(tx, office, { limit: 50, stationId: s.station.id }),
    );
    expect(all.items).toHaveLength(1);
    expect(all.items[0]?.endedAt).not.toBeNull();
    await withTenant(companyId, (tx) =>
      svc.endMaintenance(tx, office, { stationId: station2.id, note: null }),
    );
  });

  it("isolates tenants: another shop's station is NOT_FOUND and its windows are invisible", async () => {
    const other = await shop();
    await withTenant(s.companyId, (tx) =>
      svc.startMaintenance(tx, s.office, { stationId: s.station.id, reason: "other", note: null }),
    );
    expect(
      await codeOf(() =>
        withTenant(other.companyId, (tx) =>
          svc.startMaintenance(tx, other.office, {
            stationId: s.station.id,
            reason: "other",
            note: null,
          }),
        ),
      ),
    ).toBe("NOT_FOUND");
    expect(
      await codeOf(() =>
        withTenant(other.companyId, (tx) =>
          svc.endMaintenance(tx, other.office, { stationId: s.station.id, note: null }),
        ),
      ),
    ).toBe("NOT_FOUND");
    const seen = await withTenant(other.companyId, (tx) =>
      svc.listMaintenance(tx, other.office, { limit: 50 }),
    );
    expect(seen.items).toHaveLength(0);
    // The composite FK refuses a row of shop B pointing at shop A's station.
    expect(
      await codeOf(() =>
        withTenant(other.companyId, (tx) =>
          tx.insert(stationMaintenanceEvents).values({
            companyId: other.companyId,
            stationId: s.station.id,
            reason: "other",
          }),
        ),
      ),
    ).not.toBe("OK");
    // RLS WITH CHECK refuses the wrong company_id.
    expect(
      await codeOf(() =>
        withTenant(other.companyId, (tx) =>
          tx.insert(stationMaintenanceEvents).values({
            companyId: s.companyId,
            stationId: s.station.id,
            reason: "other",
          }),
        ),
      ),
    ).not.toBe("OK");
    // Shop B naming shop A's station in a scan: NOT_FOUND, never A's maintenance state.
    const { transferIds } = await other.unitsOnSheet(1);
    expect(
      await codeOf(() =>
        press(other.presser, other.companyId, {
          transferId: transferIds[0] ?? "",
          blankId: other.blank.id,
          stationId: s.station.id,
        }),
      ),
    ).toBe("NOT_FOUND");
    await withTenant(s.companyId, (tx) =>
      svc.endMaintenance(tx, s.office, { stationId: s.station.id, note: null }),
    );
  });
});

describe("maintenance permissions (router)", () => {
  let companyId: string;
  let stationId: string;
  const users: Partial<Record<Role, string>> = {};
  const as = (role: Role): Context => ({
    ...anonymousContext(new Headers(), null),
    sessionKind: "user",
    user: { id: users[role] ?? "", name: role, email: `${role}@test.local` },
    emailVerified: true,
    companyId,
    orgType: "shop",
    role,
    permissions: permissionsFor(role),
  });

  beforeAll(async () => {
    companyId = (await createCompany()).id;
    stationId = (await createStation(companyId, (await createLocation(companyId)).id)).id;
    for (const r of ["owner", "admin", "office", "packer", "presser", "receiver"] as const)
      users[r] = (await createUser(companyId, r)).id;
  });

  it("owner, admin and office start/end; floor roles are refused but can list", async () => {
    for (const role of ["packer", "presser", "receiver"] as const) {
      expect(
        await codeOf(() =>
          call(
            router.production.maintenance.start,
            { stationId, reason: "cleaning" },
            { context: as(role) },
          ),
        ),
        role,
      ).toBe("FORBIDDEN");
      expect(
        await codeOf(() =>
          call(router.production.maintenance.end, { stationId }, { context: as(role) }),
        ),
        role,
      ).toBe("FORBIDDEN");
      expect(
        await codeOf(() =>
          call(router.production.maintenance.list, { limit: 10 }, { context: as(role) }),
        ),
        role,
      ).toBe("OK");
    }
    for (const role of ["owner", "admin", "office"] as const) {
      const r = await call(
        router.production.maintenance.start,
        { stationId, reason: "calibration" },
        { context: as(role) },
      );
      expect(r.maintenance.reason).toBe("calibration");
      const e = await call(router.production.maintenance.end, { stationId }, { context: as(role) });
      expect(e.ended).toBe(true);
    }
  });
});

describe("pick list: blank location and transfer age (B-32, B-35)", () => {
  let s: Awaited<ReturnType<typeof shop>>;
  beforeAll(async () => {
    s = await shop();
  });

  it("returns shelf and bin, transfer age, and warns past the org threshold", async () => {
    const { companyId, office, presser, blank, location } = s;
    const fresh = await s.unitsOnSheet(1, { printedDaysAgo: 3 });
    const old = await s.unitsOnSheet(1, { printedDaysAgo: 40 });
    // Printed time unknown (vendor never reported it): the received time stands in.
    const receivedOnly = await s.unitsOnSheet(1, { printedDaysAgo: null, receivedDaysAgo: 10 });

    const line = async (itemId: string) => {
      const q = await withTenant(companyId, (tx) =>
        svc.stationQueue(tx, presser, { station: "pick", limit: 50 }),
      );
      return q.items.find((i) => i.orderItemId === itemId);
    };
    // No shelf or bin yet: null, not missing.
    expect((await line(fresh.items[0]?.id ?? ""))?.blank).toMatchObject({
      shelf: null,
      binCode: null,
    });
    await withTenant(companyId, (tx) =>
      setShelf(tx, office, {
        blankVariantId: blank.id,
        locationId: location.id,
        shelf: "A-01-3",
        binCode: "BLK-M",
      }),
    );
    const f = await line(fresh.items[0]?.id ?? "");
    expect(f?.blank).toMatchObject({ shelf: "A-01-3", binCode: "BLK-M" });
    expect(f).toMatchObject({ transferAgeDays: 3, transferAgeWarning: false });
    expect(f?.transferPrintedAt).toBeTruthy();
    // The pack tote stays the order's bin, separate from the blank's bin.
    expect(f?.binCode).toBeNull();
    expect(await line(old.items[0]?.id ?? "")).toMatchObject({
      transferAgeDays: 40,
      transferAgeWarning: true,
    });
    expect(await line(receivedOnly.items[0]?.id ?? "")).toMatchObject({
      transferAgeDays: 10,
      transferAgeWarning: false,
    });

    // The org's own threshold (me.updateOrg transferAgeWarnDays) replaces the default 30.
    await withSystem((tx) =>
      tx
        .update(companies)
        .set({ settings: { transferAgeWarnDays: 5 } })
        .where(eq(companies.id, companyId)),
    );
    expect(await line(receivedOnly.items[0]?.id ?? "")).toMatchObject({
      transferAgeWarning: true,
    });

    // The press scan result carries the age and the expected blank's location; a warning doesn't block.
    const res = await press(presser, companyId, {
      transferId: old.transferIds[0] ?? "",
      blankId: blank.id,
      stationId: s.station.id,
    });
    expect(res).toMatchObject({
      ok: true,
      transferAgeDays: 40,
      transferAgeWarning: true,
      expected: { shelf: "A-01-3", binCode: "BLK-M" },
    });
  });

  it("transferAge is whole days and warns only past the threshold", () => {
    const now = new Date("2026-09-29T12:00:00Z");
    expect(transferAge(null, 30, now)).toEqual({
      transferPrintedAt: null,
      transferAgeDays: null,
      transferAgeWarning: false,
    });
    expect(transferAge(new Date(now.getTime() - 30 * DAY), 30, now)).toMatchObject({
      transferAgeDays: 30,
      transferAgeWarning: false,
    });
    expect(transferAge(new Date(now.getTime() - 31 * DAY + 1000), 30, now)).toMatchObject({
      transferAgeDays: 30,
      transferAgeWarning: false,
    });
    expect(transferAge(new Date(now.getTime() - 31 * DAY), 30, now)).toMatchObject({
      transferAgeDays: 31,
      transferAgeWarning: true,
    });
  });

  it("another shop can't see this shop's shelves", async () => {
    const other = await shop();
    const { transferIds } = await other.unitsOnSheet(1);
    const q = await withTenant(other.companyId, (tx) =>
      svc.stationQueue(tx, other.presser, { station: "pick", limit: 50 }),
    );
    expect(q.items).toHaveLength(1);
    expect(q.items[0]?.blank).toMatchObject({ shelf: null, binCode: null });
    expect(q.items[0]?.transferId).toBe(transferIds[0]);
  });
});

describe("QC fail reasons (B-35)", () => {
  it("QC fail with under_cure/cracking opens the reprint with that reason and the report counts it", async () => {
    const s = await shop();
    const { companyId, presser, blank } = s;
    const { items, transferIds } = await s.unitsOnSheet(2);
    for (const t of transferIds)
      await press(presser, companyId, {
        transferId: t,
        blankId: blank.id,
        stationId: s.station.id,
      });
    const qcFail = (id: string, reason: "under_cure" | "cracking") =>
      withTenant(companyId, (tx) =>
        svc.qc(tx, presser, {
          orderItemId: id,
          result: "fail",
          reprintReason: reason,
          blankReusable: false,
          note: null,
        }),
      );
    const a = await qcFail(items[0]?.id ?? "", "under_cure");
    expect(a.reprint?.reason).toBe("under_cure");
    const b = await qcFail(items[1]?.id ?? "", "cracking");
    expect(b.reprint?.reason).toBe("cracking");
    // A replayed fail returns the same reprint, no second row.
    const again = await qcFail(items[0]?.id ?? "", "under_cure");
    expect(again.reprint?.id).toBe(a.reprint?.id);
    const rows = await withTenant(companyId, (tx) => tx.select().from(reprints));
    expect(rows.map((r) => r.reason).sort()).toEqual(["cracking", "under_cure"]);

    const range = {
      from: new Date(Date.now() - DAY).toISOString(),
      to: new Date(Date.now() + DAY).toISOString(),
    };
    const stats = await withTenant(companyId, (tx) => svc.reprintStats(tx, presser, range));
    expect(stats.byReason).toEqual({ under_cure: 1, cracking: 1 });
    const weekly = await withTenant(companyId, (tx) =>
      svc.reprintReasonsByWeek(tx, presser, range),
    );
    expect(weekly.weeks.reduce((n, w) => n + w.total, 0)).toBe(2);
    expect(weekly.weeks.flatMap((w) => Object.keys(w.byReason)).sort()).toEqual([
      "cracking",
      "under_cure",
    ]);
  });
});
