import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Channel } from "@invai/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "../../db/client";
import { createCompany, createUser, tenantContext } from "../../test/fixtures";
import { updateCostSettings } from "../finance/service";
import * as svc from "./finance-service";
import { addOrder, buildScenario, localPeriod, runMetricSql } from "./finance-testkit";

/*
 * Parity with the data-analyst's metric SQL (`invai-docs/metrics/sql/*.sql`, AC-A3/A5/A6 and the
 * definitions behind A1/A2/A7): each file runs as written (psql variables substituted) on the
 * same test database and must give the same numbers as the service. The SQL lives in the
 * sibling docs repo, so this suite only runs where that checkout exists (the workspace, not a
 * backend-only CI checkout).
 */

const SQL_DIR = resolve(import.meta.dirname, "../../../../invai-docs/metrics/sql");
const num = (v: unknown) => Number(v ?? 0);

describe.skipIf(!existsSync(SQL_DIR))("finance analytics = metric SQL (T-A3)", () => {
  let a: string;
  let ctxA: ReturnType<typeof tenantContext>;
  let s: Awaited<ReturnType<typeof buildScenario>>;
  const cur = { from: "2026-08-10", to: "2026-08-17" };
  const run = <T>(fn: Parameters<typeof withTenant<T>>[1]) => withTenant(a, fn);

  beforeAll(async () => {
    a = (await createCompany()).id;
    ctxA = tenantContext(a, (await createUser(a, "owner")).id, "owner");
    s = await buildScenario(a);
  }, 60_000);

  it("contribution_margin.sql: orders, revenue, CM1, CM2, CM3 per channel", async () => {
    const sqlRows = await runMetricSql("contribution_margin", a, cur);
    const ue = await run((tx) =>
      svc.unitEconomics(tx, ctxA, { period: s.current, dimension: "channel" }),
    );
    expect(sqlRows).toHaveLength(ue.rows.length);
    for (const r of sqlRows) {
      const mine = ue.rows.find((x) => x.key === r.channel);
      expect(mine, String(r.channel)).toBeDefined();
      expect(mine?.orders).toBe(num(r.orders));
      expect(mine?.revenue).toBe(num(r.revenue_cents));
      expect(mine?.cm1).toBe(num(r.cm1_cents));
      expect(mine?.cm2).toBe(num(r.cm2_cents));
      expect(mine?.cm3).toBe(num(r.cm3_cents));
    }
  });

  it("losing_orders.sql: losing orders, rate and loss per channel", async () => {
    const sqlRows = await runMetricSql("losing_orders", a, cur);
    expect(sqlRows.length).toBeGreaterThan(0);
    for (const r of sqlRows) {
      const lo = await run((tx) =>
        svc.losingOrders(tx, ctxA, { period: s.current, channel: r.channel as Channel }),
      );
      expect(lo.ordersWithProfitLine).toBe(num(r.orders));
      expect(lo.losingOrders).toBe(num(r.losing_orders));
      expect(lo.lossCents).toBe(num(r.loss_cents));
      if (lo.losingPct !== null) expect(lo.losingPct).toBe(num(r.losing_pct));
    }
    const all = await run((tx) => svc.losingOrders(tx, ctxA, { period: s.current }));
    expect(all.losingOrders).toBe(sqlRows.reduce((t, r) => t + num(r.losing_orders), 0));
  });

  it("revenue_leakage.sql: every component and the order counts per channel", async () => {
    const sqlRows = await runMetricSql("revenue_leakage", a, cur);
    expect(sqlRows.length).toBeGreaterThan(0);
    for (const r of sqlRows) {
      const lk = await run((tx) =>
        svc.leakage(tx, ctxA, { period: s.current, channel: r.channel as Channel }),
      );
      const c = Object.fromEntries(lk.waterfall.map((w) => [w.component, w.cents]));
      expect(lk.orders).toBe(num(r.orders));
      expect(lk.ordersWithoutProfitLine).toBe(num(r.orders_without_profit_line));
      expect(lk.grossSales).toBe(num(r.gross_cents));
      expect(c.discounts).toBe(num(r.discount_cents));
      expect(c.fees).toBe(num(r.fee_cents));
      expect(c.refunds).toBe(num(r.refund_cents));
      expect(c.shippingLoss).toBe(num(r.shipping_loss_cents));
      expect(c.reprints).toBe(num(r.reprint_cost_cents));
    }
    // The etsy row carries the reprint and the label loss, so both components are exercised.
    const etsy = sqlRows.find((r) => r.channel === "etsy");
    expect(num(etsy?.reprint_cost_cents)).toBeGreaterThan(0);
    expect(num(etsy?.shipping_loss_cents)).toBeGreaterThan(0);
  });

  it("shipping_margin.sql (AC-A3): labeled orders, charged, label cost, margin, free shipping per channel", async () => {
    const sqlRows = await runMetricSql("shipping_margin", a, cur);
    const sm = await run((tx) =>
      svc.shippingMargin(tx, ctxA, { period: s.current, groupBy: "channel" }),
    );
    expect(sqlRows).toHaveLength(sm.rows.length);
    for (const r of sqlRows) {
      const mine = sm.rows.find((x) => x.key === r.channel);
      expect(mine?.labeledOrders).toBe(num(r.labeled_orders));
      expect(mine?.charged).toBe(num(r.shipping_charged_cents));
      expect(mine?.labelCost).toBe(num(r.label_cost_cents));
      expect(mine?.margin).toBe(num(r.shipping_margin_cents));
      expect(mine?.marginPerOrder).toBe(num(r.margin_per_order_cents));
      expect(mine?.freeShippingOrders).toBe(num(r.free_shipping_orders));
    }
    expect(sqlRows.reduce((t, r) => t + num(r.free_shipping_orders), 0)).toBe(3);
  });

  it("profit_bridge.sql (AC-A5): total, volume, rate, and the top-ranked design", async () => {
    const sqlRows = await runMetricSql("profit_bridge", a, {
      bfrom: "2026-08-03",
      bto: "2026-08-10",
      ...cur,
    });
    const total = sqlRows.find((r) => r.design === "TOTAL");
    const designs = sqlRows.filter((r) => r.design !== "TOTAL");
    const top = designs.reduce((m, r) =>
      Math.abs(num(r.change_cents)) > Math.abs(num(m.change_cents)) ? r : m,
    );
    const pb = await run((tx) =>
      svc.profitBridge(tx, ctxA, { period: s.current, basePeriod: s.base, by: "design" }),
    );
    expect(pb.baseCm3).toBe(num(total?.cm0_cents));
    expect(pb.currentCm3).toBe(num(total?.cm1_cents));
    expect(pb.totalChange).toBe(num(total?.change_cents));
    expect(pb.volumePart).toBe(num(total?.volume_cents));
    expect(pb.ratePart).toBe(num(total?.rate_cents));
    expect(pb.topMovers[0]?.key).toBe(top.design);
    for (const r of designs) {
      const m = pb.topMovers.find((x) => x.key === r.design);
      expect(m?.volumePart).toBe(num(r.volume_cents));
      expect(m?.ratePart).toBe(num(r.rate_cents));
    }
  });

  it("break_even.sql (AC-A6): with $2,500 fixed, orders, CM3/order, break-even, pace", async () => {
    // A shop with 31 orders and no dated refunds, where CM3 = Σ profit_lines.net (the SQL's CM3).
    const c = (await createCompany()).id;
    const ctxC = tenantContext(c, (await createUser(c, "owner")).id, "owner");
    for (let i = 0; i < 31; i++)
      await addOrder(c, {
        placedAt: new Date(`2026-08-${String(11 + (i % 5))}T17:00:00Z`),
        lines: [{ revenue: 2600 + 17 * i, fees: 210, blank: 300, label: 480, ads: 90 }],
      });
    await withTenant(c, (tx) => updateCostSettings(tx, ctxC, { fixedMonthlyCents: 250_000 }));
    const period = await localPeriod(c, cur.from, cur.to);
    const [r] = await runMetricSql("break_even", c, { ...cur, fixed_cents: 250_000 });
    const be = await withTenant(c, (tx) => svc.breakEven(tx, ctxC, { period }));
    expect(be.orders).toBe(num(r?.orders));
    expect(be.cm3).toBe(num(r?.cm3_cents));
    expect(be.cm3PerOrder).toBe(num(r?.cm3_per_order_cents));
    expect(be.fixedMonthlyCents).toBe(num(r?.fixed_monthly_cents));
    expect(be.breakEvenOrders).toBe(num(r?.break_even_orders_per_month));
    expect(be.pace).toBe(num(r?.pace_orders_per_month));
    expect(be.operatingProfitPace).toBe(num(r?.operating_profit_pace_cents));

    // Where a dated refund falls in the window, breakEven's CM3 is the Profit page's Net, which
    // the v1 SQL's Σ net_cents leaves out: the gap is exactly that refund net of fee recovered.
    await withTenant(a, (tx) => updateCostSettings(tx, ctxA, { fixedMonthlyCents: 250_000 }));
    const [ra] = await runMetricSql("break_even", a, { ...cur, fixed_cents: 250_000 });
    const beA = await run((tx) => svc.breakEven(tx, ctxA, { period: s.current }));
    expect(beA.orders).toBe(num(ra?.orders));
    expect(num(ra?.cm3_cents) - beA.cm3).toBe(1000 - 60);
  });
});
