import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { call } from "@orpc/server";
import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { anonymousContext, permissionsFor } from "../../api/context";
import { router } from "../../api/router";
import { withSystem, withTenant } from "../../db/client";
import {
  blankVariants,
  companies,
  inventoryMovements,
  inventorySettings,
  orderItems,
  purchaseOrderLines,
  purchaseOrders,
  stockLevels,
  suppliers,
} from "../../db/schema";
import {
  createCompany,
  createConnection,
  createLocation,
  createOrder,
  createUser,
  tenantContext,
} from "../../test/fixtures";
import { type SizeShare, splitBySizeCurve } from "../inventory/reorder";
import { loadSettings } from "../inventory/service";
import { inventoryHealth, supplierTrends } from "./inventory-service";

/*
 * T-A5 `analytics.inventoryHealth` / `analytics.supplierTrends` against invai_test with RLS on.
 * One shop (A) gets a small, fully known stock and PO history; a second shop (B) gets its own
 * rows that must never show up in A's numbers. Expected values are worked out by hand.
 */

const at = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

type Shop = Awaited<ReturnType<typeof seedShop>>;

async function seedShop(opts: { supplierName?: string } = {}) {
  const company = await createCompany();
  const companyId = company.id;
  await withSystem((tx) =>
    tx
      .update(companies)
      .set({ timezone: "UTC", createdAt: at(2025, 1, 1) })
      .where(eq(companies.id, companyId)),
  );
  const owner = await createUser(companyId, "owner");
  const ctx = tenantContext(companyId, owner.id, "owner");
  const location = await createLocation(companyId);

  const bv = (over: Partial<typeof blankVariants.$inferInsert>) => ({
    companyId,
    brand: "Gildan",
    style: "Heavy Cotton Tee",
    styleCode: "G64000",
    color: "Sand",
    colorCode: "SND",
    size: "M",
    sizeCode: "M",
    sku: `SKU-${Math.random().toString(36).slice(2)}`,
    supplier: "ssactivewear" as const,
    costCents: 300,
    ...over,
  });

  // G64000 Sand: S/M/L/XL, 40 units sold in the window, L badly under-stocked (AC-C1).
  const sandRows = await withSystem((tx) =>
    tx
      .insert(blankVariants)
      .values([
        bv({ size: "S", sizeCode: "S", sku: `S-${companyId}` }),
        bv({ size: "M", sizeCode: "M", sku: `M-${companyId}` }),
        bv({ size: "L", sizeCode: "L", sku: `L-${companyId}` }),
        bv({ size: "XL", sizeCode: "XL", sku: `XL-${companyId}` }),
      ])
      .returning(),
  );
  const [sandS, sandM, sandL, sandXL] = sandRows;
  if (!sandS || !sandM || !sandL || !sandXL) throw new Error("seed failed");
  const sandMId = sandM.id;

  // G500 Navy: below the 30-unit minimum sample (shown, not omitted, AC-C1).
  const navyRows = await withSystem((tx) =>
    tx
      .insert(blankVariants)
      .values([
        bv({
          styleCode: "G500",
          color: "Navy",
          colorCode: "NVY",
          size: "M",
          sizeCode: "M",
          sku: `NM-${companyId}`,
        }),
        bv({
          styleCode: "G500",
          color: "Navy",
          colorCode: "NVY",
          size: "L",
          sizeCode: "L",
          sku: `NL-${companyId}`,
        }),
      ])
      .returning(),
  );
  const [navyM, navyL] = navyRows;
  if (!navyM || !navyL) throw new Error("seed failed");

  // A dead variant: stock, never consumed (AC-C2).
  const [dead] = await withSystem((tx) =>
    tx
      .insert(blankVariants)
      .values(
        bv({
          styleCode: "G200",
          color: "Black",
          colorCode: "BLK",
          size: "M",
          sizeCode: "M",
          sku: `D-${companyId}`,
          costCents: 500,
        }),
      )
      .returning(),
  );
  if (!dead) throw new Error("seed failed");

  // A stockout variant: sold, open, no stock anywhere.
  const [outOfStock] = await withSystem((tx) =>
    tx
      .insert(blankVariants)
      .values(
        bv({
          styleCode: "G640",
          color: "Red",
          colorCode: "RED",
          size: "S",
          sizeCode: "S",
          sku: `OOS-${companyId}`,
        }),
      )
      .returning(),
  );
  if (!outOfStock) throw new Error("seed failed");

  await withSystem((tx) =>
    tx.insert(stockLevels).values([
      { companyId, blankVariantId: sandS.id, locationId: location.id, onHand: 20, available: 20 },
      { companyId, blankVariantId: sandMId, locationId: location.id, onHand: 20, available: 20 },
      { companyId, blankVariantId: sandL.id, locationId: location.id, onHand: 3, available: 3 },
      { companyId, blankVariantId: sandXL.id, locationId: location.id, onHand: 17, available: 17 },
      { companyId, blankVariantId: navyM.id, locationId: location.id, onHand: 5, available: 5 },
      { companyId, blankVariantId: navyL.id, locationId: location.id, onHand: 5, available: 5 },
      { companyId, blankVariantId: dead.id, locationId: location.id, onHand: 15, available: 15 },
      {
        companyId,
        blankVariantId: outOfStock.id,
        locationId: location.id,
        onHand: 0,
        available: 0,
      },
    ]),
  );

  // Consumption in the trailing 90-day window: 50 units of the Sand M variant at 300 cents, plus
  // a token 1 unit of every other stocked variant so only "dead" is flagged dead stock (its only
  // consumption, below, sits outside the window).
  await withSystem((tx) =>
    tx.insert(inventoryMovements).values([
      {
        companyId,
        blankVariantId: sandMId,
        locationId: location.id,
        kind: "consume",
        qty: -50,
        createdAt: new Date(Date.now() - 5 * 86_400_000),
      },
      ...[sandS.id, sandL.id, sandXL.id, navyM.id, navyL.id].map((blankVariantId) => ({
        companyId,
        blankVariantId,
        locationId: location.id,
        kind: "consume" as const,
        qty: -1,
        createdAt: new Date(Date.now() - 5 * 86_400_000),
      })),
    ]),
  );
  // An older consumption of the "dead" variant, outside the window: still "dead" today.
  await withSystem((tx) =>
    tx.insert(inventoryMovements).values({
      companyId,
      blankVariantId: dead.id,
      locationId: location.id,
      kind: "consume",
      qty: -3,
      createdAt: new Date(Date.now() - 200 * 86_400_000),
    }),
  );

  const connectionId = (await createConnection(companyId, "csv")).id;
  const sold = async (blankVariantId: string, n: number) => {
    for (let i = 0; i < n; i++) {
      const { items } = await createOrder(companyId, connectionId, { units: 1 });
      const item = items[0];
      if (!item) throw new Error("seed failed");
      await withSystem((tx) =>
        tx
          .update(orderItems)
          .set({ blankVariantId, state: "packed" })
          .where(eq(orderItems.id, item.id)),
      );
    }
  };
  await sold(sandS.id, 5);
  await sold(sandM.id, 5);
  await sold(sandL.id, 27);
  await sold(sandXL.id, 3);
  await sold(navyM.id, 6);
  await sold(navyL.id, 4);

  // Two open (unpressed) units sold on the out-of-stock blank: stockout exposure.
  const stockoutItems: string[] = [];
  for (const priceCents of [2500, 3000]) {
    const { items } = await createOrder(companyId, connectionId, { units: 1 });
    const item = items[0];
    if (!item) throw new Error("seed failed");
    await withSystem((tx) =>
      tx
        .update(orderItems)
        .set({
          blankVariantId: outOfStock.id,
          state: "ready",
          unitPriceCents: priceCents,
          shipBy: at(2026, 1, 10),
        })
        .where(eq(orderItems.id, item.id)),
    );
    stockoutItems.push(item.id);
  }

  // Supplier account name (falls back to the static label when absent, tested separately).
  await withSystem((tx) =>
    tx
      .insert(suppliers)
      .values({ companyId, supplier: "ssactivewear", name: opts.supplierName ?? "S&S Activewear" }),
  );

  // POs: three received in January (median lead 12d, avg unit cost 307.5), one in February
  // (below the 3-PO minimum, so no lead-time number of its own). Global median lead: 11d, 8d
  // from the setting's default 3d -> suggest updating it.
  async function po(
    status: "received" | "cancelled",
    submittedAt: Date,
    leadDays: number | null,
    qty: number,
    unitCostCents: number,
  ) {
    const [row] = await withSystem((tx) =>
      tx
        .insert(purchaseOrders)
        .values({
          companyId,
          supplier: "ssactivewear",
          locationId: location.id,
          poNo: `PO-${companyId}-${Math.random().toString(36).slice(2)}`,
          status,
          submittedAt,
          receivedAt:
            leadDays === null ? null : new Date(submittedAt.getTime() + leadDays * 86_400_000),
        })
        .returning(),
    );
    if (!row) throw new Error("seed failed");
    await withSystem((tx) =>
      tx.insert(purchaseOrderLines).values({
        companyId,
        purchaseOrderId: row.id,
        blankVariantId: sandMId,
        qty,
        unitCostCents,
      }),
    );
    return row;
  }
  await po("received", at(2026, 1, 5), 10, 100, 300);
  await po("received", at(2026, 1, 10), 12, 50, 310);
  await po("received", at(2026, 1, 15), 14, 50, 320);
  await po("received", at(2026, 2, 5), 8, 40, 330);
  await po("cancelled", at(2026, 1, 20), null, 999, 1);

  return {
    companyId,
    ctx,
    location,
    ids: {
      sandS: sandS.id,
      sandM: sandM.id,
      sandL: sandL.id,
      sandXL: sandXL.id,
      navyM: navyM.id,
      navyL: navyL.id,
      dead: dead.id,
      outOfStock: outOfStock.id,
    },
    stockoutItems,
  };
}

