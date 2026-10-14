import { beforeAll, describe, expect, it, vi } from "vitest";
import * as client from "../../src/db/client";
import { db, systemPool } from "../../src/db/client";
import { getProfit } from "../../src/modules/finance/service";
import { COLUMNS, normalizeRow, type QueryName, type Row, readQuerySql, runQuery } from "./queries";
import { isSeedSlug, parseNow, parseWindow, type Report, runReport } from "./run";
import {
  addProfitLines,
  addRefunds,
  addReprints,
  addSheets,
  addTransitions,
  hours,
  type LineSpec,
  localMidnight,
  makeOrders,
  makeShop,
  type OrderSpec,
  type Shop,
} from "./testkit";

/*
 * Acceptance tests for spec analytics-first-queries.md AC2, AC3, AC5-AC7, AC9, AC12, AC13 on
 * hand-built companies. Every company has a non-UTC time zone and rows at local midnight on each
 * window edge, so a UTC window or an inclusive end goes red.
 */

vi.mock("../../src/db/client", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../src/db/client")>();
  return {
    ...mod,
    withTenantReadOnly: vi.fn(mod.withTenantReadOnly),
    withTenant: vi.fn(mod.withTenant),
    withSystem: mod.withSystem,
  };
});

const FROM = "2026-05-04";
const TO = "2026-06-04";

const keys = (r: Row) => Object.keys(r).filter((k) => k !== "company_id");
const rowsOf = (rep: Report, name: QueryName) => rep.queries[name] ?? [];
const find = (rows: Row[], match: Partial<Row>) =>
  rows.find((r) => Object.entries(match).every(([k, v]) => r[k] === v));

async function window(tz: string) {
  return { fromAt: await localMidnight(FROM, tz), toAt: await localMidnight(TO, tz) };
}

/* -------------------------------- late rate (AC3) -------------------------------- */

describe("late_rate (AC2, AC3)", () => {
  const TZ = "America/Los_Angeles";
  let shop: Shop;
  let rep: Report;

  beforeAll(async () => {
    shop = await makeShop(TZ);
    const { fromAt, toAt } = await window(TZ);
    const day = 86_400_000;
    const specs: OrderSpec[] = [];
    // 38 regular shipped orders; indexes 5, 17, 29 shipped after ship-by. The first 12 are Etsy.
    for (let i = 0; i < 38; i++) {
      const shippedAt = new Date(fromAt.getTime() + (i % 28) * day + hours(10));
      const late = i === 5 || i === 17 || i === 29;
      specs.push({
        channel: i < 12 ? ("etsy" as const) : ("csv" as const),
        shippedAt,
        shipBy: new Date(shippedAt.getTime() + (late ? -hours(1) : day)),
        personalized: i === 3,
      });
    }
    // E1 exactly at local start (in), E2 before local end but after UTC end (in).
    specs.push({ shippedAt: fromAt, shipBy: new Date(fromAt.getTime() + day) });
    const e2 = new Date(`${TO}T03:00:00Z`);
    specs.push({ shippedAt: e2, shipBy: new Date(e2.getTime() + day) });
    // X1 before local start but after UTC start (late), X2 exactly at local end, X3 cancelled.
    const x1 = new Date(`${FROM}T03:00:00Z`);
    specs.push({ shippedAt: x1, shipBy: new Date(x1.getTime() - hours(1)) });
    specs.push({ shippedAt: toAt, shipBy: new Date(toAt.getTime() + day) });
    const x3 = new Date(fromAt.getTime() + 5 * day);
    specs.push({
      shippedAt: x3,
      shipBy: new Date(x3.getTime() - hours(2)),
      status: "cancelled",
    });
    const made = await makeOrders(shop, specs);
    // regular #1 waited 30 h in needs_mapping (blocked), regular #2 waited 23 h (not blocked)
    const at = (i: number) => specs[i]?.shippedAt as Date;
    const m1 = made[1];
    const m2 = made[2];
    if (!m1 || !m2) throw new Error("missing orders");
    await addTransitions(shop, [
      {
        orderId: m1.orderId,
        itemId: m1.itemIds[0] as string,
        toState: "needs_mapping",
        at: new Date(at(1).getTime() - hours(72)),
      },
      {
        orderId: m1.orderId,
        itemId: m1.itemIds[0] as string,
        toState: "ready",
        at: new Date(at(1).getTime() - hours(42)),
      },
      {
        orderId: m2.orderId,
        itemId: m2.itemIds[0] as string,
        toState: "needs_artwork",
        at: new Date(at(2).getTime() - hours(72)),
      },
      {
        orderId: m2.orderId,
        itemId: m2.itemIds[0] as string,
        toState: "ready",
        at: new Date(at(2).getTime() - hours(49)),
      },
    ]);
    rep = await runReport({ slug: shop.slug, from: FROM, to: TO, queries: ["late_rate"] });
  });

  it("returns 3 late of 40 shipped = 7.5 and does not count the cancelled order or the edge rows", () => {
    const all = find(rowsOf(rep, "late_rate"), { driver: "all", value: "all" });
    expect(all).toMatchObject({ shipped: 40, late: 3, late_rate_pct: 7.5 });
  });

  it("gives counts and a null percent for cuts under 30 shipped", () => {
    const rows = rowsOf(rep, "late_rate");
    expect(find(rows, { driver: "channel", value: "etsy" })).toMatchObject({
      shipped: 12,
      late: 1,
      late_rate_pct: null,
    });
    expect(find(rows, { driver: "channel", value: "csv" })).toMatchObject({
      shipped: 28,
      late: 2,
      late_rate_pct: null,
    });
    expect(find(rows, { driver: "personalized", value: "true" })).toMatchObject({ shipped: 1 });
  });

  it("flags only the order that waited more than 24 h in a blocked state", () => {
    const rows = rowsOf(rep, "late_rate");
    expect(find(rows, { driver: "blocked_over_24h", value: "true" })).toMatchObject({ shipped: 1 });
    expect(find(rows, { driver: "blocked_over_24h", value: "false" })).toMatchObject({
      shipped: 39,
    });
  });

  it("returns the pinned columns, with the shop id on every row", () => {
    for (const r of rowsOf(rep, "late_rate")) {
      expect(keys(r)).toEqual([...COLUMNS.late_rate]);
      expect(r.company_id).toBe(shop.id);
    }
    expect(keys(rowsOf(rep, "late_rate")[0] as Row)).toContain("late_rate_pct");
  });
});

