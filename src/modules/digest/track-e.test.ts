import { DigestActionParams } from "@invai/contracts";
import { describe, expect, it } from "vitest";
import {
  d2Change,
  d9ShippingLoss,
  d10LosingOrders,
  d11StockHealth,
  d12BlankCost,
  d13BreakEven,
  detect,
} from "./detectors";
import { rank } from "./rank";
import { actionPart, expand, type RenderInsight } from "./render";
import { monthMinus, supplierCostRises } from "./track-e";
import type { Candidate, History, Snapshot, TrackE } from "./types";

/* Track E detectors D9..D13 and D2's bridge mover (T-A9): a fires / doesn't-fire pair at each edge. */

const NO_HISTORY: History = { votedDownLastWeek: new Set(), weeksShownWithoutAction: new Map() };

function trackE(over: Partial<TrackE> = {}): TrackE {
  return {
    shipping: [],
    losing: { ordersWithProfitLine: 0, losingOrders: 0, losingPct: null, lossCents: 0 },
    inventory: {
      days: 90,
      deadPctOfStockValue: null,
      deadValue: 0,
      deadVariants: 0,
      topDead: null,
      gaps: [],
    },
    supplierCosts: [],
    breakEven: {
      fixedCostsSet: false,
      hasEnoughOrders: false,
      days: 28,
      orders: 0,
      pace: null,
      breakEvenOrders: null,
      operatingProfitPace: null,
    },
    bridgeTopMover: null,
    ...over,
  };
}

function snapshot(t: Partial<TrackE> = {}, over: Partial<Snapshot> = {}): Snapshot {
  const totals = {
    orders: 40,
    units: 40,
    revenue: 100_000,
    net: 30_000,
    marginPct: 30,
    adsCost: 0,
    avgOrderValue: 2_500,
  };
  const zero = {
    channelFees: 0,
    blankCost: 0,
    transferCost: 0,
    labelCost: 0,
    packagingCost: 0,
    laborCost: 0,
    adsCost: 0,
    refunds: 0,
  };
  return {
    weekKey: "2026-W39",
    weekStart: "2026-09-21",
    weekEnd: "2026-09-28",
    periodFrom: "2026-09-21T07:00:00.000Z",
    periodTo: "2026-09-28T07:00:00.000Z",
    timezone: "America/Phoenix",
    asOf: "2026-09-28T14:05:00.000Z",
    current: totals,
    previous: { ...totals },
    trailingNet: [30_000, 29_000, 31_000, 30_500],
    trailingRevenue: [100_000, 99_000, 101_000, 100_500],
    costLines: { current: zero, previous: zero },
    byChannel: [],
    incompleteOrders: 0,
    ads: [],
    designs: { rising: [], lowMargin: [], crossListingGaps: [], top: [] },
    fulfillment: {
      channels: [],
      overdueNow: 0,
      shipped: 0,
      onTimeRate: null,
      previousOnTimeRate: null,
      bestTrailingOnTimeRate: null,
      reprints: 0,
      previousReprints: 0,
      reprintCostCents: 0,
      topReprintReason: null,
      itemsPlaced: 40,
    },
    lowStock: [],
    unhealthyChannels: [],
    trackE: trackE(t),
    ...over,
  };
}

const ship = (marginPerOrder: number, labeledOrders = 30) =>
  snapshot({
    shipping: [
      { channel: "etsy", labeledOrders, marginPerOrder, trailing: [-100, -110, -90, -100] },
    ],
  });

describe("D9 shipping loss (AC-E1)", () => {
  it("fires at exactly 50¢ worse than the 4-week median with 30 labeled orders", () => {
    const [c, ...rest] = d9ShippingLoss(ship(-150));
    expect(rest).toEqual([]);
    expect(c?.action.kind).toBe("review_shipping_prices");
    expect(c?.action.params).toMatchObject({ channel: "etsy", deltaCents: -50, n: 30 });
    expect(c?.impactCents).toBe(50 * 30);
  });
  it("doesn't fire at 49¢ worse, with 29 labeled orders, or without a loss", () => {
    expect(d9ShippingLoss(ship(-149))).toEqual([]);
    expect(d9ShippingLoss(ship(-150, 29))).toEqual([]);
    const profit = snapshot({
      shipping: [
        { channel: "etsy", labeledOrders: 40, marginPerOrder: 10, trailing: [90, 80, 70, 60] },
      ],
    });
    expect(d9ShippingLoss(profit)).toEqual([]);
  });
  it("needs 4 prior weeks for the median", () => {
    const s = snapshot({
      shipping: [
        { channel: "etsy", labeledOrders: 40, marginPerOrder: -300, trailing: [-100, -100, -100] },
      ],
    });
    expect(d9ShippingLoss(s)).toEqual([]);
  });
});

