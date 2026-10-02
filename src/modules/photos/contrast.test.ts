import { describe, expect, it } from "vitest";
import { contrastRatio, contrastWarnings, designContrast } from "./contrast";

describe("contrast warnings (computed in code)", () => {
  it("matches WCAG: black on white is 21, same color is 1", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#777777", "#777777")).toBe(1);
  });

  it("warns light art on a light blank and dark art on a dark blank, with the ratio", () => {
    const light = [{ hex: "#f5f5f5", share: 0.8 }];
    const dark = [
      { hex: "#111111", share: 0.6 },
      { hex: "#222222", share: 0.3 },
    ];
    const blanks = [
      { name: "White", hex: "#FFFFFF" },
      { name: "Black", hex: "#000000" },
    ];
    const w1 = contrastWarnings(light, blanks);
    expect(w1).toHaveLength(1);
    expect(w1[0]).toMatchObject({
      blank: { name: "White", hex: "#ffffff" },
      kind: "light_on_light",
    });
    expect(w1[0]?.ratio).toBeLessThan(1.2);
    const w2 = contrastWarnings(dark, blanks);
    expect(w2.map((w) => [w.blank.name, w.kind])).toEqual([["Black", "dark_on_dark"]]);
  });

  it("ignores accents under 5% and transparent-only designs", () => {
    expect(designContrast([{ hex: "#ffffff", share: 0.01 }], "#ffffff")).toBeNull();
    expect(contrastWarnings([], [{ name: "White", hex: "#ffffff" }])).toEqual([]);
  });
});