/* --------------------------------- film use (AC5) --------------------------------- */

describe("film_use (AC2, AC5)", () => {
  const TZ = "America/New_York";
  let shop12: Shop;
  let shop9: Shop;
  const lengths = [10, 22, 40, 100, 15, 60, 33, 75, 18, 90, 25, 50];
  const utils = [0.55, 0.9, 0.62, 0.95, 0.7, 0.88, 0.5, 0.93, 0.81, 0.97, 0.6, 0.85];
  const statuses = ["sent", "acknowledged", "printing", "printed", "shipped", "received"] as const;

  const qualifying = async (n: number) => {
    const w = await window(TZ);
    const day = 86_400_000;
    return Array.from({ length: n }, (_, i) => ({
      status: statuses[i % statuses.length] as (typeof statuses)[number],
      utilization: utils[i] as number,
      lengthIn: lengths[i] as number,
      costCents: 1000 + i * 137,
      createdAt:
        i === 0
          ? w.fromAt // exactly local start: in
          : i === 1
            ? new Date(`${TO}T02:00:00Z`) // local evening before the end: in, but after the UTC end
            : new Date(w.fromAt.getTime() + (i + 1) * day),
    }));
  };

  beforeAll(async () => {
    shop12 = await makeShop(TZ);
    shop9 = await makeShop(TZ);
    const w = await window(TZ);
    const base = await qualifying(12);
    const noise = [
      // not sent yet or dead: never counted, whatever the fill
      ...(["building", "ready", "failed", "cancelled"] as const).map((status) => ({
        status,
        utilization: 0.05,
        lengthIn: 300,
        costCents: 99_999,
        createdAt: new Date(w.fromAt.getTime() + 3 * 86_400_000),
      })),
      // sent, but created one millisecond before the local start / exactly at the local end
      {
        status: "sent" as const,
        utilization: 0.05,
        lengthIn: 300,
        costCents: 99_999,
        createdAt: new Date(w.fromAt.getTime() - 1),
      },
      {
        status: "sent" as const,
        utilization: 0.05,
        lengthIn: 300,
        costCents: 99_999,
        createdAt: w.toAt,
      },
      // sent, in the UTC window but before the local start
      {
        status: "sent" as const,
        utilization: 0.05,
        lengthIn: 500,
        costCents: 99_999,
        createdAt: new Date(`${FROM}T02:00:00Z`),
      },
    ];
    await addSheets(shop12, [...base, ...noise]);
    await addSheets(shop9, (await qualifying(9)).slice(0, 9));
  });

  it("is the length-weighted fill over 12 sent sheets and sums the waste in cents", async () => {
    const rep = await runReport({ slug: shop12.slug, from: FROM, to: TO, queries: ["film_use"] });
    const rows = rowsOf(rep, "film_use");
    expect(rows).toHaveLength(1);
    const sumL = lengths.reduce((a, b) => a + b, 0);
    const expected =
      Math.round((1000 * lengths.reduce((a, l, i) => a + l * (utils[i] as number), 0)) / sumL) / 10;
    const waste = Math.round(
      lengths.reduce((a, _l, i) => a + (1000 + i * 137) * (1 - (utils[i] as number)), 0),
    );
    const cost = lengths.reduce((a, _l, i) => a + 1000 + i * 137, 0);
    expect(rows[0]).toMatchObject({ sheets: 12, film_cost_cents: cost, film_waste_cents: waste });
    expect(rows[0]?.film_use_pct).toBeCloseTo(expected, 1);
    // the unweighted mean of the 12 utilizations is a different number
    const unweighted = (100 * utils.reduce((a, b) => a + b, 0)) / utils.length;
    expect(Math.abs((rows[0]?.film_use_pct as number) - unweighted)).toBeGreaterThan(1);
    expect(Number.isInteger(rows[0]?.film_waste_cents)).toBe(true);
  });

  it("gives counts, cents and a null percent for 9 sheets", async () => {
    const rep = await runReport({ slug: shop9.slug, from: FROM, to: TO, queries: ["film_use"] });
    const row = rowsOf(rep, "film_use")[0];
    expect(row).toMatchObject({ sheets: 9, film_use_pct: null });
    expect(row?.film_cost_cents).toBeGreaterThan(0);
    expect(keys(row as Row)).toEqual([...COLUMNS.film_use]);
  });
});