describe("D10 losing orders (AC-E1b)", () => {
  const losing = (losingPct: number, orders = 40) =>
    snapshot({
      losing: { ordersWithProfitLine: orders, losingOrders: 3, losingPct, lossCents: -2_500 },
    });
  it("fires above 5% with ≥ 30 orders, impact = the loss", () => {
    const [c] = d10LosingOrders(losing(5.1, 30));
    expect(c?.action.kind).toBe("review_losing_orders");
    expect(c?.impactCents).toBe(2_500);
  });
  it("doesn't fire at 5.0% or with 29 orders", () => {
    expect(d10LosingOrders(losing(5))).toEqual([]);
    expect(d10LosingOrders(losing(10, 29))).toEqual([]);
  });
  it("stays silent when most fees aren't final (money detectors)", () => {
    const s = losing(20);
    s.incompleteOrders = 40;
    expect(detect(s).filter((c) => c.detector === "D10")).toEqual([]);
  });
});

describe("D11 dead stock or size gap (AC-E1c)", () => {
  const dead = (pct: number) =>
    snapshot({
      inventory: {
        days: 90,
        deadPctOfStockValue: pct,
        deadValue: 40_000,
        deadVariants: 6,
        topDead: {
          blankVariantId: "00000000-0000-4000-8000-000000000001",
          style: "BC3001",
          color: "Black",
          value: 12_000,
        },
        gaps: [],
      },
    });
  const gap = (gapPts: number, coverDays: number) =>
    snapshot({
      inventory: {
        days: 90,
        deadPctOfStockValue: 2,
        deadValue: 0,
        deadVariants: 0,
        topDead: null,
        gaps: [
          {
            style: "BC3001",
            color: "Dusty Blue",
            size: "L",
            gapPts,
            coverDays,
            unitsSold: 90,
            onHand: 5,
          },
        ],
      },
    });
  it("dead stock above 15% names style and color", () => {
    const [c] = d11StockHealth(dead(15.1));
    expect(c?.action.kind).toBe("review_dead_stock");
    expect(c?.action.params).toMatchObject({ style: "BC3001", color: "Black" });
    expect(d11StockHealth(dead(15))).toEqual([]);
  });
  it("a gap at −15 points with under 14 days of cover names the size", () => {
    const [c] = d11StockHealth(gap(-15, 13.9));
    expect(c?.action.kind).toBe("restock_size_gap");
    expect(c?.action.params).toMatchObject({
      style: "BC3001",
      color: "Dusty Blue",
      size: "L",
      points: -15,
    });
    // 1 unit/day over 14 days = 14, less 5 on hand = 9 short, at 750¢ net per unit.
    expect(c?.impactCents).toBe(9 * 750);
    expect(d11StockHealth(gap(-14.9, 5))).toEqual([]);
    expect(d11StockHealth(gap(-18.6, 14))).toEqual([]);
    // Over-stocked (+18 pts, the seed's BC3001 Black 3XL) is not a restock gap.
    expect(d11StockHealth(gap(18, 3))).toEqual([]);
  });
});

