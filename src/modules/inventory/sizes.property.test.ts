import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type PlannedLine, type SizeShare, splitBySizeCurve } from "./reorder";
import { type SizeCurveInfo, splitLinesBySizeCurve } from "./service";

/*
 * T-32-3 (research 12 G22): property tests for the reorder size-curve splits. Quantities are
 * whole units, never negative, and a split adds back to the requested total. Fixed seed; fast-check
 * prints the seed, path and counterexample on failure (override with PROPERTY_SEED).
 */
const SEED = Number(process.env.PROPERTY_SEED ?? 32_003);
const run = { numRuns: 300, seed: SEED, verbose: 0 } as const;
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

describe("splitBySizeCurve", () => {
  const shares = fc
    .array(fc.double({ min: 0, max: 1, noNaN: true }), { minLength: 1, maxLength: 12 })
    .map((s): SizeShare[] =>
      s.map((salesShare, i) => ({ blankVariantId: `v${i}`, size: `S${i}`, salesShare })),
    );
  const total = fc.integer({ min: 0, max: 1_000_000 });

  it("returns whole, non-negative quantities that add up to the total, one line per size in order", () => {
    fc.assert(
      fc.property(total, shares, (t, sh) => {
        const out = splitBySizeCurve(t, sh);
        expect(out.map((l) => l.blankVariantId)).toEqual(sh.map((s) => s.blankVariantId));
        expect(out.map((l) => l.size)).toEqual(sh.map((s) => s.size));
        for (const l of out) {
          expect(Number.isInteger(l.qty)).toBe(true);
          expect(l.qty).toBeGreaterThanOrEqual(0);
        }
        expect(sum(out.map((l) => l.qty))).toBe(t);
      }),
      run,
    );
  });

  it("a size with no sales gets no units unless every size has none (then it splits evenly)", () => {
    fc.assert(
      fc.property(total, shares, (t, sh) => {
        const out = splitBySizeCurve(t, sh);
        if (sh.every((s) => s.salesShare <= 0)) {
          const q = out.map((l) => l.qty);
          expect(Math.max(...q) - Math.min(...q)).toBeLessThanOrEqual(1);
        } else {
          sh.forEach((s, i) => {
            if (s.salesShare <= 0) expect(out[i]?.qty).toBe(0);
          });
        }
      }),
      run,
    );
  });

  it("a bigger sales share never gets fewer units", () => {
    fc.assert(
      fc.property(total, shares, (t, sh) => {
        const out = splitBySizeCurve(t, sh);
        for (let i = 0; i < sh.length; i++)
          for (let j = 0; j < sh.length; j++)
            if ((sh[i] as SizeShare).salesShare > (sh[j] as SizeShare).salesShare + 1e-12)
              expect(out[i]?.qty as number).toBeGreaterThanOrEqual((out[j]?.qty as number) - 1);
      }),
      run,
    );
  });

  it("a negative sales share counts as no sales", () => {
    const signed = fc
      .array(fc.double({ min: -1, max: 1, noNaN: true }), { minLength: 1, maxLength: 12 })
      .map((s): SizeShare[] =>
        s.map((salesShare, i) => ({ blankVariantId: `v${i}`, size: `S${i}`, salesShare })),
      );
    fc.assert(
      fc.property(total, signed, (t, sh) => {
        const clamped = sh.map((s) => ({ ...s, salesShare: Math.max(0, s.salesShare) }));
        expect(splitBySizeCurve(t, sh)).toEqual(splitBySizeCurve(t, clamped));
      }),
      run,
    );
  });

  it("a fractional or negative total is rounded to whole units, never below zero", () => {
    fc.assert(
      fc.property(fc.double({ min: -50, max: 5000, noNaN: true }), shares, (t, sh) => {
        const out = splitBySizeCurve(t, sh);
        for (const l of out) {
          expect(Number.isInteger(l.qty)).toBe(true);
          expect(l.qty).toBeGreaterThanOrEqual(0);
        }
        expect(sum(out.map((l) => l.qty))).toBe(Math.max(0, Math.round(t)));
      }),
      run,
    );
    expect(splitBySizeCurve(10, [])).toEqual([]);
  });
});

