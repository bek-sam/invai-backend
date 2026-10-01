import type { Role } from "@invai/contracts";
import { call } from "@orpc/server";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { anonymousContext, permissionsFor } from "../../api/context";
import { router } from "../../api/router";
import { withSystem, withTenant } from "../../db/client";
import { outboxEvents, shipments } from "../../db/schema";
import { createCompany, createUser, tenantContext } from "../../test/fixtures";
import { lastCompleteWeek, localMidnights } from "../digest/week";
import * as financeSvc from "../finance/service";
import * as svc from "./finance-service";
import { addOrder, addShipment, buildScenario, localPeriod } from "./finance-testkit";
import * as shared from "./shared";

// Count calls to the one shared net function from every importer (finance and analytics alike).
vi.mock("./shared", async (orig) => {
  const mod = await orig<typeof import("./shared")>();
  return { ...mod, computeNet: vi.fn(mod.computeNet) };
});

type Scenario = Awaited<ReturnType<typeof buildScenario>>;

function routerContext(
  companyId: string,
  user: { id: string; name: string; email: string },
  role: Role,
) {
  return {
    ...anonymousContext(new Headers(), null),
    sessionKind: "user" as const,
    user,
    companyId,
    orgType: "shop" as const,
    role,
    permissions: permissionsFor(role),
  };
}