let a: Shop;
let b: Shop;

beforeAll(async () => {
  a = await seedShop({ supplierName: "S&S Activewear" });
  b = await seedShop({ supplierName: "Vendor B" });
}, 60_000);

const health = (shop: Shop, days = 90) =>
  withTenant(shop.companyId, (tx) => inventoryHealth(tx, shop.ctx, { days }));

const trends = (shop: Shop) =>
  withTenant(shop.companyId, (tx) =>
    supplierTrends(tx, shop.ctx, {
      period: { from: "2026-01-01T00:00:00Z", to: "2026-03-01T00:00:00Z" },
    }),
  );

describe("analytics.inventoryHealth", () => {
  it("on-hand value, consumed cost and turns", async () => {
    const h = await health(a);
    // on hand: 20+20+3+17 (sand, 60) + 5+5 (navy, 10) + 15 (dead) + 0 (oos) = 85; value:
    // sand 60*300 + navy 10*300 + dead 15*500 = 18000 + 3000 + 7500 = 28500.
    expect(h.onHandUnits).toBe(85);
    expect(h.onHandValue).toBe(28_500);
    // consumed: 50 (sandM) + 1 each of sandS/sandL/sandXL/navyM/navyL, all at 300 cents.
    expect(h.consumedCost).toBe(16_500);
    // turns = 16500 * 365/90 / 28500, one decimal.
    expect(h.turns).toBe(2.3);
  });

  it("dead stock: variant with stock and no consumption in the window (AC-C2)", async () => {
    const h = await health(a);
    expect(h.deadStock).toMatchObject({ variants: 1, value: 7500 });
    expect(h.deadStock.rows[0]).toMatchObject({
      blankVariantId: a.ids.dead,
      onHand: 15,
      value: 7500,
    });
    expect(h.deadStock.rows[0]?.lastConsumedAt).not.toBeNull();
  });

  it("size-mix gap: L under-stocked, a group below 30 units is shown, not omitted (AC-C1)", async () => {
    const h = await health(a);
    const sand = h.sizeMixGaps.find((g) => g.styleCode === "G64000" && g.color === "Sand");
    expect(sand).toMatchObject({ unitsSold: 40, onHand: 60, hasEnoughUnits: true });
    const l = sand?.sizes.find((s) => s.size === "L");
    expect(l).toMatchObject({ unitsSold: 27, onHand: 3, salesSharePct: 67.5, stockSharePct: 5 });
    expect(l?.gapPts).toBeCloseTo(5 - 67.5, 1);
    expect(l?.gapPts).toBeLessThan(-10); // clearly under-stocked

    const navy = h.sizeMixGaps.find((g) => g.styleCode === "G500" && g.color === "Navy");
    expect(navy).toMatchObject({ unitsSold: 10, hasEnoughUnits: false });
    expect(navy?.sizes.every((s) => s.gapPts === null)).toBe(true);
  });

  it("stockout exposure: open units on a blank with no stock anywhere", async () => {
    const h = await health(a);
    expect(h.stockoutExposure).toMatchObject({ units: 2, blanks: 1, revenueAtRisk: 5500 });
    expect(h.stockoutExposure.earliestShipBy).not.toBeNull();
    expect(h.stockoutExposure.rows[0]).toMatchObject({
      blankVariantId: a.ids.outOfStock,
      units: 2,
      revenueAtRisk: 5500,
    });
  });

  it("hasEnoughHistory is false for a brand-new shop (AC-B/C-screen1)", async () => {
    const fresh = await createCompany();
    const owner = await createUser(fresh.id, "owner");
    const ctx = tenantContext(fresh.id, owner.id, "owner");
    const h = await withTenant(fresh.id, (tx) => inventoryHealth(tx, ctx, { days: 90 }));
    expect(h.hasEnoughHistory).toBe(false);
    expect(h.turns).toBeNull();
    expect(h.onHandUnits).toBe(0);
    expect(h.deadStock).toMatchObject({ variants: 0, value: 0, rows: [] });
    expect(h.sizeMixGaps).toEqual([]);
    expect((await health(a)).hasEnoughHistory).toBe(true);
  });

  it("is a pure read: calling it twice gives the same numbers", async () => {
    const one = await health(a);
    const two = await health(a);
    expect({ ...two, asOf: one.asOf }).toEqual(one);
  });

  it("tenant isolation: A's numbers never include B's rows (AC-E4)", async () => {
    const ha = await health(a);
    const hb = await health(b);
    expect(ha.onHandUnits).toBe(hb.onHandUnits); // same seed shape
    const json = JSON.stringify(ha);
    for (const id of Object.values(b.ids)) expect(json).not.toContain(id);
  });

  it("the owner reaches the service through the router; a role without finance.read gets FORBIDDEN (AC-E5)", async () => {
    const owner = await createUser(a.companyId, "owner");
    const ownerCtx = {
      ...anonymousContext(new Headers(), null),
      sessionKind: "user" as const,
      user: { id: owner.id, name: owner.name, email: owner.email },
      companyId: a.companyId,
      orgType: "shop" as const,
      role: "owner" as const,
      permissions: permissionsFor("owner"),
    };
    const h = await call(router.analytics.inventoryHealth, { days: 90 }, { context: ownerCtx });
    expect(h.onHandUnits).toBe(85);

    const designer = await createUser(a.companyId, "designer");
    const context = {
      ...ownerCtx,
      user: { id: designer.id, name: designer.name, email: designer.email },
      role: "designer" as const,
      permissions: permissionsFor("designer"),
    };
    await expect(
      call(router.analytics.inventoryHealth, { days: 90 }, { context }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      data: { permission: "finance.read" },
    });
  });
});