/* ------------------------------- reprint rate (AC6) ------------------------------- */

describe("reprint (AC2, AC6)", () => {
  const TZ = "Asia/Tokyo";
  let shop100: Shop;
  let shop29: Shop;
  let fromAt: Date;
  let toAt: Date;

  beforeAll(async () => {
    ({ fromAt, toAt } = await window(TZ));
    shop100 = await makeShop(TZ);
    shop29 = await makeShop(TZ);
    const day = 86_400_000;
    const pressedAt = (i: number) => new Date(fromAt.getTime() + (i % 25) * day + hours(5));
    const made = await makeOrders(
      shop100,
      Array.from({ length: 102 }, () => ({})),
    );
    const item = (i: number) => made[i]?.itemIds[0] as string;
    const order = (i: number) => made[i]?.orderId as string;
    const press = (i: number, at: Date) => ({
      orderId: order(i),
      itemId: item(i),
      toState: "pressed" as const,
      at,
    });
    await addTransitions(shop100, [
      ...Array.from({ length: 100 }, (_, i) => press(i, pressedAt(i))),
      press(0, new Date(pressedAt(0).getTime() + hours(1))), // pressed twice: still one item
      press(1, new Date(pressedAt(1).getTime() + hours(1))),
      press(100, toAt), // exactly the local end: out
      press(101, new Date(fromAt.getTime() - 1)), // just before the local start: out
    ]);
    const inWindow = new Date(fromAt.getTime() + 10 * day);
    await addReprints(shop100, [
      { itemId: item(0), reason: "peel", blankConsumed: true, at: fromAt }, // exactly local start: in
      { itemId: item(1), reason: "peel", blankConsumed: false, at: inWindow },
      { itemId: item(2), reason: "misprint", blankConsumed: true, at: inWindow },
      { itemId: item(3), reason: "ghosting", blankConsumed: true, at: inWindow },
      { itemId: item(1), reason: "peel", status: "cancelled", blankConsumed: true, at: inWindow },
      { itemId: item(6), reason: "misprint", blankConsumed: true, at: toAt }, // exactly local end: out
      {
        itemId: item(7),
        reason: "misprint",
        blankConsumed: true,
        at: new Date(fromAt.getTime() - 1),
      },
    ]);
    const line = (i: number, transfer: number, blank: number): LineSpec => ({
      orderId: order(i),
      itemId: item(i),
      channel: "csv",
      placedAt: fromAt,
      transferCostCents: transfer,
      blankCostCents: blank,
    });
    await addProfitLines(shop100, [line(0, 400, 1000), line(1, 300, 800), line(2, 500, 700)]);

    const made29 = await makeOrders(
      shop29,
      Array.from({ length: 29 }, () => ({})),
    );
    await addTransitions(
      shop29,
      made29.map((m, i) => ({
        orderId: m.orderId,
        itemId: m.itemIds[0] as string,
        toState: "pressed" as const,
        at: pressedAt(i),
      })),
    );
    await addReprints(shop29, [
      {
        itemId: made29[0]?.itemIds[0] as string,
        reason: "peel",
        blankConsumed: true,
        at: inWindow,
      },
    ]);
  });

  it("is 4 reprints over 100 distinct items pressed = 4.0, without the cancelled reprint", async () => {
    const rep = await runReport({ slug: shop100.slug, from: FROM, to: TO, queries: ["reprint"] });
    const rows = rowsOf(rep, "reprint");
    expect(find(rows, { reason: "all" })).toMatchObject({
      reprints: 4,
      items_pressed: 100,
      rate_pct: 4,
    });
    expect(find(rows, { reason: "peel" })).toMatchObject({ reprints: 2, rate_pct: 2 });
    expect(find(rows, { reason: "misprint" })).toMatchObject({ reprints: 1, rate_pct: 1 });
    for (const r of rows) {
      expect(keys(r)).toEqual([...COLUMNS.reprint]);
      expect(Number.isInteger(r.cost_cents)).toBe(true);
    }
  });

  it("costs a reprint as the transfer split over its prints plus the blank when consumed", async () => {
    const rep = await runReport({ slug: shop100.slug, from: FROM, to: TO, queries: ["reprint"] });
    const rows = rowsOf(rep, "reprint");
    // item 0: 1000 + 400 / 2; item 1: blank kept, 300 / 2 (its cancelled reprint is not a print);
    // item 2: 700 + 500 / 2; item 3 has no profit line: 0
    expect(find(rows, { reason: "peel" })?.cost_cents).toBe(1200 + 150);
    expect(find(rows, { reason: "misprint" })?.cost_cents).toBe(950);
    expect(find(rows, { reason: "ghosting" })?.cost_cents).toBe(0);
    expect(find(rows, { reason: "all" })?.cost_cents).toBe(2300);
  });

  it("gives counts and a null percent for 29 items pressed", async () => {
    const rep = await runReport({ slug: shop29.slug, from: FROM, to: TO, queries: ["reprint"] });
    expect(find(rowsOf(rep, "reprint"), { reason: "all" })).toMatchObject({
      reprints: 1,
      items_pressed: 29,
      rate_pct: null,
    });
  });
});

