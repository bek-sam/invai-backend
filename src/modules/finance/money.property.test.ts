import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { allocate, allocateAdSpend, printAreaSqIn, transferCost } from "./profit";
import { splitFees } from "./service";

/*
 * T-32-3 (research 12 G22): property tests for the money helpers. Cents are integers and a split
 * always adds back to its total. The seed is fixed so a red run reproduces; fast-check prints the
 * seed, path and counterexample on failure (override with PROPERTY_SEED to explore).
 * Dropped on purpose: allocate() with a negative total or fractional weights (not promised: its
 * doc comment and every caller pass whole non-negative cents), and non-negativity of splitFees
 * (a referral fee above the total makes a part negative by design).
 */
const SEED = Number(process.env.PROPERTY_SEED ?? 32_003);
const run = { numRuns: 300, seed: SEED, verbose: 0 } as const;

const cents = fc.integer({ min: 0, max: 1_000_000_000 });
// Small weights are mixed in so equal weights (ties) come up often, not only by luck.
const weight = fc.oneof(fc.integer({ min: 0, max: 1_000_000 }), fc.integer({ min: 0, max: 3 }));
const weights = fc.array(weight, { minLength: 1, maxLength: 20 });
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

describe("allocate (largest remainder)", () => {
  it("returns whole, non-negative parts that sum exactly to the total", () => {
    fc.assert(
      fc.property(cents, weights, (total, w) => {
        const parts = allocate(total, w);
        expect(parts).toHaveLength(w.length);
        for (const p of parts) {
          expect(Number.isInteger(p)).toBe(true);
          expect(p).toBeGreaterThanOrEqual(0);
        }
        expect(sum(parts)).toBe(total);
      }),
      run,
    );
  });

  it("each part is within one cent of its exact proportional share", () => {
    fc.assert(
      fc.property(cents, weights, (total, w) => {
        const parts = allocate(total, w);
        const s = sum(w);
        w.forEach((x, i) => {
          const exact = s > 0 ? (total * x) / s : total / w.length;
          expect(Math.abs((parts[i] as number) - exact)).toBeLessThan(1 + 1e-6);
        });
      }),
      run,
    );
  });

  it("all-zero weights split evenly (parts differ by at most one cent)", () => {
    fc.assert(
      fc.property(cents, fc.integer({ min: 1, max: 20 }), (total, n) => {
        const parts = allocate(total, new Array(n).fill(0));
        expect(sum(parts)).toBe(total);
        expect(Math.max(...parts) - Math.min(...parts)).toBeLessThanOrEqual(1);
      }),
      run,
    );
  });

  it("a zero weight gets nothing when another weight is positive", () => {
    fc.assert(
      fc.property(cents, weights, (total, w) => {
        fc.pre(sum(w) > 0);
        const parts = allocate(total, w);
        w.forEach((x, i) => {
          if (x === 0) expect(parts[i]).toBe(0);
        });
      }),
      run,
    );
  });

  it("equal weights are stable (earlier index never gets less) and a bigger weight never gets less", () => {
    fc.assert(
      fc.property(cents, weights, (total, w) => {
        const parts = allocate(total, w);
        for (let i = 0; i < w.length; i++) {
          for (let j = i + 1; j < w.length; j++) {
            if (w[i] === w[j])
              expect(parts[i] as number).toBeGreaterThanOrEqual(parts[j] as number);
            if ((w[i] as number) > (w[j] as number))
              expect(parts[i] as number).toBeGreaterThanOrEqual(parts[j] as number);
          }
        }
      }),
      run,
    );
  });

  it("negative weights count as zero; no weights gives no parts", () => {
    fc.assert(
      fc.property(
        cents,
        fc.array(fc.integer({ min: -1000, max: 1000 }), { maxLength: 12 }),
        (total, w) => {
          expect(allocate(total, w)).toEqual(
            allocate(
              total,
              w.map((x) => Math.max(0, x)),
            ),
          );
        },
      ),
      run,
    );
    expect(allocate(500, [])).toEqual([]);
  });
});

