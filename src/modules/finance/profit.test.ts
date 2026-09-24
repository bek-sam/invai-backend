import { describe, expect, it } from "vitest";
import {
  allocate,
  allocateAdSpend,
  defaultFeeTable,
  finalize,
  laborCost,
  orderFees,
  sumBuckets,
  transferCost,
} from "./profit";

describe("profit math", () => {
  it("allocates cents exactly by weight", () => {
    expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocate(1000, [3000, 1000])).toEqual([750, 250]);
    expect(allocate(7, [0, 0])).toEqual([4, 3]);
    expect(allocate(0, [5, 5])).toEqual([0, 0]);
    expect(allocate(999, [2500, 2500, 2800]).reduce((a, b) => a + b, 0)).toBe(999);
  });

  it("computes Etsy fees from the channel defaults", () => {
    const etsy = defaultFeeTable("etsy");
    // $25 shirt + $5 shipping, buyer pays $32.10 with tax
    const fees = orderFees(etsy, { revenueCents: 3000, buyerTotalCents: 3210, units: 1 });
    // 6.5% of 3000 = 195; 3% of 3210 + 25 = 121.3 -> 121; listing 20
    expect(fees.total).toBe(195 + 121 + 20);
    expect(fees.lines.map((l) => l.amount)).toEqual([195, 121, 20]);
    expect(orderFees(etsy, { revenueCents: 0, buyerTotalCents: 0, units: 0 }).total).toBe(0);
  });

  it("uses Amazon's referral fee only", () => {
    const fees = orderFees(defaultFeeTable("amazon"), {
      revenueCents: 2000,
      buyerTotalCents: 2150,
      units: 1,
    });
    expect(fees.total).toBe(340);
  });

  it("spreads ad spend by revenue share or per order", () => {
    const orders = [
      { key: "a", revenueCents: 3000 },
      { key: "b", revenueCents: 1000 },
    ];
    expect([...allocateAdSpend(400, orders, "revenue_share").values()]).toEqual([300, 100]);
    expect([...allocateAdSpend(401, orders, "per_order").values()]).toEqual([201, 200]);
  });

  it("prorates the vendor sheet price by area, else $/sq in", () => {
    expect(transferCost({ areaSqIn: 132, centsPerSqIn: 3 })).toEqual({
      cents: 396,
      estimated: true,
    });
    expect(
      transferCost({ areaSqIn: 100, centsPerSqIn: 3, sheetCostCents: 2000, sheetAreaSqIn: 1000 }),
    ).toEqual({ cents: 200, estimated: false });
  });

  it("nets out every bucket", () => {
    const line = finalize({
      revenue: 3000,
      channelFees: 336,
      blankCost: 350,
      transferCost: 396,
      labelCost: 480,
      packagingCost: 45,
      laborCost: laborCost(4, 1800),
      adsCost: 150,
      refunds: 0,
    });
    expect(line.laborCost).toBe(120);
    expect(line.net).toBe(3000 - 336 - 350 - 396 - 480 - 45 - 120 - 150);
    expect(line.marginPct).toBeCloseTo(line.net / 3000);
    const refunded = finalize({ ...line, refunds: 3000, channelFees: 0 });
    expect(refunded.net).toBeLessThan(0);
    const total = sumBuckets([line, line]);
    expect(total.net).toBe(line.net * 2);
    expect(finalize({ ...line, revenue: 0 }).marginPct).toBeNull();
  });
});