/* -------------------------------- profit per order (AC7) -------------------------------- */

describe("profit (AC2, AC7)", () => {
  const TZ = "Pacific/Auckland";
  let shop: Shop;
  let rep: Report;
  let period: { from: string; to: string };
  let estimatedUnits = 0;
  const NET_GARBAGE = 12_345; // net_cents is display-only: a query that sums it is wrong

  beforeAll(async () => {
    shop = await makeShop(TZ);
    const { fromAt, toAt } = await window(TZ);
    period = { from: fromAt.toISOString(), to: toAt.toISOString() };
    const day = 86_400_000;
    // 16 csv orders x 2 units (one unit is a cancel reversal) + 9 etsy orders x 1 unit = 40 units
    const specs = [
      ...Array.from({ length: 16 }, (_, i) => ({
        channel: "csv" as const,
        units: 2,
        placedAt: new Date(fromAt.getTime() + (i % 20) * day + hours(3)),
      })),
      ...Array.from({ length: 9 }, (_, i) => ({
        channel: "etsy" as const,
        placedAt: new Date(fromAt.getTime() + (i % 20) * day + hours(4)),
      })),
      // edges: placed exactly at the local end (out), one millisecond before the start (out)
      { channel: "csv" as const, placedAt: toAt },
      { channel: "csv" as const, placedAt: new Date(fromAt.getTime() - 1) },
      // placed before the window, refunded inside it
      { channel: "csv" as const, placedAt: new Date(fromAt.getTime() - 10 * day) },
      // placed in the window, items but no profit line yet
      { channel: "csv" as const, placedAt: new Date(fromAt.getTime() + day) },
    ];
    const made = await makeOrders(shop, specs);
    const lines: LineSpec[] = [];
    let n = 0;
    for (let o = 0; o < 25; o++) {
      const m = made[o];
      const spec = specs[o];
      if (!m || !spec) continue;
      m.itemIds.forEach((itemId, u) => {
        const reversal = o === 3 && u === 1;
        const estimated = n % 3 === 0 ? ["blankCost"] : n % 3 === 1 ? ["labelCost", "adsCost"] : [];
        if (!reversal && estimated.length > 0) estimatedUnits += 1;
        lines.push({
          orderId: m.orderId,
          itemId,
          channel: spec.channel,
          placedAt: spec.placedAt,
          revenueCents: 2500 + ((n * 37) % 500),
          channelFeesCents: 200 + (n % 5) * 10,
          blankCostCents: 600 + (n % 7) * 5,
          transferCostCents: 300 + (n % 4) * 20,
          labelCostCents: 450,
          packagingCostCents: 40 + (n % 3),
          laborCostCents: 150,
          adsCostCents: n % 2 === 0 ? 60 : 0,
          refundsCents: reversal ? 250 : 0,
          netCents: NET_GARBAGE,
          estimated,
        });
        n += 1;
      });
    }
    // lines outside the window, with a huge revenue that would move every total
    for (const o of [25, 26]) {
      const m = made[o];
      const spec = specs[o];
      lines.push({
        orderId: m?.orderId as string,
        itemId: m?.itemIds[0] as string,
        channel: "csv",
        placedAt: spec?.placedAt as Date,
        revenueCents: 99_999,
        netCents: NET_GARBAGE,
      });
    }
    const early = made[27];
    lines.push({
      orderId: early?.orderId as string,
      itemId: early?.itemIds[0] as string,
      channel: "csv",
      placedAt: specs[27]?.placedAt as Date,
      revenueCents: 2000,
      netCents: NET_GARBAGE,
    });
    await addProfitLines(shop, lines);
    const inside = new Date(fromAt.getTime() + 6 * day);
    await addRefunds(shop, [
      {
        orderId: made[0]?.orderId as string,
        channel: "csv",
        amountCents: 500,
        feeRecoveredCents: 40,
        at: inside,
      },
      {
        orderId: early?.orderId as string,
        channel: "csv",
        amountCents: 700,
        feeRecoveredCents: 56,
        at: inside,
      },
      {
        orderId: made[1]?.orderId as string,
        channel: "csv",
        amountCents: 900,
        feeRecoveredCents: 72,
        at: inside,
        voided: true,
      },
      {
        orderId: made[2]?.orderId as string,
        channel: "csv",
        amountCents: 650,
        feeRecoveredCents: 52,
        at: toAt,
      },
      {
        orderId: made[20]?.orderId as string,
        channel: "etsy",
        amountCents: 300,
        feeRecoveredCents: 24,
        at: inside,
      },
    ]);
    rep = await runReport({ slug: shop.slug, from: FROM, to: TO, queries: ["profit"] });
  });

  it("equals getProfit from the cost buckets, per channel and in total, as integer cents", async () => {
    const summary = await client.withTenantReadOnly(shop.id, (tx) =>
      getProfit(tx, { companyId: shop.id }, { period, dimension: "channel" }),
    );
    const rows = rowsOf(rep, "profit");
    expect(rows.map((r) => r.channel)).toEqual(["all", "csv", "etsy"]);
    for (const row of summary.rows) {
      const mine = find(rows, { channel: row.key }) as Row;
      const cm1 = row.revenue - row.channelFees - row.blankCost - row.transferCost;
      const cm2 = cm1 - row.labelCost - row.packagingCost - row.laborCost - row.refunds;
      expect(mine).toMatchObject({
        orders: row.orders,
        units: row.units,
        revenue_cents: row.revenue,
        cm1_cents: cm1,
        cm2_cents: cm2,
        cm3_cents: row.net,
      });
      expect(row.net).not.toBe(NET_GARBAGE * row.units);
    }
    const all = find(rows, { channel: "all" }) as Row;
    expect(all.cm3_cents).toBe(summary.totals.net);
    expect(all).toMatchObject({ units: 40, estimated_units: estimatedUnits });
    for (const r of rows) {
      for (const k of ["revenue_cents", "cm1_cents", "cm2_cents", "cm3_cents"])
        expect(Number.isInteger(r[k])).toBe(true);
      expect(keys(r)).toEqual([...COLUMNS.profit]);
    }
  });

  it("gives a percent from 30 units and a null percent under 30; profit per order is cm3 / orders", () => {
    const rows = rowsOf(rep, "profit");
    const csv = find(rows, { channel: "csv" }) as Row;
    const etsy = find(rows, { channel: "etsy" }) as Row;
    const all = find(rows, { channel: "all" }) as Row;
    expect(csv.units).toBe(31);
    expect(etsy).toMatchObject({ units: 9, cm3_pct: null });
    expect(typeof csv.cm3_pct).toBe("number");
    expect(csv.cm3_pct).toBeCloseTo((100 * Number(csv.cm3_cents)) / Number(csv.revenue_cents), 1);
    for (const r of [csv, etsy, all]) {
      expect(r.profit_per_order_cents).toBe(
        Math.floor(Number(r.cm3_cents) / Number(r.orders) + 0.5),
      );
    }
  });

  it("counts the order without a profit line instead of dropping it", () => {
    const all = find(rowsOf(rep, "profit"), { channel: "all" });
    expect(all?.orders_without_profit_line).toBe(1);
  });
});

