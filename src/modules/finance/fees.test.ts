import { CHANNEL_RULES, type Channel } from "@invai/contracts";
import { describe, expect, it } from "vitest";
import {
  type FeeCategory,
  feeCategoryOf,
  feeRecoveredCents,
  referralFeeCents,
  referralPct,
  usesSchedule,
} from "./fees";
import { defaultFeeTable, orderFees } from "./profit";
import { splitFees, taxInclusive } from "./service";

/** Small seeded PRNG (mulberry32) so the property runs are repeatable. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const RUNS = 2000;
const TIERED: Channel[] = ["amazon", "walmart", "tiktok"];
const CATS: FeeCategory[] = ["apparel", "bags", "other"];

describe("referral fee schedules (verified 2026-09-25)", () => {
  it("Amazon clothing: 5% to $15, 10% to $20, 17% above, $0.30 minimum", () => {
    expect(referralFeeCents("amazon", "apparel", 1200)).toBe(60);
    expect(referralFeeCents("amazon", "apparel", 1500)).toBe(75);
    expect(referralFeeCents("amazon", "apparel", 1501)).toBe(150);
    expect(referralFeeCents("amazon", "apparel", 2000)).toBe(200);
    expect(referralFeeCents("amazon", "apparel", 2001)).toBe(340);
    expect(referralFeeCents("amazon", "apparel", 2800)).toBe(476);
    expect(referralFeeCents("amazon", "apparel", 400)).toBe(30); // minimum
    expect(referralFeeCents("amazon", "bags", 2500)).toBe(375);
  });

  it("Walmart apparel: 5% to $15, 10% to $20, 15% above, no minimum", () => {
    expect(referralFeeCents("walmart", "apparel", 1500)).toBe(75);
    expect(referralFeeCents("walmart", "apparel", 1800)).toBe(180);
    expect(referralFeeCents("walmart", "apparel", 2800)).toBe(420);
    expect(referralFeeCents("walmart", "apparel", 400)).toBe(20);
  });

  it("TikTok Shop: 6% flat", () => {
    expect(referralFeeCents("tiktok", "apparel", 2800)).toBe(168);
    expect(referralPct("tiktok", "bags", 99_999)).toBe(6);
  });

  it("tote bags use the bags category, garments apparel", () => {
    expect(feeCategoryOf("Liberty Bags Canvas Tote")).toBe("bags");
    expect(feeCategoryOf("Softstyle T-Shirt")).toBe("apparel");
    expect(feeCategoryOf(null)).toBe("apparel");
  });

  it("the schedule applies only while the shop keeps the default rate", () => {
    const amazon = defaultFeeTable("amazon");
    expect(usesSchedule(amazon)).toBe(true);
    expect(usesSchedule({ ...amazon, transactionPct: 12 })).toBe(false);
    expect(usesSchedule(defaultFeeTable("etsy"))).toBe(false);
    const tiered = orderFees(amazon, {
      revenueCents: 1200 + 2800,
      buyerTotalCents: 4000,
      units: 2,
      unitSales: [
        { cents: 1200, category: "apparel" },
        { cents: 2800, category: "apparel" },
      ],
    });
    expect(tiered.referralPerUnit).toEqual([60, 476]);
    expect(tiered.lines[0]).toEqual({ label: "Referral 5/17%", amount: 536 });
    const flat = orderFees(
      { ...amazon, transactionPct: 12 },
      {
        revenueCents: 4000,
        buyerTotalCents: 4000,
        units: 2,
        unitSales: [
          { cents: 1200, category: "apparel" },
          { cents: 2800, category: "apparel" },
        ],
      },
    );
    expect(flat.referralPerUnit).toBeNull();
    expect(flat.total).toBe(480);
    // TikTok's contracts default (8) is stale: the verified 6% applies.
    expect(CHANNEL_RULES.tiktok.fees.transactionPct).toBe(8);
    expect(
      orderFees(defaultFeeTable("tiktok"), {
        revenueCents: 2500,
        buyerTotalCents: 2700,
        units: 1,
        unitSales: [{ cents: 2500, category: "apparel" }],
      }).total,
    ).toBe(150);
  });

  it("refunds return the referral fee less the admin fee", () => {
    // Amazon: $28 tee, fee 476; full refund keeps min($5, 20%) = 95.
    expect(
      feeRecoveredCents("amazon", { chargedFeeCents: 476, saleCents: 2800, refundCents: 2800 }),
    ).toBe(381);
    // Admin fee cap: a 5000 fee keeps 500.
    expect(
      feeRecoveredCents("amazon", { chargedFeeCents: 5000, saleCents: 30000, refundCents: 30000 }),
    ).toBe(4500);
    // Walmart: returned in full, proportional to the refunded share.
    expect(
      feeRecoveredCents("walmart", { chargedFeeCents: 420, saleCents: 2800, refundCents: 1400 }),
    ).toBe(210);
    // Shopify Payments keeps its processing fee.
    expect(
      feeRecoveredCents("shopify", { chargedFeeCents: 100, saleCents: 2800, refundCents: 2800 }),
    ).toBe(0);
  });

  it("detects Shopify tax-inclusive totals only", () => {
    const base = { subtotalCents: 2400, shippingCents: 500, taxCents: 400 };
    expect(taxInclusive({ channel: "shopify", ...base, totalCents: 2900 })).toBe(true);
    expect(taxInclusive({ channel: "shopify", ...base, totalCents: 3300 })).toBe(false);
    expect(taxInclusive({ channel: "etsy", ...base, totalCents: 2900 })).toBe(false);
  });
});

describe("fee math properties (integer cents)", () => {
  it("referral fees are integer, non-negative, at least the minimum, never above 20%", () => {
    const rnd = prng(72);
    for (let i = 0; i < RUNS; i++) {
      const ch = TIERED[Math.floor(rnd() * TIERED.length)] as Channel;
      const cat = CATS[Math.floor(rnd() * CATS.length)] as FeeCategory;
      const sale = 1 + Math.floor(rnd() * 20_000);
      const fee = referralFeeCents(ch, cat, sale);
      expect(Number.isInteger(fee)).toBe(true);
      expect(fee).toBeGreaterThanOrEqual(ch === "amazon" ? 30 : 0);
      expect(fee).toBeLessThanOrEqual(Math.max(30, Math.ceil(sale * 0.2)));
    }
  });

  it("recovered fee is an integer between 0 and the fee charged, monotone in the refund", () => {
    const rnd = prng(7272);
    for (let i = 0; i < RUNS; i++) {
      const ch = (["amazon", "walmart", "tiktok", "etsy", "ebay"] as Channel[])[
        Math.floor(rnd() * 5)
      ] as Channel;
      const sale = 1 + Math.floor(rnd() * 50_000);
      const charged = Math.floor(rnd() * sale * 0.2);
      const a = Math.floor(rnd() * sale * 1.2);
      const b = a + Math.floor(rnd() * 1000);
      const ra = feeRecoveredCents(ch, {
        chargedFeeCents: charged,
        saleCents: sale,
        refundCents: a,
      });
      const rb = feeRecoveredCents(ch, {
        chargedFeeCents: charged,
        saleCents: sale,
        refundCents: b,
      });
      expect(Number.isInteger(ra)).toBe(true);
      expect(ra).toBeGreaterThanOrEqual(0);
      expect(ra).toBeLessThanOrEqual(charged);
      expect(rb).toBeGreaterThanOrEqual(ra);
    }
  });

  it("per-unit fee split always adds up to the order's fee total", () => {
    const rnd = prng(727272);
    for (let i = 0; i < RUNS; i++) {
      const ch = (["amazon", "walmart", "tiktok", "etsy", "shopify"] as Channel[])[
        Math.floor(rnd() * 5)
      ] as Channel;
      const n = 1 + Math.floor(rnd() * 6);
      const sales = Array.from({ length: n }, () => Math.floor(rnd() * 6000));
      const revenue = sales.reduce((x, y) => x + y, 0);
      const fees = orderFees(defaultFeeTable(ch), {
        revenueCents: revenue,
        buyerTotalCents: revenue + Math.floor(rnd() * 500),
        units: n,
        unitSales: sales.map((cents) => ({ cents, category: "apparel" as const })),
      });
      const split = splitFees(fees, sales);
      expect(split.reduce((x, y) => x + y, 0)).toBe(fees.total);
      for (const s of split) expect(Number.isInteger(s)).toBe(true);
    }
  });
});
