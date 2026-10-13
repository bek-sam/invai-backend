import { describe, expect, it } from "vitest";
import { cutWhole } from "./text-safety";

const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const FIXED = (s: string) =>
  s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�");
const FAMILY = "👨‍👩‍👧‍👦"; // 11 units, one grapheme
const FLAG = "🇺🇸"; // 4 units, one grapheme
const E_ACUTE = "é̂"; // base letter + two combining marks, 3 units

/** The three facts every cut must keep (T-49-1 AC1). */
function expectWholeCut(input: string, n: number, out: string) {
  expect(out.length).toBeLessThanOrEqual(n);
  expect(LONE.test(out)).toBe(false);
  const fixed = FIXED(input);
  expect(fixed.startsWith(out)).toBe(true);
  if (out.length < fixed.length) {
    // Ends on a grapheme boundary of the input: the cut point is a segment start.
    const starts = new Set<number>();
    for (const { index } of seg.segment(fixed)) starts.add(index);
    starts.add(fixed.length);
    // A single grapheme longer than the cap is cut by code point, so only check normal cases.
    const first = seg.segment(fixed)[Symbol.iterator]().next().value;
    if (first && first.segment.length <= n) expect(starts.has(out.length)).toBe(true);
  }
}

describe("cutWhole", () => {
  const table: [string, string, number, string][] = [
    ["ASCII under the cap is untouched", "hello", 10, "hello"],
    ["ASCII over the cap", "hello world", 5, "hello"],
    ["empty", "", 5, ""],
    ["emoji halves straddling the cut are dropped whole", `ab${"😀"}cd`, 3, "ab"],
    ["emoji that ends exactly at the cap is kept", `ab${"😀"}cd`, 4, `ab${"😀"}`],
    ["a flag at the cut is dropped whole", `x${FLAG}y`, 3, "x"],
    ["a flag that fits is kept", `x${FLAG}y`, 5, `x${FLAG}`],
    ["a ZWJ family at the cut is dropped whole", `x${FAMILY}y`, 8, "x"],
    ["a ZWJ family that fits is kept", `x${FAMILY}y`, 12, `x${FAMILY}`],
    ["a base letter with marks across the cut", `a${E_ACUTE}b`, 2, "a"],
    ["a base letter with marks that fits", `a${E_ACUTE}b`, 4, `a${E_ACUTE}`],
    ["a lone high surrogate becomes U+FFFD", "a\uD83Db", 5, "a�b"],
    ["a lone low surrogate becomes U+FFFD", "a\uDE00b", 5, "a�b"],
    ["a lone surrogate alone (short-input path)", "\uD800", 5, "�"],
  ];
  it.each(table)("%s", (_name, input, n, want) => {
    const out = cutWhole(input, n);
    expect(out).toBe(want);
    expectWholeCut(input, n, out);
  });

  it("cuts one grapheme longer than the cap by code point, with no dangling high surrogate", () => {
    const out = cutWhole(FAMILY, 5); // 👨 (2) + ZWJ (1) + 👩 (2) = 5
    expect(out).toBe("👨‍👩");
    const odd = cutWhole(FAMILY, 4); // 👨 + ZWJ + a half emoji would not fit: stops before it
    expect(odd).toBe("👨‍");
    expect(LONE.test(odd)).toBe(false);
    expect(cutWhole(FAMILY, 1)).toBe("");
    expect(cutWhole(FAMILY, 2)).toBe("👨");
  });

  it("returns an empty string for a non-positive cap", () => {
    expect(cutWhole("abc", 0)).toBe("");
    expect(cutWhole("abc", -3)).toBe("");
  });

  it("does not trim", () => {
    expect(cutWhole("  hi  ", 10)).toBe("  hi  ");
  });

  it("property: random strings with emoji keep the three facts", () => {
    let seed = 0x2f6e2b1;
    const rnd = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const pieces = ["a", "Z", " ", "é", "é", "😀", "🇺🇸", FAMILY, "\uD83D", "\uDE00", "世"];
    for (let k = 0; k < 400; k++) {
      let s = "";
      for (let j = Math.floor(rnd() * 40); j > 0; j--)
        s += pieces[Math.floor(rnd() * pieces.length)];
      const n = Math.floor(rnd() * 30);
      expectWholeCut(s, n, cutWhole(s, n));
    }
  });
});