/* ------------------------- tenant scope, empty window, header ------------------------- */

describe("tenant scope and empty windows (AC9, AC12, AC13)", () => {
  const TZ = "Europe/Madrid";
  let a: Shop;
  let b: Shop;
  let empty: Shop;

  beforeAll(async () => {
    a = await makeShop(TZ);
    b = await makeShop(TZ);
    empty = await makeShop(TZ);
    const { fromAt } = await window(TZ);
    const ship = (shop: Shop, n: number) =>
      makeOrders(
        shop,
        Array.from({ length: n }, (_, i) => ({
          shippedAt: new Date(fromAt.getTime() + hours(24 + i)),
          shipBy: new Date(fromAt.getTime() + hours(100)),
          placedAt: new Date(fromAt.getTime() + hours(i)),
        })),
      );
    const madeA = await ship(a, 3);
    const madeB = await ship(b, 5);
    for (const [shop, made] of [
      [a, madeA],
      [b, madeB],
    ] as const) {
      await addProfitLines(
        shop,
        made.map((m, i) => ({
          orderId: m.orderId,
          itemId: m.itemIds[0] as string,
          channel: "csv" as const,
          placedAt: new Date(fromAt.getTime() + hours(i)),
          revenueCents: shop === a ? 1000 : 7000,
        })),
      );
    }
  });

  it("reports only the requested company's numbers and ids", async () => {
    const rep = await runReport({ slug: a.slug, from: FROM, to: TO });
    const text = JSON.stringify(rep);
    expect(text).not.toContain(b.id);
    expect(text).not.toContain(b.slug);
    for (const rows of Object.values(rep.queries))
      for (const r of rows ?? []) expect(r.company_id).toBe(a.id);
    expect(find(rowsOf(rep, "late_rate"), { driver: "all" })).toMatchObject({ shipped: 3 });
    expect(find(rowsOf(rep, "profit"), { channel: "all" })).toMatchObject({
      orders: 3,
      revenue_cents: 3000,
    });
  });

  it("counts nothing, without an error, when no company is set on the connection (A2.6)", async () => {
    const params = { companyId: a.id, from: FROM, to: TO };
    // precondition: the same window with the company set is not empty
    const withCompany = await runReport({
      slug: a.slug,
      from: FROM,
      to: TO,
      queries: ["late_rate"],
    });
    expect(find(rowsOf(withCompany, "late_rate"), { driver: "all" })).toMatchObject({ shipped: 3 });
    // currentCompanyId is NULL here, so RLS hides every row; the query itself must not fail
    const rows = await db.transaction((tx) => runQuery(tx, "late_rate", params));
    expect(find(rows, { driver: "all" })).toMatchObject({
      shipped: 0,
      late: 0,
      late_rate_pct: null,
    });
  });

  it("returns one totals row per query, zero counts and null percents, for an empty window", async () => {
    const rep = await runReport({ slug: empty.slug, from: FROM, to: TO });
    expect(rowsOf(rep, "late_rate")).toEqual([
      expect.objectContaining({
        driver: "all",
        value: "all",
        shipped: 0,
        late: 0,
        late_rate_pct: null,
      }),
    ]);
    expect(rowsOf(rep, "overdue_open")).toEqual([
      expect.objectContaining({
        channel: "all",
        overdue_orders: 0,
        on_hold_orders: 0,
        partly_shipped_orders: 0,
        open_units: 0,
      }),
    ]);
    expect(rowsOf(rep, "film_use")).toEqual([
      expect.objectContaining({
        sheets: 0,
        film_cost_cents: 0,
        film_waste_cents: 0,
        film_use_pct: null,
      }),
    ]);
    expect(rowsOf(rep, "reprint")).toEqual([
      expect.objectContaining({
        reason: "all",
        reprints: 0,
        items_pressed: 0,
        rate_pct: null,
        cost_cents: 0,
      }),
    ]);
    expect(rowsOf(rep, "profit")).toEqual([
      expect.objectContaining({
        channel: "all",
        orders: 0,
        units: 0,
        revenue_cents: 0,
        cm3_cents: 0,
        cm3_pct: null,
        profit_per_order_cents: null,
      }),
    ]);
  });

  it("uses the read-only helper, never the plain tenant helper or the owner pool", async () => {
    const readOnly = vi.mocked(client.withTenantReadOnly);
    const plain = vi.mocked(client.withTenant);
    const connect = vi.spyOn(systemPool, "connect");
    readOnly.mockClear();
    plain.mockClear();
    await runReport({ slug: a.slug, from: FROM, to: TO });
    expect(readOnly).toHaveBeenCalledTimes(1);
    expect(readOnly).toHaveBeenCalledWith(a.id, expect.any(Function));
    expect(plain).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    connect.mockRestore();
  });

  it("labels the demo shop and scale-profile shops SEED, other shops not", async () => {
    const demo = await makeShop(TZ, "desert-bloom-tees");
    const scale = await makeShop(TZ, "seed-scale-small-1");
    const dm = await runReport({ slug: demo.slug, from: FROM, to: TO, queries: ["film_use"] });
    const sc = await runReport({ slug: scale.slug, from: FROM, to: TO, queries: ["film_use"] });
    const other = await runReport({ slug: empty.slug, from: FROM, to: TO, queries: ["film_use"] });
    expect(dm.header.data_label).toBe("SEED");
    expect(sc.header.data_label).toBe("SEED");
    expect(other.header.data_label).toBe("NOT_SEED");
    expect(isSeedSlug("seed-scale")).toBe(false);
  });

  it("rejects dates that are not real, not YYYY-MM-DD, or not in order", () => {
    expect(() => parseWindow("2026-02-30", "2026-03-05")).toThrow();
    expect(() => parseWindow("2026-5-4", "2026-06-04")).toThrow();
    expect(() => parseWindow("2026-06-04", "2026-06-04")).toThrow();
    expect(() => parseWindow("2026-06-05", "2026-06-04")).toThrow();
    expect(parseWindow("2026-05-04", "2026-06-04")).toEqual({
      from: "2026-05-04",
      to: "2026-06-04",
    });
    expect(readQuerySql("film_use")).toContain(":company_id");
  });
});