describe("splitLinesBySizeCurve (water-fill over the trailing curve, capped by supplier stock)", () => {
  const scenario = fc
    .array(
      fc.record({
        qty: fc.integer({ min: 0, max: 400 }),
        group: fc.constantFrom("tee-black", "tee-white", "hood-grey"),
        velocity: fc.oneof(fc.constant(0), fc.double({ min: 0.01, max: 20, noNaN: true })),
        position: fc.integer({ min: 0, max: 500 }),
        supplierStock: fc.oneof(fc.constant(null), fc.integer({ min: 0, max: 600 })),
        known: fc.boolean(),
      }),
      { minLength: 1, maxLength: 14 },
    )
    .map((rows) => {
      const lines: PlannedLine[] = rows.map((r, i) => ({
        blankVariantId: `v${i}`,
        qty: r.qty,
        reason: "below_reorder_point",
        reorderPoint: 5,
        daysOfCover: 3,
      }));
      const info = new Map<string, SizeCurveInfo>();
      rows.forEach((r, i) => {
        if (r.known)
          info.set(`v${i}`, {
            group: r.group,
            velocity: r.velocity,
            position: r.position,
            supplierStock: r.supplierStock,
          });
      });
      return { lines, info };
    });

  it("keeps lines, order and other fields; quantities stay whole and non-negative", () => {
    fc.assert(
      fc.property(scenario, ({ lines, info }) => {
        const out = splitLinesBySizeCurve(lines, info);
        expect(out).toHaveLength(lines.length);
        out.forEach((o, i) => {
          const l = lines[i] as PlannedLine;
          expect({ ...o, qty: 0 }).toEqual({ ...l, qty: 0 });
          expect(Number.isInteger(o.qty)).toBe(true);
          expect(o.qty).toBeGreaterThanOrEqual(0);
        });
      }),
      run,
    );
  });

  it("never exceeds supplier stock, never grows a group's total, leaves unknown / out-of-stock / single-size lines alone", () => {
    fc.assert(
      fc.property(scenario, ({ lines, info }) => {
        const out = splitLinesBySizeCurve(lines, info);
        const byGroup = new Map<string, number[]>();
        lines.forEach((l, i) => {
          const inf = info.get(l.blankVariantId);
          if (!inf || inf.supplierStock === 0) {
            expect(out[i]?.qty).toBe(l.qty);
            return;
          }
          byGroup.set(inf.group, [...(byGroup.get(inf.group) ?? []), i]);
        });
        for (const idx of byGroup.values()) {
          if (idx.length < 2) {
            for (const i of idx) expect(out[i]?.qty).toBe((lines[i] as PlannedLine).qty);
            continue;
          }
          const before = sum(idx.map((i) => (lines[i] as PlannedLine).qty));
          const after = sum(idx.map((i) => out[i]?.qty as number));
          expect(after).toBeLessThanOrEqual(before);
          for (const i of idx) {
            const stock = info.get((lines[i] as PlannedLine).blankVariantId)?.supplierStock;
            if (stock != null) expect(out[i]?.qty as number).toBeLessThanOrEqual(stock);
          }
        }
      }),
      run,
    );
  });

  it("the group total is kept whenever the suppliers' stock can cover it and some size sells", () => {
    fc.assert(
      fc.property(scenario, ({ lines, info }) => {
        const out = splitLinesBySizeCurve(lines, info);
        const byGroup = new Map<string, number[]>();
        lines.forEach((l, i) => {
          const inf = info.get(l.blankVariantId);
          if (inf && inf.supplierStock !== 0)
            byGroup.set(inf.group, [...(byGroup.get(inf.group) ?? []), i]);
        });
        for (const idx of byGroup.values()) {
          if (idx.length < 2) continue;
          const infos = idx.map(
            (i) => info.get((lines[i] as PlannedLine).blankVariantId) as SizeCurveInfo,
          );
          const selling = infos.filter((x) => x.velocity > 0);
          if (selling.length === 0) continue; // all-zero velocity spreads evenly; covered by caps above
          const capOfSelling = sum(selling.map((x) => x.supplierStock ?? Number.POSITIVE_INFINITY));
          const before = sum(idx.map((i) => (lines[i] as PlannedLine).qty));
          if (Number.isFinite(capOfSelling) && capOfSelling < before) continue;
          expect(sum(idx.map((i) => out[i]?.qty as number))).toBe(before);
        }
      }),
      run,
    );
  });
});