describe("allocateAdSpend", () => {
  const orders = fc
    .array(fc.integer({ min: 0, max: 100_000_000 }), { minLength: 1, maxLength: 20 })
    .map((rev) => rev.map((revenueCents, i) => ({ key: `o${i}`, revenueCents })));

  it("covers every order, whole cents, summing to the spend, in both modes", () => {
    fc.assert(
      fc.property(
        cents,
        orders,
        fc.constantFrom("revenue_share", "per_order"),
        (spend, os, mode) => {
          const out = allocateAdSpend(spend, os, mode);
          expect([...out.keys()].sort()).toEqual(os.map((o) => o.key).sort());
          const vals = [...out.values()];
          for (const v of vals) {
            expect(Number.isInteger(v)).toBe(true);
            expect(v).toBeGreaterThanOrEqual(0);
          }
          expect(sum(vals)).toBe(spend);
          if (mode === "per_order")
            expect(Math.max(...vals) - Math.min(...vals)).toBeLessThanOrEqual(1);
        },
      ),
      run,
    );
  });
});

describe("splitFees", () => {
  // referralPerUnit must be as long as revenues (the caller always builds it per unit).
  const scenario = fc.integer({ min: 1, max: 15 }).chain((n) =>
    fc.tuple(
      cents,
      fc.array(fc.integer({ min: 0, max: 100_000_000 }), { minLength: n, maxLength: n }),
      fc.option(fc.array(fc.integer({ min: 0, max: 1_000_000 }), { minLength: n, maxLength: n }), {
        nil: null,
      }),
    ),
  );

  it("gives whole-cent parts per unit that add back to the fee total", () => {
    fc.assert(
      fc.property(scenario, ([total, revenues, referral]) => {
        const parts = splitFees({ total, referralPerUnit: referral }, revenues);
        expect(parts).toHaveLength(revenues.length);
        for (const p of parts) expect(Number.isInteger(p)).toBe(true);
        expect(sum(parts)).toBe(total);
      }),
      run,
    );
  });

  it("without referral fees every part is non-negative; with them each unit keeps its own referral when the total covers them", () => {
    fc.assert(
      fc.property(scenario, ([total, revenues, referral]) => {
        const parts = splitFees({ total, referralPerUnit: referral }, revenues);
        if (!referral) for (const p of parts) expect(p).toBeGreaterThanOrEqual(0);
        else if (total >= sum(referral))
          for (const [k, p] of parts.entries())
            expect(p).toBeGreaterThanOrEqual(referral[k] as number);
      }),
      run,
    );
  });

  it("no units, no parts", () => {
    expect(splitFees({ total: 123, referralPerUnit: null }, [])).toEqual([]);
  });
});

describe("transferCost and printAreaSqIn (cents are integers, inches are never rounded)", () => {
  const inches = fc.double({ min: 0.01, max: 30, noNaN: true });

  it("transferCost returns whole, non-negative cents, prorated within the sheet price", () => {
    fc.assert(
      fc.property(
        inches,
        fc.double({ min: 0, max: 5, noNaN: true }),
        fc.integer({ min: 1, max: 100_000 }),
        fc.double({ min: 1, max: 5_000, noNaN: true }),
        (areaSqIn, centsPerSqIn, sheetCostCents, sheetAreaSqIn) => {
          const est = transferCost({ areaSqIn, centsPerSqIn });
          expect(Number.isInteger(est.cents)).toBe(true);
          expect(est.cents).toBeGreaterThanOrEqual(0);
          expect(est.estimated).toBe(true);
          const known = transferCost({ areaSqIn, centsPerSqIn, sheetCostCents, sheetAreaSqIn });
          expect(Number.isInteger(known.cents)).toBe(true);
          expect(known.cents).toBeGreaterThanOrEqual(0);
          expect(known.estimated).toBe(false);
          if (areaSqIn <= sheetAreaSqIn) expect(known.cents).toBeLessThanOrEqual(sheetCostCents);
        },
      ),
      run,
    );
  });

  it("printAreaSqIn is the exact product of the unrounded inches, 0 when a side is unknown", () => {
    fc.assert(
      fc.property(inches, inches, (w, h) => {
        expect(printAreaSqIn(w, h)).toBe(w * h);
      }),
      run,
    );
    expect(printAreaSqIn(null, 4)).toBe(0);
    expect(printAreaSqIn(4, null)).toBe(0);
  });
});