/* ---------------------------- overdue open (AC4, T-55-2) ---------------------------- */

describe("overdue_open (spec AC4; definition overdue_open.md)", () => {
  const TZ = "America/Los_Angeles";
  const NOW = "2026-05-20T10:00:00Z";
  const nowAt = new Date(NOW);
  const at = (ms: number) => new Date(nowAt.getTime() + ms);
  const day = 86_400_000;
  let shop: Shop;

  beforeAll(async () => {
    shop = await makeShop(TZ);
    const { fromAt } = await window(TZ);
    await makeOrders(shop, [
      // counted: plain overdue, one second before now, an order with its first unit at the start edge
      { channel: "etsy", shipBy: at(-day) },
      { channel: "etsy", shipBy: at(-1000) },
      { channel: "csv", shipBy: fromAt, units: 1 },
      // held: counted, in on_hold_orders; a held order with a shipped unit is not also partly shipped
      { channel: "etsy", shipBy: at(-day), status: "on_hold" },
      {
        channel: "amazon",
        shipBy: at(-day),
        status: "on_hold",
        units: 2,
        itemStates: ["shipped", "packed"],
      },
      // partly shipped: counted once at order grain; only the 2 unshipped units are open
      {
        channel: "amazon",
        shipBy: at(-2 * day),
        status: "partially_shipped",
        units: 3,
        itemStates: ["shipped", "packed", "packed"],
      },
      // two units, one cancelled: one open unit
      {
        channel: "csv",
        shipBy: at(-day),
        status: "in_production",
        units: 2,
        itemStates: ["pressed", "cancelled"],
      },
      // not counted: ship-by exactly now, in the future, shipped, delivered, cancelled, before the window
      { channel: "etsy", shipBy: nowAt },
      { channel: "etsy", shipBy: at(1000) },
      { channel: "etsy", shipBy: at(-day), status: "shipped", shippedAt: at(-day / 2) },
      { channel: "etsy", shipBy: at(-day), status: "delivered", shippedAt: at(-day / 2) },
      { channel: "etsy", shipBy: at(-day), status: "cancelled" },
      { channel: "etsy", shipBy: new Date(fromAt.getTime() - 1) },
    ]);
  });

  const overdue = async (s: Shop, extra: { from?: string; to?: string; now?: string } = {}) =>
    rowsOf(
      await runReport({
        slug: s.slug,
        from: extra.from ?? FROM,
        to: extra.to ?? TO,
        queries: ["overdue_open"],
        now: extra.now ?? NOW,
      }),
      "overdue_open",
    );

  it("counts each open order once under its channel, with the pinned columns and the shop id", async () => {
    const rows = await overdue(shop);
    expect(rows.map((r) => keys(r))).toEqual(rows.map(() => COLUMNS.overdue_open));
    expect(rows).toEqual([
      expect.objectContaining({
        channel: "all",
        overdue_orders: 7,
        on_hold_orders: 2,
        partly_shipped_orders: 1,
        open_units: 8,
      }),
      expect.objectContaining({
        channel: "amazon",
        overdue_orders: 2,
        on_hold_orders: 1,
        partly_shipped_orders: 1,
        open_units: 3,
      }),
      expect.objectContaining({
        channel: "csv",
        overdue_orders: 2,
        on_hold_orders: 0,
        partly_shipped_orders: 0,
        open_units: 2,
      }),
      expect.objectContaining({
        channel: "etsy",
        overdue_orders: 3,
        on_hold_orders: 1,
        partly_shipped_orders: 0,
        open_units: 3,
      }),
    ]);
    for (const r of rows) expect(r.company_id).toBe(shop.id);
  });

  it("pins now: ship-by exactly now is not overdue, one second before is", async () => {
    // a window that holds only the two orders around now
    const one = await makeShop(TZ);
    await makeOrders(one, [{ shipBy: at(-1000) }, { shipBy: nowAt }, { shipBy: at(1000) }]);
    expect(await overdue(one)).toEqual([
      expect.objectContaining({ channel: "all", overdue_orders: 1 }),
      expect.objectContaining({ channel: "csv", overdue_orders: 1 }),
    ]);
    // moving now back to the same instant as the first order drops it
    const earlier = await overdue(one, { now: at(-1000).toISOString() });
    expect(earlier).toEqual([expect.objectContaining({ channel: "all", overdue_orders: 0 })]);
  });

  it("uses the database clock when no now is given: a past ship-by counts, a future one does not", async () => {
    const real = await makeShop(TZ);
    const t = Date.now();
    await makeOrders(real, [{ shipBy: new Date(t - day) }, { shipBy: new Date(t + 3600_000) }]);
    const rows = rowsOf(
      await runReport({
        slug: real.slug,
        from: "2020-01-01",
        to: "2100-01-01",
        queries: ["overdue_open"],
      }),
      "overdue_open",
    );
    expect(find(rows, { channel: "all" })).toMatchObject({ overdue_orders: 1 });
  });

  it("cuts the window by the shop's local midnights: the end is exclusive, the start inclusive", async () => {
    const kolkata = "Asia/Kolkata";
    const edge = await makeShop(kolkata);
    const from = await localMidnight(FROM, kolkata);
    const to = await localMidnight("2026-05-10", kolkata);
    await makeOrders(edge, [
      { shipBy: from }, // in
      { shipBy: new Date(to.getTime() - 1) }, // in
      { shipBy: to }, // out: window end is exclusive
      { shipBy: new Date(from.getTime() - 1) }, // out
      // 2026-05-09 20:00 UTC is 2026-05-10 01:30 in Kolkata: a UTC-day window would count it
      { shipBy: new Date("2026-05-09T20:00:00Z") },
    ]);
    const rows = await overdue(edge, { to: "2026-05-10" });
    expect(find(rows, { channel: "all" })).toMatchObject({ overdue_orders: 2, open_units: 2 });
  });

  it("clips the window end to now: a to date in the future adds nothing after now", async () => {
    const rows = await overdue(shop, { to: "2099-01-01" });
    expect(find(rows, { channel: "all" })).toMatchObject({ overdue_orders: 7 });
  });

  it("reports only this shop's orders and counts nothing when no company is set (A2.6)", async () => {
    const other = await makeShop(TZ);
    await makeOrders(other, [{ shipBy: at(-day), channel: "tiktok" }]);
    const rows = await overdue(shop);
    expect(JSON.stringify(rows)).not.toContain(other.id);
    expect(find(rows, { channel: "tiktok" })).toBeUndefined();
    // precondition above: non-zero with the company set; now bare connection, no company
    const bare = await db.transaction((tx) =>
      runQuery(tx, "overdue_open", { companyId: shop.id, from: FROM, to: TO, now: NOW }),
    );
    expect(bare).toEqual([
      expect.objectContaining({
        channel: "all",
        overdue_orders: 0,
        on_hold_orders: 0,
        partly_shipped_orders: 0,
        open_units: 0,
      }),
    ]);
  });

  it("reads no buyer column: every string cell is a channel name or the shop id", async () => {
    const rows = await overdue(shop);
    for (const r of rows)
      for (const [k, v] of Object.entries(r))
        if (typeof v === "string") expect(["channel", "company_id"]).toContain(k);
  });

  it("parseNow takes an ISO instant with a zone and nothing else", () => {
    expect(parseNow("2026-05-20T10:00:00Z")).toBe("2026-05-20T10:00:00Z");
    expect(parseNow("2026-05-20T12:00:00.123456+02:00")).toBe("2026-05-20T12:00:00.123456+02:00");
    for (const bad of [
      "2026-05-20",
      "2026-05-20T10:00:00",
      "now",
      "2026-13-20T10:00:00Z",
      "",
      "2026-05-20 10:00:00Z",
    ])
      expect(() => parseNow(bad), bad).toThrow();
  });
});