describe("finance analytics (T-A3)", () => {
  let a: string;
  let b: string;
  let ctxA: ReturnType<typeof tenantContext>;
  let ctxB: ReturnType<typeof tenantContext>;
  let s: Scenario;
  let bOrderIds: string[];
  const run = <T>(companyId: string, fn: Parameters<typeof withTenant<T>>[1]) =>
    withTenant(companyId, fn);

  beforeAll(async () => {
    a = (await createCompany()).id;
    b = (await createCompany()).id;
    ctxA = tenantContext(a, (await createUser(a, "owner")).id, "owner");
    ctxB = tenantContext(b, (await createUser(b, "owner")).id, "owner");
    s = await buildScenario(a);
    // Company B: 3 current-week orders with numbers A never has (77,777 revenue, a 90,000 label).
    bOrderIds = [];
    for (let i = 0; i < 3; i++) {
      const { order } = await addOrder(b, {
        channel: "etsy",
        placedAt: new Date("2026-08-12T18:00:00Z"),
        subtotal: 77_777,
        shipping: 700,
        lines: [{ revenue: 77_777, label: 90_000 }],
      });
      await addShipment(b, order.id, {
        postage: 90_000,
        labeledAt: new Date("2026-08-13T18:00:00Z"),
      });
      bOrderIds.push(order.id);
    }
  }, 60_000);

  it("AC-A1: CM1 ≥ CM2 ≥ CM3 per channel, and CM3 totals equal getProfit's Net to the cent", async () => {
    const [ue, profit] = await run(
      a,
      async (tx) =>
        [
          await svc.unitEconomics(tx, ctxA, { period: s.current, dimension: "channel" }),
          await financeSvc.getProfit(tx, ctxA, { period: s.current, dimension: "channel" }),
        ] as const,
    );
    expect(ue.rows.map((r) => r.key).sort()).toEqual(["etsy", "shopify"]);
    for (const r of ue.rows) {
      const p = profit.rows.find((x) => x.key === r.key);
      expect(r.cm3).toBe(p?.net);
      expect(r.revenue).toBe(p?.revenue);
      expect(r.cm1 - r.cm2).toBe(
        (p?.labelCost ?? 0) + (p?.packagingCost ?? 0) + (p?.laborCost ?? 0) + (p?.refunds ?? 0),
      );
      expect(r.cm2 - r.cm3).toBe(p?.adsCost);
    }
    expect(ue.totals.cm3).toBe(profit.totals.net);
    expect(ue.totals.revenue).toBe(profit.totals.revenue);
    // 37 orders with a profit line in the current week, 36 units (the cancel excluded; the re-pressed unit counts).
    expect(ue.totals.orders).toBe(37);
    expect(ue.totals.units).toBe(36);
    // 7 of 36 units carry an estimated blank (channel-fee estimates don't count).
    expect(ue.totals.estimatedShare).toBeCloseTo(7 / 36, 10);
    expect(ue.totals.cm3Pct).not.toBeNull();
    // Shopify has 10 units: below the 30-unit minimum, so cents and counts only.
    expect(ue.rows.find((r) => r.key === "shopify")?.cm3Pct).toBeNull();
  });

  it("AC-A1: every dimension's rows add up to the same totals", async () => {
    for (const dimension of ["order", "design", "blank", "sku", "channel"] as const) {
      const ue = await run(a, (tx) =>
        svc.unitEconomics(tx, ctxA, { period: s.current, dimension, limit: 500 }),
      );
      expect(ue.rows.reduce((t, r) => t + r.cm3, 0)).toBe(ue.totals.cm3);
    }
    const byDesign = await run(a, (tx) =>
      svc.unitEconomics(tx, ctxA, { period: s.current, dimension: "design" }),
    );
    // The order-level refund (no item) lands on an "Unmapped design" row, as on the Profit page.
    expect(byDesign.rows.map((r) => r.label).sort()).toEqual([
      "Cactus Sunset",
      "Desert Bloom Logo",
      "Unmapped design",
    ]);
  });

  it("AC-G1: getProfit and unitEconomics both call computeNet and agree for the digest's last complete week", async () => {
    const week = lastCompleteWeek("2026-08-19");
    const [from, to] = await run(a, (tx) =>
      localMidnights(tx, "America/Phoenix", [week.weekStart, week.weekEnd]),
    );
    const period = { from: (from as Date).toISOString(), to: (to as Date).toISOString() };
    expect(period).toEqual(s.current);
    const spy = vi.mocked(shared.computeNet);
    spy.mockClear();
    const profit = await run(a, (tx) =>
      financeSvc.getProfit(tx, ctxA, { period, dimension: "order" }),
    );
    const ue = await run(a, (tx) => svc.unitEconomics(tx, ctxA, { period, dimension: "order" }));
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls.map((c) => [c[2], c[3].dimension, c[3].channel])).toEqual([
      [period, "order", undefined],
      [period, "order", undefined],
    ]);
    expect(ue.totals.cm3).toBe(profit.totals.net);
    expect(profit.totals.net).not.toBe(0);
    // Same-week, channel-filtered parity (the other half of AC-G1 lands with T-A8).
    const shop = await run(
      a,
      async (tx) =>
        [
          await svc.unitEconomics(tx, ctxA, { period, dimension: "order", channel: "shopify" }),
          await financeSvc.getProfit(tx, ctxA, { period, dimension: "order", channel: "shopify" }),
        ] as const,
    );
    expect(shop[0].totals.cm3).toBe(shop[1].totals.net);
  });

  it("AC-A2: the label-sunk order is listed with its CM2 and Label; positive-CM2 orders are not", async () => {
    const lo = await run(a, (tx) => svc.losingOrders(tx, ctxA, { period: s.current }));
    expect(lo.orders).toHaveLength(1);
    const o = lo.orders[0];
    expect(o?.orderId).toBe(s.losingOrderId);
    expect(o?.cm2).toBe(-1635);
    expect(o?.largestCostLine).toBe("labelCost");
    expect(o?.largestCostLineCents).toBe(2400);
    expect(o?.designName).toBe("Desert Bloom Logo");
    expect(o?.channel).toBe("etsy");
    expect(lo.losingOrders).toBe(1);
    expect(lo.ordersWithProfitLine).toBe(37);
    expect(lo.losingPct).toBe(2.7);
    expect(lo.lossCents).toBe(-1635);
    expect(lo.ordersWithoutProfitLine).toBe(3);
    // Channel filter: no shopify order loses money.
    const shopify = await run(a, (tx) =>
      svc.losingOrders(tx, ctxA, { period: s.current, channel: "shopify" }),
    );
    expect(shopify.orders).toHaveLength(0);
    expect(shopify.losingPct).toBeNull(); // 10 orders: below the 30-order minimum
  });

  it("AC-A3: shipping margin counts labeled orders, free shipping, and skips voided labels", async () => {
    const sm = await run(a, (tx) =>
      svc.shippingMargin(tx, ctxA, { period: s.current, groupBy: "channel" }),
    );
    // 12 labeled regular orders (10 charged $5, 2 free) + the losing order (free).
    expect(sm.totals.labeledOrders).toBe(13);
    expect(sm.totals.freeShippingOrders).toBe(3);
    expect(sm.totals.charged).toBe(5000);
    // 4 labels at 654, 8 at 454, and 2400 (voided 9999 excluded).
    expect(sm.totals.labelCost).toBe(4 * 654 + 8 * 454 + 2400);
    expect(sm.totals.margin).toBe(sm.totals.charged - sm.totals.labelCost);
    expect(sm.rows.reduce((t, r) => t + r.labeledOrders, 0)).toBe(13);
    const bands = await run(a, (tx) =>
      svc.shippingMargin(tx, ctxA, { period: s.current, groupBy: "weightBand" }),
    );
    expect(bands.rows.map((r) => r.key)).toEqual(["4-8oz", "8-12oz"]);
    const zone = await run(a, (tx) =>
      svc.shippingMargin(tx, ctxA, { period: s.current, groupBy: "zone" }),
    );
    expect(zone.rows).toEqual([]);
    expect(zone.shipmentsWithoutZone).toBe(13);
    // Zero labeled shipments: zero counts and a null per-order margin, not a $0 "good news".
    const none = await run(a, (tx) =>
      svc.shippingMargin(tx, ctxA, { period: s.base, groupBy: "channel" }),
    );
    expect(none.totals.labeledOrders).toBe(0);
    expect(none.totals.marginPerOrder).toBeNull();
  });

  it("T-A3 follow-up (review note 2): shippingMargin groups by dest_zone and counts a null zone, not a made-up row", async () => {
    const z = (await createCompany()).id;
    const period = await localPeriod(z, "2026-09-01", "2026-09-08");
    const orderIds: string[] = [];
    for (let i = 0; i < 4; i++) {
      const { order } = await addOrder(z, {
        channel: "etsy",
        placedAt: new Date("2026-09-02T18:00:00Z"),
        subtotal: 2800,
        shipping: 500,
        lines: [{ revenue: 2800, label: 450 }],
      });
      orderIds.push(order.id);
    }
    // Zones 2, 2, 7, and one shipment with no zone (labeled before T-A4, or the lookup missed).
    const destZones: (number | null)[] = [2, 2, 7, null];
    await withSystem((tx) =>
      tx.insert(shipments).values(
        orderIds.map((orderId, i) => ({
          companyId: z,
          orderId,
          status: "labeled" as const,
          carrier: "usps" as const,
          service: "GroundAdvantage",
          postageCents: 450,
          labelFeeCents: 4,
          weightOz: 6,
          labeledAt: new Date("2026-09-03T17:00:00Z"),
          destZone: destZones[i],
        })),
      ),
    );
    const ctxZ = tenantContext(z, null, "owner");
    const zone = await run(z, (tx) => svc.shippingMargin(tx, ctxZ, { period, groupBy: "zone" }));
    expect(zone.rows.map((r) => r.key)).toEqual(["2", "7"]);
    const two = zone.rows.find((r) => r.key === "2");
    expect(two?.labeledOrders).toBe(2);
    expect(two?.charged).toBe(1000);
    expect(two?.labelCost).toBe(2 * 454);
    expect(two?.margin).toBe(1000 - 2 * 454);
    const seven = zone.rows.find((r) => r.key === "7");
    expect(seven?.labeledOrders).toBe(1);
    expect(seven?.charged).toBe(500);
    expect(seven?.labelCost).toBe(454);
    // The null-zone shipment is counted, not turned into a made-up row.
    expect(zone.shipmentsWithoutZone).toBe(1);
    expect(zone.rows.reduce((t, r) => t + r.labeledOrders, 0)).toBe(3);
    // Other groupings on the same data still work (dest_zone doesn't leak into their totals).
    const channel = await run(z, (tx) =>
      svc.shippingMargin(tx, ctxZ, { period, groupBy: "channel" }),
    );
    expect(channel.totals.labeledOrders).toBe(4);
    // Tenant isolation: company B, which has none of these shipments, sees nothing for the period.
    const isolated = await run(b, (tx) =>
      svc.shippingMargin(tx, ctxB, { period, groupBy: "zone" }),
    );
    expect(isolated.rows).toEqual([]);
    expect(isolated.shipmentsWithoutZone).toBe(0);
  });

  it("T-A9 (A1 note): channel and service rows with equal margin sort by label, then key, on every run", async () => {
    const t = (await createCompany()).id;
    const period = await localPeriod(t, "2026-09-01", "2026-09-08");
    // Inserted in reverse label order, so SQL or insertion order alone wouldn't sort them.
    const specs = [
      { channel: "walmart" as const, service: "Priority" },
      { channel: "tiktok" as const, service: "Express" },
      { channel: "shopify" as const, service: "GroundAdvantage" },
      { channel: "etsy" as const, service: "First" },
    ];
    for (const sp of specs) {
      const { order } = await addOrder(t, {
        channel: sp.channel,
        placedAt: new Date("2026-09-02T18:00:00Z"),
        subtotal: 2800,
        shipping: 500,
        lines: [{ revenue: 2800, label: 454 }],
      });
      await addShipment(t, order.id, {
        postage: 450,
        labeledAt: new Date("2026-09-03T17:00:00Z"),
        service: sp.service,
      });
    }
    const ctxT = tenantContext(t, null, "owner");
    for (let i = 0; i < 3; i++) {
      const ch = await run(t, (tx) => svc.shippingMargin(tx, ctxT, { period, groupBy: "channel" }));
      expect(ch.rows.map((r) => r.margin)).toEqual([46, 46, 46, 46]);
      expect(ch.rows.map((r) => r.label)).toEqual(["Etsy", "Shopify", "TikTok Shop", "Walmart"]);
      const sv = await run(t, (tx) => svc.shippingMargin(tx, ctxT, { period, groupBy: "service" }));
      expect(sv.rows.map((r) => r.key)).toEqual([
        "usps/Express",
        "usps/First",
        "usps/GroundAdvantage",
        "usps/Priority",
      ]);
    }
  });

  it("AC-A5: volume + rate = total change, and the top mover is design Y (new this week)", async () => {
    const pb = await run(a, (tx) => svc.profitBridge(tx, ctxA, { period: s.current }));
    expect(pb.basePeriod).toEqual(s.base);
    expect(pb.by).toBe("design");
    expect(pb.volumePart + pb.ratePart).toBe(pb.totalChange);
    expect(pb.currentCm3 - pb.baseCm3).toBe(pb.totalChange);
    for (const m of pb.topMovers) expect(m.volumePart + m.ratePart).toBe(m.change);
    expect(pb.topMovers[0]?.key).toBe(s.y);
    expect(pb.topMovers[0]?.label).toBe("Desert Bloom Logo");
    expect(pb.topMovers[0]?.ratePart).toBe(0); // no base units: all of it is volume
    expect(pb.baseOrders).toBe(22);
    expect(pb.currentOrders).toBe(37);
    expect(pb.hasEnoughOrders).toBe(true);
    // The dated refund (1000 − 60 recovered) is its own line; the bridge plus it = Net's change.
    expect(pb.refundsChange).toBe(-940);
    const [pBase, pCur] = await run(a, async (tx) => [
      await financeSvc.getProfit(tx, ctxA, { period: s.base, dimension: "channel" }),
      await financeSvc.getProfit(tx, ctxA, { period: s.current, dimension: "channel" }),
    ]);
    expect(pb.totalChange + pb.refundsChange).toBe(
      (pCur?.totals.net ?? 0) - (pBase?.totals.net ?? 0),
    );
    for (const by of ["channel", "costLine"] as const) {
      const r = await run(a, (tx) => svc.profitBridge(tx, ctxA, { period: s.current, by }));
      expect(r.totalChange).toBe(pb.totalChange);
      expect(r.volumePart + r.ratePart).toBe(r.totalChange);
      if (by === "costLine")
        expect(r.topMovers.reduce((t, m) => t + m.change, 0)).toBe(r.totalChange);
    }
  });

  it("AC-A6: no fixed costs → fixedCostsSet false and no break-even; $2,500 → orders and pace", async () => {
    const before = await run(a, (tx) => svc.breakEven(tx, ctxA, { period: s.current }));
    expect(before.fixedCostsSet).toBe(false);
    expect(before.fixedMonthlyCents).toBeNull();
    expect(before.breakEvenOrders).toBeNull();
    expect(before.pace).toBeNull();
    expect(before.operatingProfitPace).toBeNull();

    const outboxBefore = await countCostEvents(a);
    await run(a, (tx) => financeSvc.updateCostSettings(tx, ctxA, { fixedMonthlyCents: 250_000 }));
    // Run twice: same stored value, and never a profit recompute for a fixed-cost-only change.
    const again = await run(a, (tx) =>
      financeSvc.updateCostSettings(tx, ctxA, { fixedMonthlyCents: 250_000 }),
    );
    expect(again.fixedMonthlyCents).toBe(250_000);
    expect(await countCostEvents(a)).toBe(outboxBefore);

    const be = await run(a, (tx) => svc.breakEven(tx, ctxA, { period: s.current }));
    const profit = await run(a, (tx) =>
      financeSvc.getProfit(tx, ctxA, { period: s.current, dimension: "channel" }),
    );
    expect(be.fixedCostsSet).toBe(true);
    expect(be.fixedMonthlyCents).toBe(250_000);
    expect(be.orders).toBe(37);
    expect(be.cm3).toBe(profit.totals.net);
    expect(be.cm3PerOrder).toBe(svc.pgRound(profit.totals.net / 37));
    expect(be.breakEvenOrders).toBe(Math.ceil(250_000 / (profit.totals.net / 37)));
    expect(be.pace).toBe(svc.pgRound((37 * 30) / 7));
    expect(be.operatingProfitPace).toBe(svc.pgRound((profit.totals.net * 30) / 7) - 250_000);
    expect(be.hasEnoughOrders).toBe(true);

    // Clearing it goes back to "add your fixed costs"; other settings keep emitting recompute.
    await run(a, (tx) => financeSvc.updateCostSettings(tx, ctxA, { fixedMonthlyCents: null }));
    expect(
      (await run(a, (tx) => svc.breakEven(tx, ctxA, { period: s.current }))).fixedCostsSet,
    ).toBe(false);
    await run(a, (tx) => financeSvc.updateCostSettings(tx, ctxA, { packagingPerOrder: 45 }));
    expect(await countCostEvents(a)).toBe(outboxBefore + 1);
  });

  it("AC-A7: orders without a profit line are counted in leakage and unit economics", async () => {
    const [lk, ue] = await run(
      a,
      async (tx) =>
        [
          await svc.leakage(tx, ctxA, { period: s.current }),
          await svc.unitEconomics(tx, ctxA, { period: s.current, dimension: "channel" }),
        ] as const,
    );
    expect(lk.ordersWithoutProfitLine).toBe(3);
    expect(ue.ordersWithoutProfitLine).toBe(3);
    expect(lk.remaining).toBe(lk.grossSales - lk.waterfall.reduce((t, w) => t + w.cents, 0));
    expect(lk.waterfall.map((w) => w.component)).toEqual([
      "discounts",
      "fees",
      "refunds",
      "shippingLoss",
      "reprints",
    ]);
    const cents = Object.fromEntries(lk.waterfall.map((w) => [w.component, w.cents]));
    expect(cents.discounts).toBe(5 * 300);
    expect(cents.refunds).toBe(1000);
    expect(cents.reprints).toBe(300 + 150); // blank consumed + one of the item's two transfers
    // Fully computed period: nothing missing.
    const base = await run(a, (tx) => svc.leakage(tx, ctxA, { period: s.base }));
    expect(base.ordersWithoutProfitLine).toBe(0);
  });

  it("reads are repeatable: the same call twice returns the same numbers", async () => {
    const once = await run(a, (tx) => svc.leakage(tx, ctxA, { period: s.current }));
    const twice = await run(a, (tx) => svc.leakage(tx, ctxA, { period: s.current }));
    expect(twice).toEqual(once);
  });

  it("PERIOD_INVALID for an inverted or over-400-day period", async () => {
    await expect(
      run(a, (tx) => svc.leakage(tx, ctxA, { period: { from: s.current.to, to: s.current.from } })),
    ).rejects.toMatchObject({ code: "PERIOD_INVALID" });
    await expect(
      run(a, (tx) =>
        svc.breakEven(tx, ctxA, {
          period: { from: "2025-01-01T00:00:00.000Z", to: "2026-03-01T00:00:00.000Z" },
        }),
      ),
    ).rejects.toMatchObject({ code: "PERIOD_INVALID" });
  });

  it("AC-E4: company B's rows never appear in A's numbers, and A's never in B's", async () => {
    const p = { period: s.current };
    const [ueA, loA, lkA, smA, pbA, beA] = await run(
      a,
      async (tx) =>
        [
          await svc.unitEconomics(tx, ctxA, { ...p, dimension: "order", limit: 500 }),
          await svc.losingOrders(tx, ctxA, p),
          await svc.leakage(tx, ctxA, p),
          await svc.shippingMargin(tx, ctxA, { ...p, groupBy: "channel" }),
          await svc.profitBridge(tx, ctxA, p),
          await svc.breakEven(tx, ctxA, p),
        ] as const,
    );
    expect(ueA.rows.some((r) => bOrderIds.includes(r.key))).toBe(false);
    expect(loA.orders.some((o) => bOrderIds.includes(o.orderId))).toBe(false);
    expect(lkA.orders).toBe(36); // 37 with a line, less the cancelled one
    expect(smA.totals.labeledOrders).toBe(13);
    expect(pbA.currentOrders).toBe(37);
    expect(beA.orders).toBe(37);

    const [ueB, loB, lkB, smB, pbB, beB] = await run(
      b,
      async (tx) =>
        [
          await svc.unitEconomics(tx, ctxB, { ...p, dimension: "order" }),
          await svc.losingOrders(tx, ctxB, p),
          await svc.leakage(tx, ctxB, p),
          await svc.shippingMargin(tx, ctxB, { ...p, groupBy: "channel" }),
          await svc.profitBridge(tx, ctxB, p),
          await svc.breakEven(tx, ctxB, p),
        ] as const,
    );
    expect(ueB.totals.revenue).toBe(3 * 77_777);
    expect(ueB.rows.map((r) => r.key).sort()).toEqual([...bOrderIds].sort());
    expect(loB.orders.map((o) => o.orderId).sort()).toEqual([...bOrderIds].sort());
    expect(lkB.orders).toBe(3);
    expect(smB.totals.labeledOrders).toBe(3);
    expect(pbB.currentOrders).toBe(3);
    expect(pbB.topMovers.some((m) => m.key === s.x || m.key === s.y)).toBe(false);
    expect(beB.orders).toBe(3);
    expect(beB.fixedCostsSet).toBe(false);

    // A's company id inside B's tenant transaction sees nothing (RLS under the explicit filter).
    const cross = await run(b, (tx) => svc.unitEconomics(tx, ctxA, { ...p, dimension: "channel" }));
    expect(cross.totals.orders).toBe(0);
    expect(cross.rows).toEqual([]);
  });

  describe("router", () => {
    const inputs = (p: { from: string; to: string }) =>
      ({
        unitEconomics: { period: p, dimension: "channel" },
        losingOrders: { period: p },
        leakage: { period: p },
        shippingMargin: { period: p, groupBy: "channel" },
        profitBridge: { period: p },
        breakEven: { period: p },
      }) as const;

    it("AC-E5: designer and presser get FORBIDDEN on all six; owner and office get numbers", async () => {
      for (const role of ["designer", "presser"] as const) {
        const u = await createUser(a, role);
        const ctx = routerContext(a, u, role);
        for (const [name, input] of Object.entries(inputs(s.current))) {
          const proc = router.analytics[name as keyof ReturnType<typeof inputs>];
          await expect(call(proc as never, input, { context: ctx })).rejects.toMatchObject({
            code: "FORBIDDEN",
          });
        }
      }
      for (const role of ["owner", "office"] as const) {
        const u = await createUser(a, role);
        const ctx = routerContext(a, u, role);
        const ue = await call(router.analytics.unitEconomics, inputs(s.current).unitEconomics, {
          context: ctx,
        });
        expect(ue.totals.orders).toBe(37);
        const be = await call(router.analytics.breakEven, inputs(s.current).breakEven, {
          context: ctx,
        });
        expect(be.orders).toBe(37);
      }
    });

    it("finance.costSettings.update through the router stores fixed costs without a profit recompute", async () => {
      // The router's parsed input carries every CostSettingsInput key (undefined ones too).
      const c = (await createCompany()).id;
      const u = await createUser(c, "owner");
      const ctx = routerContext(c, u, "owner");
      const before = await countCostEvents(c);
      for (let i = 0; i < 2; i++) {
        const out = await call(
          router.finance.costSettings.update,
          { fixedMonthlyCents: 250_000 },
          { context: ctx },
        );
        expect(out.fixedMonthlyCents).toBe(250_000);
      }
      expect(await countCostEvents(c)).toBe(before);
      const got = await call(router.finance.costSettings.get, {}, { context: ctx });
      expect(got.fixedMonthlyCents).toBe(250_000);
      await call(router.finance.costSettings.update, { laborMinutesPerItem: 5 }, { context: ctx });
      expect(await countCostEvents(c)).toBe(before + 1);
    });
  });
});

async function countCostEvents(companyId: string) {
  const rows = await withSystem((tx) =>
    tx
      .select({ id: outboxEvents.id })
      .from(outboxEvents)
      .where(
        and(eq(outboxEvents.companyId, companyId), eq(outboxEvents.name, "cost_settings.changed")),
      ),
  );
  return rows.length;
}