describe("analytics.supplierTrends", () => {
  it("unit cost by month and median lead days (AC-C5)", async () => {
    const t = await trends(a);
    expect(t.rows).toHaveLength(2);
    const jan = t.rows.find((r) => r.month === "2026-01");
    expect(jan).toMatchObject({
      supplier: "ssactivewear",
      supplierName: "S&S Activewear",
      styleCode: "G64000",
      purchaseOrders: 3,
      units: 200,
      avgUnitCost: 307.5,
      medianLeadDays: 12,
    });
    const feb = t.rows.find((r) => r.month === "2026-02");
    // Below the 3-received minimum for its own month: no lead-time number.
    expect(feb).toMatchObject({
      purchaseOrders: 1,
      units: 40,
      avgUnitCost: 330,
      medianLeadDays: null,
    });
  });

  it("suggests updating the lead-time setting when measured differs by more than 3 days (AC-C5)", async () => {
    const t = await trends(a);
    expect(t.leadTimeSettingDays).toBe(3); // inventory_settings default
    expect(t.measuredLeadDays).toBe(11); // median of 10, 12, 14, 8
    expect(t.suggestUpdateLeadTime).toBe(true);
  });

  it("uses the shop's own lead-time setting when one is saved", async () => {
    // A row already exists by this point (earlier tests read it, lazily creating the default);
    // update it in place rather than insert, so a duplicate-key conflict can't hide the write.
    await withTenant(a.companyId, (tx) => loadSettings(tx, a.companyId));
    await withSystem((tx) =>
      tx
        .update(inventorySettings)
        .set({ leadTimeDays: 11 })
        .where(eq(inventorySettings.companyId, a.companyId)),
    );
    const t = await trends(a);
    expect(t.leadTimeSettingDays).toBe(11);
    expect(t.suggestUpdateLeadTime).toBe(false);
    await withSystem((tx) =>
      tx
        .update(inventorySettings)
        .set({ leadTimeDays: 3 })
        .where(eq(inventorySettings.companyId, a.companyId)),
    );
  });

  it("rejects an empty or over-long period with PERIOD_INVALID", async () => {
    await expect(
      withTenant(a.companyId, (tx) =>
        supplierTrends(tx, a.ctx, {
          period: { from: "2026-03-01T00:00:00Z", to: "2026-01-01T00:00:00Z" },
        }),
      ),
    ).rejects.toMatchObject({ code: "PERIOD_INVALID" });
  });

  it("tenant isolation and FORBIDDEN through the router (AC-E4, AC-E5)", async () => {
    const ta = await trends(a);
    const tb = await trends(b);
    expect(ta.rows.length).toBe(tb.rows.length);
    for (const r of ta.rows) expect(tb.rows).not.toContainEqual(r);

    const presser = await createUser(a.companyId, "presser");
    const context = {
      ...anonymousContext(new Headers(), null),
      sessionKind: "user" as const,
      user: { id: presser.id, name: presser.name, email: presser.email },
      companyId: a.companyId,
      orgType: "shop" as const,
      role: "presser" as const,
      permissions: permissionsFor("presser"),
    };
    await expect(
      call(
        router.analytics.supplierTrends,
        { period: { from: "2026-01-01T00:00:00Z", to: "2026-03-01T00:00:00Z" } },
        { context },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN", data: { permission: "finance.read" } });
  });
});

/*
 * Parity with the data-analyst's own metric SQL (AC-C2, AC-C5). The docs repo sits next to this
 * one locally; where it isn't checked out the parity check is skipped and the hand-computed
 * numbers above still hold.
 */
const SQL_DIR = resolve(import.meta.dirname, "../../../../invai-docs/metrics/sql");
const haveSql = existsSync(resolve(SQL_DIR, "blank_stock_health.sql"));

function readSql(file: string): string {
  return readFileSync(resolve(SQL_DIR, file), "utf8");
}

describe.skipIf(!haveSql)("parity with the metric SQL", () => {
  let slug: string;

  beforeAll(async () => {
    const [c] = await withSystem((tx) =>
      tx.select({ slug: companies.slug }).from(companies).where(eq(companies.id, a.companyId)),
    );
    slug = c?.slug as string;
  });

  it("blank_stock_health.sql: on-hand value, turns and dead stock", async () => {
    const q = readSql("blank_stock_health.sql").replaceAll(":'days'", "90");
    const res = await withSystem((tx) => tx.execute(sql.raw(q)));
    const r = res.rows.find((x) => x.slug === slug);
    const h = await health(a);
    expect(Number(r?.on_hand_units)).toBe(h.onHandUnits);
    expect(Number(r?.on_hand_value_cents)).toBe(h.onHandValue);
    expect(Number(r?.consumed_cost_cents)).toBe(h.consumedCost);
    expect(Number(r?.dead_variants)).toBe(h.deadStock.variants);
    expect(Number(r?.dead_stock_value_cents)).toBe(h.deadStock.value);
  });

  it("size_mix_gap.sql: sales share, stock share and the gap for the Sand L row", async () => {
    const q = readSql("size_mix_gap.sql").replaceAll(":'days'", "90");
    const res = await withSystem((tx) => tx.execute(sql.raw(q)));
    const r = res.rows.find((x) => x.slug === slug && x.style_code === "G64000" && x.size === "L");
    const h = await health(a);
    const l = h.sizeMixGaps
      .find((g) => g.styleCode === "G64000")
      ?.sizes.find((s) => s.size === "L");
    expect(r).toBeTruthy();
    expect(Number(r?.sales_share_pct)).toBe(l?.salesSharePct);
    expect(Number(r?.stock_share_pct)).toBe(l?.stockSharePct);
    expect(Number(r?.gap_pts)).toBeCloseTo(l?.gapPts ?? Number.NaN, 1);
  });

  it("supplier_trends.sql: unit cost and lead days by month", async () => {
    const q = readSql("supplier_trends.sql")
      .replaceAll(":'from'", "'2026-01-01'")
      .replaceAll(":'to'", "'2026-03-01'");
    const res = await withSystem((tx) => tx.execute(sql.raw(q)));
    const mine = res.rows.filter((x) => x.slug === slug);
    const t = await trends(a);
    expect(mine.length).toBe(t.rows.length);
    for (const r of mine) {
      const row = t.rows.find((x) => x.month === r.month);
      expect(row).toMatchObject({ purchaseOrders: Number(r.units) === 40 ? 1 : 3 });
      expect(row?.avgUnitCost).toBe(Number(r.avg_unit_cost_cents));
      if (row?.medianLeadDays !== null)
        expect(row?.medianLeadDays).toBe(Number(r.median_lead_days));
    }
  });
});

/*
 * AC-C1/AC-C3: the size-split reorder suggestion (`inventory/reorder.ts` `splitBySizeCurve`,
 * added by this card). Pure math, no database; tested here because this card's owned test paths
 * are `analytics/*.test.ts`, not `inventory/reorder.test.ts` (owned by the inventory module's
 * other cards). It only proposes quantities -- nothing here writes, submits or creates a PO.
 */
describe("splitBySizeCurve (inventory/reorder.ts, size-split suggestion)", () => {
  it("splits proportionally to the trailing sales curve, not the stock curve", () => {
    // Sand's sales curve from the AC-C1 fixture above: S 12.5%, M 12.5%, L 67.5%, XL 7.5%.
    const shares: SizeShare[] = [
      { blankVariantId: "s", size: "S", salesShare: 0.125 },
      { blankVariantId: "m", size: "M", salesShare: 0.125 },
      { blankVariantId: "l", size: "L", salesShare: 0.675 },
      { blankVariantId: "xl", size: "XL", salesShare: 0.075 },
    ];
    const lines = splitBySizeCurve(40, shares);
    expect(lines.find((l) => l.size === "L")?.qty).toBe(27); // 0.675 * 40
    expect(lines.reduce((sum, l) => sum + l.qty, 0)).toBe(40);
  });

  it("sums to the exact total even when the shares don't divide evenly (largest remainder)", () => {
    const shares: SizeShare[] = [
      { blankVariantId: "s", size: "S", salesShare: 1 },
      { blankVariantId: "m", size: "M", salesShare: 1 },
      { blankVariantId: "l", size: "L", salesShare: 1 },
    ];
    for (const total of [1, 2, 4, 7, 10, 97, 100]) {
      const lines = splitBySizeCurve(total, shares);
      expect(lines.reduce((sum, l) => sum + l.qty, 0)).toBe(total);
      // Even shares: no line more than one unit apart from the others.
      const qtys = lines.map((l) => l.qty);
      expect(Math.max(...qtys) - Math.min(...qtys)).toBeLessThanOrEqual(1);
    }
  });

  it("splits evenly when every size has zero sales share, rather than proposing nothing", () => {
    const shares: SizeShare[] = [
      { blankVariantId: "s", size: "S", salesShare: 0 },
      { blankVariantId: "m", size: "M", salesShare: 0 },
    ];
    const lines = splitBySizeCurve(10, shares);
    expect(lines.reduce((sum, l) => sum + l.qty, 0)).toBe(10);
    expect(lines.every((l) => l.qty === 5)).toBe(true);
  });

  it("a zero-share size gets zero units, never a negative or a made-up quantity", () => {
    const shares: SizeShare[] = [
      { blankVariantId: "s", size: "S", salesShare: 0 },
      { blankVariantId: "l", size: "L", salesShare: 1 },
    ];
    const lines = splitBySizeCurve(9, shares);
    expect(lines.find((l) => l.size === "S")?.qty).toBe(0);
    expect(lines.find((l) => l.size === "L")?.qty).toBe(9);
  });

  it("zero or negative total proposes zero on every line; no sizes proposes nothing", () => {
    const shares: SizeShare[] = [{ blankVariantId: "m", size: "M", salesShare: 1 }];
    expect(splitBySizeCurve(0, shares)).toEqual([{ blankVariantId: "m", size: "M", qty: 0 }]);
    expect(splitBySizeCurve(-5, shares)).toEqual([{ blankVariantId: "m", size: "M", qty: 0 }]);
    expect(splitBySizeCurve(10, [])).toEqual([]);
  });
});
