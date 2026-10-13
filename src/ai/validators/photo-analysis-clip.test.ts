import { describe, expect, it } from "vitest";
import type { PhotoAnalysisOutput } from "../prompts";
import { repairPhotoAnalysis } from "./photo-analysis";

/* T-49-1 (S-86): `clip` runs after the gateway's sanitizeDeep, so a half emoji it leaves would
 * reach the design_photo_analysis jsonb. */
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const PALETTE = {
  colors: [{ hex: "#101010", share: 0.9 }],
  lightShare: 0.05,
  darkShare: 0.9,
  transparentShare: 0.5,
};

function out(over: Partial<PhotoAnalysisOutput>): PhotoAnalysisOutput {
  return {
    style: "bold",
    audience: "hikers",
    detectedText: null,
    colorDescription: "dark art",
    recommendedColors: [],
    sceneSuggestions: [],
    altText: [],
    imageOrder: [],
    ...over,
  };
}

describe("repairPhotoAnalysis clip", () => {
  it("cuts text with an emoji across the limit on a whole character", () => {
    // 299 units, then an emoji whose high half would be unit 299 (clip cuts at max - 1 = 299).
    const long = `${"x".repeat(298)}😀${"y".repeat(10)}`;
    const fixed = repairPhotoAnalysis(
      out({ style: long, audience: long, detectedText: long, colorDescription: long }),
      PALETTE,
    );
    for (const v of [fixed.style, fixed.audience, fixed.colorDescription]) {
      expect(LONE.test(v)).toBe(false);
      expect(v.length).toBeLessThanOrEqual(300);
    }
    expect(fixed.detectedText && LONE.test(fixed.detectedText)).toBeFalsy();
    expect(JSON.parse(JSON.stringify(fixed.style))).toBe(fixed.style);
  });

  it("cuts detectedText (500) the same way", () => {
    const long = `${"z".repeat(498)}😀${"w".repeat(10)}`;
    const fixed = repairPhotoAnalysis(out({ detectedText: long }), PALETTE);
    expect(fixed.detectedText).not.toBeNull();
    expect(LONE.test(fixed.detectedText as string)).toBe(false);
    expect((fixed.detectedText as string).length).toBeLessThanOrEqual(500);
  });
});