describe("D12 blank cost up (AC-E1d)", () => {
  const rise = (unitCost: number) =>
    snapshot({
      supplierCosts: [
        {
          supplierName: "S&S Activewear",
          style: "BC3001",
          month: "2026-09",
          baseMonth: "2026-06",
          unitCost,
          baseUnitCost: 400,
          units: 120,
        },
      ],
    });
  it("fires at 5% above 3 months ago, names supplier and style, margin impact = rise × units", () => {
    const [c] = d12BlankCost(rise(420));
    expect(c?.action.kind).toBe("review_blank_cost");
    expect(c?.action.params).toMatchObject({
      supplierName: "S&S Activewear",
      style: "BC3001",
      points: 5,
      deltaCents: 20,
    });
    expect(c?.impactCents).toBe(20 * 120);
  });
  it("doesn't fire at 4.9%", () => {
    expect(d12BlankCost(rise(419.6))).toEqual([]);
  });
  it("compares the latest month with the latest one at least 3 months before, only when recent", () => {
    const row = (month: string, avgUnitCost: number) => ({
      supplier: "ss",
      supplierName: "S&S Activewear",
      styleCode: "BC3001",
      month,
      units: 10,
      avgUnitCost,
    });
    const out = supplierCostRises(
      [row("2026-05", 390), row("2026-06", 400), row("2026-08", 410), row("2026-09", 430)],
      "2026-09",
    );
    expect(out).toEqual([
      expect.objectContaining({
        month: "2026-09",
        baseMonth: "2026-06",
        unitCost: 430,
        baseUnitCost: 400,
      }),
    ]);
    // Latest month two months before the window: stale, no row.
    expect(supplierCostRises([row("2026-03", 300), row("2026-07", 400)], "2026-09")).toEqual([]);
    expect(monthMinus("2026-02", 3)).toBe("2025-11");
  });
});

describe("D13 break-even pace (AC-E1e)", () => {
  const be = (over: Partial<TrackE["breakEven"]>) =>
    snapshot({
      breakEven: {
        fixedCostsSet: true,
        hasEnoughOrders: true,
        days: 28,
        orders: 80,
        pace: 86,
        breakEvenOrders: 120,
        operatingProfitPace: -30_000,
        ...over,
      },
    });
  it("fires when fixed costs are set and the pace is below break-even", () => {
    const [c] = d13BreakEven(be({}));
    expect(c?.action.kind).toBe("see_break_even");
    expect(c?.impactCents).toBe(7_000);
    expect(c?.action.params).toMatchObject({ n: 120, deltaCents: -30_000 });
  });
  it("doesn't fire at break-even, under 30 orders, or ever without fixed costs", () => {
    expect(d13BreakEven(be({ operatingProfitPace: 0 }))).toEqual([]);
    expect(d13BreakEven(be({ hasEnoughOrders: false }))).toEqual([]);
    expect(
      d13BreakEven(be({ fixedCostsSet: false, operatingProfitPace: null, breakEvenOrders: null })),
    ).toEqual([]);
  });
});

describe("D2 names the bridge's top mover (AC-E1f)", () => {
  const moved = (mover: TrackE["bridgeTopMover"]) =>
    snapshot(
      { bridgeTopMover: mover },
      {
        current: {
          orders: 40,
          units: 40,
          revenue: 100_000,
          net: 50_000,
          marginPct: 50,
          adsCost: 0,
          avgOrderValue: 2_500,
        },
      },
    );
  it("puts the mover in params, facts and copy", () => {
    const id = "00000000-0000-4000-8000-0000000000aa";
    const [c] = d2Change(moved({ key: id, label: "Desert Sunset Tee", change: 18_000 }));
    expect(c?.action.params).toEqual({ designId: id, designName: "Desert Sunset Tee" });
    expect(c?.action.href).toBe("/analytics/profit?view=why&days=7");
    const i = { id: "x", detector: "D2", action: c?.action, facts: c?.facts } as RenderInsight;
    expect(expand(actionPart(i, "en"), "en")).toBe(
      "See what changed: Desert Sunset Tee moved your profit the most",
    );
    expect(expand(actionPart(i, "es"), "es")).toContain("Desert Sunset Tee");
  });
  it("an unmapped mover has no design id; no mover keeps the old wording", () => {
    const [u] = d2Change(moved({ key: "unmapped", label: "Unmapped design", change: 5_000 }));
    expect(u?.action.params).toEqual({ designName: "Unmapped design" });
    const [n] = d2Change(moved(null));
    expect(n?.templateKey).toBe("D2 action");
  });
});

