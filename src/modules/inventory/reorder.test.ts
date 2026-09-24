import { describe, expect, it } from "vitest";
import { pushQuantity } from "./availability";
import {
  baseSuggestion,
  effectiveReorderPoint,
  planReorder,
  type ReorderCandidate,
} from "./reorder";

const P = { leadTimeDays: 3, safetyDays: 2, coverDays: 14 };

function cand(id: string, over: Partial<ReorderCandidate> = {}): ReorderCandidate {
  return {
    blankVariantId: id,
    supplier: "ssactivewear",
    available: 20,
    incoming: 0,
    manualReorderPoint: null,
    reorderQty: null,
    dailyVelocity: 1,
    unitCostCents: 300,
    supplierStock: null,
    ...over,
  };
}

describe("reorder math", () => {
  it("derives the reorder point from velocity × (lead + safety)", () => {
    expect(effectiveReorderPoint(null, 1.2, P)).toBe(6);
    expect(effectiveReorderPoint(10, 1.2, P)).toBe(10);
    expect(effectiveReorderPoint(null, 0, P)).toBeNull();
  });

  it("suggests enough to reach the point plus cover days", () => {
    // velocity 2/day: point 10, target 10 + 28 = 38; position 4 -> 34
    expect(baseSuggestion(cand("a", { available: 4, dailyVelocity: 2 }), P)).toEqual({
      qty: 34,
      reason: "below_reorder_point",
      point: 10,
    });
    // incoming counts toward the position
    expect(
      baseSuggestion(cand("a", { available: 4, incoming: 40, dailyVelocity: 2 }), P),
    ).toBeNull();
    // healthy stock: nothing
    expect(baseSuggestion(cand("a", { available: 50 }), P)).toBeNull();
    // supplier out of stock: nothing
    expect(baseSuggestion(cand("a", { available: 0, supplierStock: 0 }), P)).toBeNull();
    // reorder qty is a floor
    expect(
      baseSuggestion(
        cand("a", { available: 4, dailyVelocity: 0.2, manualReorderPoint: 6, reorderQty: 24 }),
        P,
      )?.qty,
    ).toBe(24);
  });

  it("tops up to the free-freight threshold with the most-needed variants", () => {
    const plans = planReorder(
      [
        cand("low", { available: 2, dailyVelocity: 1 }), // point 5, target 19 -> 17 units
        cand("mid", { available: 8, dailyVelocity: 2, manualReorderPoint: 4 }), // cover 4 days
        cand("high", { available: 60, dailyVelocity: 1 }), // cover 60 days
      ],
      { ssactivewear: 20000 },
      P,
    );
    expect(plans).toHaveLength(1);
    const plan = plans[0];
    if (!plan) throw new Error("no plan");
    expect(plan.meetsThreshold).toBe(true);
    expect(plan.subtotal).toBeGreaterThanOrEqual(20000);
    // One unit past the line at most.
    expect(plan.subtotal - 20000).toBeLessThan(300);
    const low = plan.lines.find((l) => l.blankVariantId === "low");
    const mid = plan.lines.find((l) => l.blankVariantId === "mid");
    expect(low?.reason).toBe("below_reorder_point");
    expect(mid?.reason).toBe("low_cover");
    // "high" has 60 days of cover: the top-up fills the others first
    const high = plan.lines.find((l) => l.blankVariantId === "high");
    expect((high?.qty ?? 0) < (mid?.qty ?? 0)).toBe(true);
    expect(plan.lines.reduce((s, l) => s + l.qty * 300, 0)).toBe(plan.subtotal);
  });

  it("never orders only to earn free freight", () => {
    expect(planReorder([cand("x", { available: 90 })], { ssactivewear: 20000 }, P)).toEqual([]);
  });

  it("reports the shortfall when supplier stock caps the top-up", () => {
    const [plan] = planReorder(
      [cand("only", { available: 0, dailyVelocity: 1, supplierStock: 30 })],
      { ssactivewear: 20000 },
      P,
    );
    expect(plan?.lines[0]?.qty).toBe(30);
    expect(plan?.meetsThreshold).toBe(false);
    expect(plan?.shortfall).toBe(20000 - 9000);
  });

  it("caps pushed availability", () => {
    expect(pushQuantity(12, null)).toBe(12);
    expect(pushQuantity(12, 5)).toBe(5);
    expect(pushQuantity(-3, 5)).toBe(0);
  });
});
