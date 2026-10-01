import { describe, expect, it } from "vitest";
import { withTenant } from "../../db/client";
import { createCompany, createConnection, createOrder, tenantContext } from "../../test/fixtures";
import { addDesign, addOrder } from "../analytics/finance-testkit";
import {
  adPerformance,
  comparePeriods,
  designInsights,
  fulfillmentHealth,
  previousPeriod,
  toPeriod,
} from "./analyst-queries";
import { assistantTools } from "./assistant-tools";

/*
 * T-19-2: the shared analyst queries are the numbers behind both the assistant tools and the
 * weekly digest. The tools' behavior is pinned by assistant-tools.test.ts; here: the data
 * functions return exactly what each tool hands the model, and they stay inside the tenant.
 */

const DAY = 86_400_000;
const range = () => ({
  from: new Date(Date.now() - 7 * DAY).toISOString(),
  to: new Date(Date.now() + DAY).toISOString(),
});

async function shopWithOrders() {
  const shop = await createCompany();
  const conn = await createConnection(shop.id, "csv");
  await createOrder(shop.id, conn.id, { units: 2 });
  await createOrder(shop.id, conn.id, { units: 1 });
  return { shop, ctx: tenantContext(shop.id, null, "owner") };
}

async function toolData(
  ctx: ReturnType<typeof tenantContext>,
  name: string,
  input: Record<string, unknown>,
) {
  const t = assistantTools(ctx).find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return (await t.run(input)).data;
}

describe("analyst queries", () => {
  it("return exactly the data the four assistant tools send the model", async () => {
    const { shop, ctx } = await shopWithOrders();
    const r = range();
    const q = <T>(f: (tx: Parameters<Parameters<typeof withTenant>[1]>[0]) => Promise<T>) =>
      withTenant(shop.id, f);

    expect(await toolData(ctx, "compare_periods", r)).toEqual(
      await q((tx) => comparePeriods(tx, ctx, r)),
    );
    expect(await toolData(ctx, "get_ad_performance", r)).toEqual(
      await q((tx) => adPerformance(tx, ctx, r)),
    );
    expect(await toolData(ctx, "get_ad_performance", { ...r, groupBy: "campaign" })).toEqual(
      await q((tx) => adPerformance(tx, ctx, { ...r, groupBy: "campaign" })),
    );
    const {
      designsSold: _d,
      missingCostData: _m,
      ...designs
    } = await q((tx) => designInsights(tx, ctx, r));
    expect(await toolData(ctx, "get_design_insights", r)).toEqual(designs);
    expect(await toolData(ctx, "get_fulfillment_health", r)).toEqual(
      await q((tx) => fulfillmentHealth(tx, ctx, r)),
    );
  });

  it("count only the caller's tenant", async () => {
    const a = await shopWithOrders();
    const b = await createCompany();
    const r = range();
    const ha = await withTenant(a.shop.id, (tx) => fulfillmentHealth(tx, a.ctx, r));
    expect(ha.totals.itemsPlaced).toBe(3);
    // Company B's context inside B's tenant sees none of A's orders.
    const ctxB = tenantContext(b.id, null, "owner");
    const hb = await withTenant(b.id, (tx) => fulfillmentHealth(tx, ctxB, r));
    expect(hb.totals.itemsPlaced).toBe(0);
    // B's context inside A's transaction still filters on B's company id.
    const mixed = await withTenant(a.shop.id, (tx) => fulfillmentHealth(tx, ctxB, r));
    expect(mixed.totals.itemsPlaced).toBe(0);
  });

  it("counts a reprinted unit as a sale in cross-listing gaps (decision 0020)", async () => {
    const shop = await createCompany();
    const ctx = tenantContext(shop.id, null, "owner");
    const designId = await addDesign(shop.id, "Gap Design");
    const now = new Date();
    // An order with 2 units, one reprinted: one profit line has isReprint=true on the same
    // order_items row (a re-press, not a sibling "extra" row); the other is a normal unit.
    await addOrder(shop.id, {
      channel: "etsy",
      placedAt: now,
      lines: [
        { designId, isReprint: true, revenue: 2500 },
        { designId, isReprint: false, revenue: 2500 },
      ],
    });
    // A third, non-reprint unit on the same design and channel only clears the >=3-unit
    // (MIN_UNITS) gate so the gap is visible either way; whether it reaches 3 at all is exactly
    // what the isReprint filter decides.
    await addOrder(shop.id, {
      channel: "etsy",
      placedAt: now,
      lines: [{ designId, isReprint: false, revenue: 2500 }],
    });
    // A second connected channel the design is neither sold on nor listed on: the gap.
    await createConnection(shop.id, "shopify");

    const r = {
      from: new Date(now.getTime() - DAY).toISOString(),
      to: new Date(now.getTime() + DAY).toISOString(),
    };
    const result = await withTenant(shop.id, (tx) => designInsights(tx, ctx, r));
    const gap = result.crossListingGaps.find((g) => g.designId === designId);
    expect(gap).toBeDefined();
    // 3, not 2: the reprinted unit counts as a sale alongside the other two.
    expect(gap?.soldOn).toEqual([{ channel: "etsy", units: 3 }]);
    expect(gap?.missingOn).toEqual(["shopify"]);
  });

  it("period helpers", () => {
    const p = toPeriod("2026-09-21T00:00:00-07:00", "2026-09-28T00:00:00-07:00");
    expect(p).toEqual({ from: "2026-09-21T07:00:00.000Z", to: "2026-09-28T07:00:00.000Z" });
    expect(previousPeriod(p)).toEqual({
      from: "2026-09-14T07:00:00.000Z",
      to: "2026-09-21T07:00:00.000Z",
    });
    expect(() => toPeriod("2026-09-28", "2026-09-21")).toThrow();
  });
});