describe("copy, params and ranking", () => {
  const all = (): Candidate[] => [
    ...d9ShippingLoss(ship(-200)),
    ...d10LosingOrders(
      snapshot({
        losing: { ordersWithProfitLine: 40, losingOrders: 4, losingPct: 10, lossCents: -900 },
      }),
    ),
    ...d11StockHealth(
      snapshot({
        inventory: {
          days: 90,
          deadPctOfStockValue: 30,
          deadValue: 9_000,
          deadVariants: 3,
          topDead: {
            blankVariantId: "00000000-0000-4000-8000-000000000001",
            style: "G64000",
            color: "Sand",
            value: 5_000,
          },
          gaps: [
            {
              style: "BC3001",
              color: "Dusty Blue",
              size: "L",
              gapPts: -18.6,
              coverDays: 6,
              unitsSold: 60,
              onHand: 2,
            },
          ],
        },
      }),
    ),
    ...d12BlankCost(
      snapshot({
        supplierCosts: [
          {
            supplierName: "SanMar",
            style: "G64000",
            month: "2026-09",
            baseMonth: "2026-06",
            unitCost: 330,
            baseUnitCost: 300,
            units: 50,
          },
        ],
      }),
    ),
    ...d13BreakEven(
      snapshot({
        breakEven: {
          fixedCostsSet: true,
          hasEnoughOrders: true,
          days: 28,
          orders: 60,
          pace: 64,
          breakEvenOrders: 90,
          operatingProfitPace: -12_000,
        },
      }),
    ),
  ];

  it("every new kind renders in English and Spanish with no empty placeholder", () => {
    const cs = all();
    expect(new Set(cs.map((c) => c.action.kind))).toEqual(
      new Set([
        "review_shipping_prices",
        "review_losing_orders",
        "review_dead_stock",
        "restock_size_gap",
        "review_blank_cost",
        "see_break_even",
      ]),
    );
    for (const c of cs) {
      const i: RenderInsight = {
        id: c.fingerprint,
        detector: c.detector,
        action: c.action,
        facts: c.facts,
      };
      const en = expand(actionPart(i, "en"), "en");
      const es = expand(actionPart(i, "es"), "es");
      expect(actionPart(i, "en").key).toBe(c.templateKey);
      expect(en).not.toMatch(/\{\{|\s{2}|: $/);
      expect(es).not.toMatch(/\{\{|\s{2}|: $/);
      expect(es).not.toBe(en);
    }
    const blank = cs.find((c) => c.detector === "D12") as Candidate;
    const i: RenderInsight = { id: "x", detector: "D12", action: blank.action, facts: blank.facts };
    expect(expand(actionPart(i, "en"), "en")).toBe(
      "Review blank cost: G64000 from SanMar is up 10%",
    );
  });

  it("params are contract-valid and carry no buyer field", () => {
    const allowed = new Set([
      "channel",
      "designId",
      "designName",
      "blankVariantId",
      "n",
      "style",
      "color",
      "size",
      "supplierName",
      "points",
      "deltaCents",
    ]);
    for (const c of all()) {
      expect(DigestActionParams.safeParse(c.action.params).success).toBe(true);
      for (const k of Object.keys(c.action.params)) expect(allowed.has(k)).toBe(true);
      expect(c.action.href).toMatch(/^\/(?!\/)/);
      expect(c.fingerprint.length).toBeLessThanOrEqual(128);
      for (const f of c.facts) expect(f.id.length).toBeLessThanOrEqual(64);
    }
  });

  it("Today ranks up to 5 actions; the digest keeps 3", () => {
    const cs = all();
    expect(cs.length).toBeGreaterThan(5);
    expect(rank(cs, NO_HISTORY, { maxActions: 5 }).actions.map((r) => r.rank)).toEqual([
      1, 2, 3, 4, 5,
    ]);
    expect(rank(cs, NO_HISTORY).actions).toHaveLength(3);
  });

  it("a snapshot without Track E inputs fires none of D9..D13", () => {
    const s = snapshot();
    s.trackE = undefined;
    expect(detect(s).filter((c) => /^D(9|1[0-3])$/.test(c.detector))).toEqual([]);
  });
});
