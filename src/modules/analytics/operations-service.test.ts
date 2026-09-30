import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Channel } from "@invai/contracts";
import { call } from "@orpc/server";
import { eq, inArray, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { anonymousContext, permissionsFor } from "../../api/context";
import { router } from "../../api/router";
import { withSystem, withTenant } from "../../db/client";
import {
  companies,
  gangSheetBatches,
  gangSheets,
  orderItems,
  orderItemTransitions,
  orders,
  profitLines,
  reprints,
  scans,
  transfers,
  vendorConnections,
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
import { getCostSettings } from "../finance/service";
import { getOperations } from "./operations-service";

/*
 * T-A4 `analytics.operations` against invai_test with RLS on. One shop (A) gets a small, fully
 * known floor history in January 2026 (UTC); a second shop (B) gets its own rows that must never
 * show up in A's numbers. Expected values are worked out by hand in the comments.
 */

const FROM = new Date("2026-01-01T00:00:00Z");
const TO = new Date("2026-02-01T00:00:00Z");
const PERIOD = { from: FROM.toISOString(), to: TO.toISOString() };
const at = (day: number, hours = 0) => new Date(Date.UTC(2026, 0, day) + hours * 3_600_000);

type Shop = Awaited<ReturnType<typeof seedShop>>;

/** A shop with sheets, 40 orders (44 units), transitions, profit lines, reprints and press scans. */
async function seedShop(opts: { vendorName: string; stationName: string }) {
  const company = await createCompany();
  await withSystem((tx) =>
    tx.update(companies).set({ timezone: "UTC" }).where(eq(companies.id, company.id)),
  );
  const owner = await createUser(company.id, "owner");
  const ctx = tenantContext(company.id, owner.id, "owner");
  const location = await createLocation(company.id);
  const station = await createStation(company.id, location.id, opts.stationName);
  const quiet = await createStation(company.id, location.id, `${opts.stationName} B`);
  const connectionId = (await createConnection(company.id, "csv")).id;
  const companyId = company.id;

  // Sheets: 12 vendor sheets (cost 4000, 80 % used, 100 in) waste 800 each = 9,600; one in-house
  // sheet (1000, 50 %, 50 in) waste 500. Total 10,100; film use (12*80 + 25)/1250 = 78.8 %.
  // A building sheet and a sheet from December don't count.
  const { vendor, vendorSheet, houseSheet } = await withSystem(async (tx) => {
    const [vendor] = await tx
      .insert(vendorConnections)
      .values({ companyId, name: opts.vendorName, email: "v@example.com" })
      .returning();
    const [batch] = await tx.insert(gangSheetBatches).values({ companyId, name: "B1" }).returning();
    if (!vendor || !batch) throw new Error("seed failed");
    const sheet = (n: string, v: Partial<typeof gangSheets.$inferInsert>) => ({
      companyId,
      batchId: batch.id,
      name: n,
      createdAt: at(10),
      ...v,
    });
    const sheets = await tx
      .insert(gangSheets)
      .values([
        ...Array.from({ length: 12 }, (_, i) =>
          sheet(`V${i}`, {
            vendorConnectionId: vendor.id,
            status: "received",
            costCents: 4000,
            utilization: 0.8,
            lengthIn: 100,
          }),
        ),
        sheet("H1", { status: "printed", costCents: 1000, utilization: 0.5, lengthIn: 50 }),
        sheet("H2", { status: "building", costCents: 1000, utilization: 0.1, lengthIn: 50 }),
        sheet("OLD", {
          vendorConnectionId: vendor.id,
          status: "received",
          costCents: 9999,
          utilization: 0.1,
          lengthIn: 10,
          createdAt: new Date("2025-12-20T00:00:00Z"),
        }),
      ])
      .returning();
    return { vendor, vendorSheet: sheets[0], houseSheet: sheets[12] };
  });
  if (!vendorSheet || !houseSheet) throw new Error("sheet seed failed");

  // Orders: 30 Etsy (6 late) and 10 Amazon (1 late); orders 0-3 have two units; orders 0-9 are
  // personalized, 0-4 rush; items of orders 0-2 waited 30 h in needs_artwork (blocked > 24 h).
  const items: { id: string; orderId: string }[] = [];
  for (let i = 0; i < 40; i++) {
    const channel: Channel = i < 30 ? "etsy" : "amazon";
    const late = (i >= 20 && i < 26) || i === 39;
    const { order, items: its } = await createOrder(companyId, connectionId, {
      units: i < 4 ? 2 : 1,
      state: "shipped",
      channel,
    });
    await withSystem(async (tx) => {
      await tx
        .update(orders)
        .set({
          status: "shipped",
          shipBy: at(15),
          shippedAt: late ? at(16) : at(14),
          hasPersonalization: i < 10,
          isRush: i < 5,
        })
        .where(eq(orders.id, order.id));
      for (const it of its) {
        items.push({ id: it.id, orderId: order.id });
        // ready 2 h -> on_sheet 8 h -> transfer_in 2 h -> pressed 1 h -> packed (still there).
        const t0 = at(5);
        const steps: [string, number][] = [
          ["ready", 0],
          ["on_sheet", 2],
          ["transfer_in", 10],
          ["pressed", 12],
          ["packed", 13],
        ];
        if (i < 3) steps.unshift(["needs_artwork", -30]);
        await tx.insert(orderItemTransitions).values(
          steps.map(([to, h]) => ({
            companyId,
            orderItemId: it.id,
            orderId: order.id,
            toState: to as (typeof orderItemTransitions.$inferInsert)["toState"],
            actorKind: "system" as const,
            createdAt: new Date(t0.getTime() + h * 3_600_000),
          })),
        );
        await tx.insert(profitLines).values({
          companyId,
          orderId: order.id,
          orderItemId: it.id,
          channel,
          transferCostCents: 300,
          blankCostCents: 350,
          placedAt: at(4),
        });
      }
    });
  }

  // Reprints (in January): peel with a ruined blank on the vendor sheet at the station
  // 350 + 300/2 = 500; two misprints of one item on the in-house sheet, blank kept, 300/3 = 100
  // each; a peel with no original transfer and no station, 350 + 300/2 = 500; a cancelled one.
  // Total 1,200 over 4 reprints; rate 4/44 = 9.1 %.
  const [i0, i1, i2, i3] = items;
  if (!i0 || !i1 || !i2 || !i3) throw new Error("items missing");
  await withSystem(async (tx) => {
    const [t0, t1] = await tx
      .insert(transfers)
      .values([
        { companyId, gangSheetId: vendorSheet.id, orderItemId: i0.id, widthIn: 10, heightIn: 12 },
        { companyId, gangSheetId: houseSheet.id, orderItemId: i1.id, widthIn: 10, heightIn: 12 },
      ])
      .returning();
    await tx.insert(reprints).values([
      {
        companyId,
        orderItemId: i0.id,
        reason: "peel",
        blankConsumed: true,
        stationId: station.id,
        originalTransferId: t0?.id,
        requestedAt: at(12),
      },
      {
        companyId,
        orderItemId: i1.id,
        reason: "misprint",
        blankConsumed: false,
        stationId: station.id,
        originalTransferId: t1?.id,
        requestedAt: at(12),
      },
      {
        companyId,
        orderItemId: i1.id,
        reason: "misprint",
        blankConsumed: false,
        stationId: station.id,
        originalTransferId: t1?.id,
        requestedAt: at(13),
      },
      { companyId, orderItemId: i2.id, reason: "peel", blankConsumed: true, requestedAt: at(13) },
      {
        companyId,
        orderItemId: i3.id,
        reason: "ghosting",
        status: "cancelled",
        stationId: station.id,
        requestedAt: at(13),
      },
    ]);
  });

  // Press scans at the station: 121 ok scans 2 min apart (120 timed gaps), then one 30 min idle
  // gap (dropped) and a failed scan (ignored). The quiet station has 10 scans (9 timed: too few).
  // The labor setting defaults to 4 min, so a 2 min median (-50 %) suggests an update.
  await withSystem(async (tx) => {
    const base = at(20).getTime();
    const scan = (stationId: string, ms: number, ok = true) => ({
      companyId,
      clientScanId: crypto.randomUUID(),
      stationId,
      station: "press",
      action: "press" as const,
      transferCode: "T",
      ok,
      scannedAt: new Date(ms),
    });
    await tx
      .insert(scans)
      .values([
        ...Array.from({ length: 121 }, (_, k) => scan(station.id, base + k * 120_000)),
        scan(station.id, base + 120 * 120_000 + 30 * 60_000),
        scan(station.id, base + 120 * 120_000 + 31 * 60_000, false),
        ...Array.from({ length: 10 }, (_, k) => scan(quiet.id, base + k * 180_000)),
      ]);
  });

  return { companyId, ctx, station, quiet, vendor, items };
}

describe("analytics.operations (T-A4)", () => {
  let a: Shop;
  let b: Shop;

  beforeAll(async () => {
    a = await seedShop({ vendorName: "Vendor A", stationName: "Press A" });
    b = await seedShop({ vendorName: "Vendor B", stationName: "Press B" });
  }, 60_000);

  const ops = (s: Shop, extra: { channel?: Channel } = {}) =>
    withTenant(s.companyId, (tx) => getOperations(tx, s.ctx, { period: PERIOD, ...extra }));

  it("reprint cost by reason, station and vendor (AC-B1)", async () => {
    const r = (await ops(a)).reprintCost;
    expect(r).toMatchObject({ total: 1200, reprints: 4, itemsPressed: 44, ratePct: 9.1 });
    expect(r.byReason).toEqual([
      { key: "peel", label: "Peel", reprints: 2, cost: 1000 },
      { key: "misprint", label: "Misprint", reprints: 2, cost: 200 },
    ]);
    expect(r.byStation).toEqual([
      { key: a.station.id, label: "Press A", reprints: 3, cost: 700 },
      { key: "none", label: "No station", reprints: 1, cost: 500 },
    ]);
    expect(r.byVendor).toEqual([
      { key: a.vendor.id, label: "Vendor A", reprints: 1, cost: 500 },
      { key: "unknown", label: "Unknown", reprints: 1, cost: 500 },
      { key: "in_house", label: "In-house", reprints: 2, cost: 200 },
    ]);
  });

  it("reprint byReason keeps a stable order when two reasons tie (review r1)", async () => {
    // The underlying reprints query has no ORDER BY, so a genuine tie on cost and reprint count
    // used to come back in whatever order Postgres happened to scan the rows in (flaky ~1/3 runs).
    // "color_off" and "ghosting" both cost 0 here (no transfer, blank not consumed) with one
    // reprint each; the key tiebreak must always put "color_off" first.
    const company = await createCompany();
    await withSystem((tx) =>
      tx.update(companies).set({ timezone: "UTC" }).where(eq(companies.id, company.id)),
    );
    const owner = await createUser(company.id, "owner");
    const ctx = tenantContext(company.id, owner.id, "owner");
    const connectionId = (await createConnection(company.id, "csv")).id;
    const { items } = await createOrder(company.id, connectionId, {
      units: 2,
      state: "shipped",
      channel: "etsy",
    });
    const [x0, x1] = items;
    if (!x0 || !x1) throw new Error("items missing");
    await withSystem((tx) =>
      tx.insert(reprints).values([
        {
          companyId: company.id,
          orderItemId: x0.id,
          reason: "ghosting",
          blankConsumed: false,
          requestedAt: at(12),
        },
        {
          companyId: company.id,
          orderItemId: x1.id,
          reason: "color_off",
          blankConsumed: false,
          requestedAt: at(12),
        },
      ]),
    );
    for (let i = 0; i < 4; i++) {
      const o = await withTenant(company.id, (tx) => getOperations(tx, ctx, { period: PERIOD }));
      expect(o.reprintCost.byReason).toEqual([
        { key: "color_off", label: "Color off", reprints: 1, cost: 0 },
        { key: "ghosting", label: "Ghosting", reprints: 1, cost: 0 },
      ]);
    }
  });

  it("film waste and film use, total and by vendor (AC-B1)", async () => {
    const f = (await ops(a)).filmWaste;
    expect(f).toMatchObject({ sheets: 13, wasteCost: 10100, filmUsePct: 78.8 });
    expect(f.byVendor).toEqual([
      { key: a.vendor.id, label: "Vendor A", sheets: 12, wasteCost: 9600, filmUsePct: 80 },
      // One sheet: below the 10-sheet minimum, so no percent.
      { key: "in_house", label: "In-house", sheets: 1, wasteCost: 500, filmUsePct: null },
    ]);
  });

  it("waits per state and the bottleneck step", async () => {
    const o = await ops(a);
    const w = Object.fromEntries(o.waits.map((x) => [x.state, x]));
    expect(w.ready).toMatchObject({ entries: 44, medianHours: 2, p90Hours: 2, stillWaiting: 0 });
    expect(w.on_sheet).toMatchObject({ entries: 44, medianHours: 8, stillWaiting: 0 });
    expect(w.pressed).toMatchObject({ entries: 44, medianHours: 1 });
    // Every unit is still packed: counted as waiting, no median.
    expect(w.packed).toMatchObject({ entries: 44, medianHours: null, stillWaiting: 44 });
    // needs_artwork: 6 entries (3 orders of two units) -> below 30, no median.
    expect(w.needs_artwork).toMatchObject({ entries: 6, medianHours: null, stillWaiting: 0 });
    expect(o.bottleneckStep).toBe("on_sheet");
  });

  it("measured press minutes per station and the labor-setting suggestion (AC-B2)", async () => {
    const p = (await ops(a)).pressMinutesPerUnit;
    expect(p).toEqual([
      {
        stationId: a.station.id,
        stationName: "Press A",
        timedUnits: 120,
        medianMinutes: 2,
        p75Minutes: 2,
        unitsPerActiveHour: 30,
        settingMinutes: 4,
        suggestUpdateLaborSetting: true,
      },
      {
        // Under 100 timed units: "not enough scans yet", no number and no suggestion.
        stationId: a.quiet.id,
        stationName: "Press A B",
        timedUnits: 9,
        medianMinutes: null,
        p75Minutes: null,
        unitsPerActiveHour: null,
        settingMinutes: 4,
        suggestUpdateLaborSetting: false,
      },
    ]);
  });

  it("no suggestion when the measured median is within 25 % of the setting", async () => {
    const shop = await seedShop({ vendorName: "V", stationName: "Press C" });
    await withTenant(shop.companyId, (tx) => getCostSettings(tx, shop.ctx));
    await withSystem((tx) =>
      tx.execute(
        sql`update cost_settings set labor_minutes_per_item = 2.4 where company_id = ${shop.companyId}`,
      ),
    );
    const p = (await ops(shop)).pressMinutesPerUnit[0];
    expect(p).toMatchObject({
      medianMinutes: 2,
      settingMinutes: 2.4,
      suggestUpdateLaborSetting: false,
    });
  }, 60_000);

  it("late drivers: counts on every cut, rates only from 30 orders, associations only (AC-B3)", async () => {
    const o = await ops(a);
    const l = o.lateDrivers;
    expect(l).toMatchObject({ shippedOrders: 40, lateOrders: 7, latePct: 17.5 });
    const cut = (driver: string, value: string) =>
      l.rows.find((r) => r.driver === driver && r.value === value);
    expect(cut("channel", "etsy")).toMatchObject({
      label: "Etsy",
      shippedOrders: 30,
      lateOrders: 6,
      latePct: 20,
    });
    // Under 30 orders: counts only.
    expect(cut("channel", "amazon")).toMatchObject({
      shippedOrders: 10,
      lateOrders: 1,
      latePct: null,
    });
    expect(cut("personalized", "no")).toMatchObject({
      shippedOrders: 30,
      lateOrders: 7,
      latePct: 23.3,
    });
    expect(cut("personalized", "yes")).toMatchObject({
      shippedOrders: 10,
      lateOrders: 0,
      latePct: null,
    });
    expect(cut("rush", "yes")).toMatchObject({ shippedOrders: 5, latePct: null });
    expect(cut("multiUnit", "yes")).toMatchObject({ shippedOrders: 4, latePct: null });
    expect(cut("blockedOver24h", "yes")).toMatchObject({ shippedOrders: 3, lateOrders: 0 });
    expect(cut("blockedOver24h", "no")).toMatchObject({
      shippedOrders: 37,
      lateOrders: 7,
      latePct: 18.9,
    });
    expect(l.rows.every((r) => r.shippedOrders >= r.lateOrders)).toBe(true);
    // Associations, never causes: no copy in the response says "cause".
    expect(JSON.stringify(o)).not.toMatch(/caus/i);
  });

  it("channel filter narrows order-based blocks; sheets have no channel", async () => {
    const o = await ops(a, { channel: "amazon" });
    expect(o.lateDrivers).toMatchObject({ shippedOrders: 10, lateOrders: 1, latePct: null });
    expect(o.reprintCost).toMatchObject({ reprints: 0, total: 0, itemsPressed: 10, ratePct: null });
    expect(o.filmWaste.sheets).toBe(13);
    // Scans carry no order item in this fixture, so no unit belongs to Amazon.
    expect(o.pressMinutesPerUnit).toEqual([]);
  });

  it("hasEnoughHistory is false for a brand-new shop, with per-metric nulls too (AC-B/C-screen1)", async () => {
    const fresh = await createCompany();
    const owner = await createUser(fresh.id, "owner");
    const ctx = tenantContext(fresh.id, owner.id, "owner");
    const o = await withTenant(fresh.id, (tx) => getOperations(tx, ctx, { period: PERIOD }));
    expect(o.hasEnoughHistory).toBe(false);
    expect(o.reprintCost).toMatchObject({ total: 0, reprints: 0, ratePct: null, byReason: [] });
    expect(o.filmWaste).toMatchObject({ sheets: 0, wasteCost: 0, filmUsePct: null });
    expect(o).toMatchObject({ waits: [], bottleneckStep: null, pressMinutesPerUnit: [] });
    expect(o.lateDrivers).toMatchObject({ shippedOrders: 0, latePct: null, rows: [] });
    expect((await ops(a)).hasEnoughHistory).toBe(true);
  });

  it("is a pure read: calling it twice gives the same numbers", async () => {
    const one = await ops(a);
    const two = await ops(a);
    expect({ ...two, computedAt: one.computedAt }).toEqual(one);
  });

  it("rejects an empty or over-long period with PERIOD_INVALID", async () => {
    await expect(
      withTenant(a.companyId, (tx) =>
        getOperations(tx, a.ctx, { period: { from: PERIOD.to, to: PERIOD.from } }),
      ),
    ).rejects.toMatchObject({ code: "PERIOD_INVALID" });
    await expect(
      withTenant(a.companyId, (tx) =>
        getOperations(tx, a.ctx, {
          period: { from: "2024-01-01T00:00:00Z", to: "2026-01-01T00:00:00Z" },
        }),
      ),
    ).rejects.toMatchObject({ code: "PERIOD_INVALID" });
  });

  it("tenant isolation: A's numbers never include B's rows, and B's ids resolve to nothing in A (AC-E4)", async () => {
    const oa = await ops(a);
    const ob = await ops(b);
    // Same fixture shape, so each shop sees exactly its own totals, not the sum.
    expect(oa.reprintCost.total).toBe(1200);
    expect(ob.reprintCost.total).toBe(1200);
    expect(oa.filmWaste.sheets).toBe(13);
    expect(oa.lateDrivers.shippedOrders).toBe(40);
    const json = JSON.stringify(oa);
    for (const id of [b.station.id, b.quiet.id, b.vendor.id]) expect(json).not.toContain(id);
    expect(json).not.toMatch(/Vendor B|Press B/);
    // Under A's tenant, B's rows are invisible even by id (RLS).
    const seen = await withTenant(a.companyId, (tx) =>
      tx
        .select()
        .from(orderItems)
        .where(
          inArray(
            orderItems.id,
            b.items.map((i) => i.id),
          ),
        ),
    );
    expect(seen).toEqual([]);
  });

  it("the owner reaches the service through the router", async () => {
    const owner = await createUser(a.companyId, "owner");
    const context = {
      ...anonymousContext(new Headers(), null),
      sessionKind: "user" as const,
      user: { id: owner.id, name: owner.name, email: owner.email },
      companyId: a.companyId,
      orgType: "shop" as const,
      role: "owner" as const,
      permissions: permissionsFor("owner"),
    };
    const o = await call(router.analytics.operations, { period: PERIOD }, { context });
    expect(o).toMatchObject({ hasEnoughHistory: true, bottleneckStep: "on_sheet" });
    expect(o.reprintCost.total).toBe(1200);
  });

  it("roles without finance.read get FORBIDDEN through the router (AC-E5)", async () => {
    for (const role of ["designer", "presser", "packer", "receiver"] as const) {
      const user = await createUser(a.companyId, role);
      const context = {
        ...anonymousContext(new Headers(), null),
        sessionKind: "user" as const,
        user: { id: user.id, name: user.name, email: user.email },
        companyId: a.companyId,
        orgType: "shop" as const,
        role,
        permissions: permissionsFor(role),
      };
      await expect(
        call(router.analytics.operations, { period: PERIOD }, { context }),
      ).rejects.toMatchObject({ code: "FORBIDDEN", data: { permission: "finance.read" } });
    }
  });
});

/*
 * AC-B1 parity: the service's reprint cost by reason and film waste equal the data-analyst's
 * metric SQL (`invai-docs/metrics/sql/*.sql`) run on the same data. The docs repo sits next to
 * this one locally; where it isn't checked out (a lone backend CI checkout) the parity check is
 * skipped and the hand-computed numbers above still hold.
 */
const SQL_DIR = resolve(import.meta.dirname, "../../../../invai-docs/metrics/sql");
const haveSql = existsSync(resolve(SQL_DIR, "reprint_cost.sql"));

function metricSql(file: string) {
  return readFileSync(resolve(SQL_DIR, file), "utf8")
    .replaceAll(":'from'", "'2026-01-01'")
    .replaceAll(":'to'", "'2026-02-01'");
}

describe.skipIf(!haveSql)("parity with the metric SQL (AC-B1)", () => {
  let shop: Shop;
  let slug: string;

  beforeAll(async () => {
    shop = await seedShop({ vendorName: "Parity V", stationName: "Parity P" });
    const [c] = await withSystem((tx) =>
      tx.select({ slug: companies.slug }).from(companies).where(eq(companies.id, shop.companyId)),
    );
    slug = c?.slug as string;
  }, 60_000);

  it("reprint_cost.sql: reprints and cost per reason, items pressed and rate", async () => {
    const res = await withSystem((tx) => tx.execute(sql.raw(metricSql("reprint_cost.sql"))));
    const mine = res.rows.filter((r) => r.slug === slug);
    const ops = await withTenant(shop.companyId, (tx) =>
      getOperations(tx, shop.ctx, { period: PERIOD }),
    );
    expect(mine.length).toBe(ops.reprintCost.byReason.length);
    for (const r of mine) {
      const row = ops.reprintCost.byReason.find((x) => x.key === r.reason);
      expect(row).toMatchObject({ reprints: Number(r.reprints), cost: Number(r.cost_cents) });
      expect(ops.reprintCost.itemsPressed).toBe(Number(r.items_pressed));
    }
    const reprints = mine.reduce((n, r) => n + Number(r.reprints), 0);
    expect(ops.reprintCost.reprints).toBe(reprints);
    expect(ops.reprintCost.ratePct).toBe(
      Math.round((1000 * reprints) / Number(mine[0]?.items_pressed)) / 10,
    );
  });

  it("film_waste_cost.sql: sheets, waste and film use", async () => {
    const res = await withSystem((tx) => tx.execute(sql.raw(metricSql("film_waste_cost.sql"))));
    const r = res.rows.find((x) => x.slug === slug);
    const ops = await withTenant(shop.companyId, (tx) =>
      getOperations(tx, shop.ctx, { period: PERIOD }),
    );
    expect(ops.filmWaste).toMatchObject({
      sheets: Number(r?.sheets),
      wasteCost: Number(r?.film_waste_cents),
      filmUsePct: Number(r?.film_use_pct),
    });
  });
});