/* ------------------------- cents are exact above the int range (A2.5) ------------------------- */

describe("cents above 2,147,483,647 stay exact", () => {
  const TZ = "America/Los_Angeles";
  let shop: Shop;
  let rep: Report;

  beforeAll(async () => {
    shop = await makeShop(TZ);
    const { fromAt } = await window(TZ);
    await addSheets(
      shop,
      Array.from({ length: 12 }, (_, i) => ({
        status: "sent" as const,
        utilization: 0.5,
        lengthIn: 10,
        costCents: 200_000_000,
        createdAt: new Date(fromAt.getTime() + hours(24 + i)),
      })),
    );
    const made = await makeOrders(
      shop,
      [0, 1].map((i) => ({
        placedAt: new Date(fromAt.getTime() + hours(i)),
        shipBy: new Date(fromAt.getTime() + hours(100)),
      })),
    );
    await addProfitLines(
      shop,
      made.map((m, i) => ({
        orderId: m.orderId,
        itemId: m.itemIds[0] as string,
        channel: "csv" as const,
        placedAt: new Date(fromAt.getTime() + hours(i)),
        revenueCents: 1_500_000_000,
      })),
    );
    rep = await runReport({ slug: shop.slug, from: FROM, to: TO, queries: ["film_use", "profit"] });
  });

  it("film cost and waste sum past 2^31 as exact numbers", () => {
    const row = rowsOf(rep, "film_use")[0];
    expect(row?.film_cost_cents).toBe(2_400_000_000);
    expect(row?.film_waste_cents).toBe(1_200_000_000);
  });

  it("profit revenue, CM and profit per order sum past 2^31 as exact numbers", () => {
    const row = find(rowsOf(rep, "profit"), { channel: "all" });
    expect(row).toMatchObject({
      revenue_cents: 3_000_000_000,
      cm1_cents: 3_000_000_000,
      cm3_cents: 3_000_000_000,
      profit_per_order_cents: 1_500_000_000,
    });
  });

  it("normalizeRow turns int8 strings into numbers and refuses an unsafe integer", () => {
    expect(normalizeRow({ a_cents: "2400000000", n: 3, channel: "etsy" })).toEqual({
      a_cents: 2_400_000_000,
      n: 3,
      channel: "etsy",
    });
    expect(normalizeRow({ a_cents: "-5" })).toEqual({ a_cents: -5 });
    expect(() => normalizeRow({ a_cents: "9007199254740993" })).toThrow();
    expect(() => normalizeRow({ a_cents: "1e3" })).toThrow();
    expect(() => normalizeRow({ a_cents: "12.5" })).toThrow();
  });
});
