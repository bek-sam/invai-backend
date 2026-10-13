import { describe, expect, it } from "vitest";
import type { PhotoSceneCompositeResult } from "../../integrations/imaging/client";
import { toSceneChecks } from "./scenes";

/* T-44-3: the region_changed detail names "placement off" (B-376). */

function res(
  checks: Partial<PhotoSceneCompositeResult["checks"]>,
  registration?: PhotoSceneCompositeResult["registration"],
): PhotoSceneCompositeResult {
  return {
    key: null,
    checks: {
      passes: false,
      failures: ["region_changed"],
      region_unchanged_score: 0.92,
      design_lock_score: null,
      ...checks,
    },
    ...(registration ? { registration } : {}),
  } as PhotoSceneCompositeResult;
}
const detail = (r: PhotoSceneCompositeResult) => toSceneChecks(r).failures[0]?.detail;

describe("region_changed detail", () => {
  it("AC1 starts with 'placement off' before the numbers", () => {
    expect(detail(res({ region_reasons: ["placement_off"] }))).toBe("placement off, outline 0.92");
  });
  it("AC1 placement_off combined with other reasons keeps the old numbers after it", () => {
    expect(
      detail(
        res(
          { region_reasons: ["outline_low", "placement_off"], box_foreign: 0.012 },
          { scale: 1.1, dx_px: 3, dy_px: -2, score: 0.5, at_limit: true },
        ),
      ),
    ).toBe("placement off, outline 0.92, at limit, foreign 0.012");
  });
  it("A8 placement_off with no numbers is 'placement off', not null", () => {
    expect(detail(res({ region_reasons: ["placement_off"], region_unchanged_score: null }))).toBe(
      "placement off",
    );
  });
  it("AC2/3 other or missing reasons leave the detail as before; unknown codes never appear", () => {
    expect(detail(res({ region_reasons: ["outline_low"] }))).toBe("outline 0.92");
    expect(detail(res({}))).toBe("outline 0.92");
    expect(detail(res({ region_reasons: ["some_new_code"] }))).toBe("outline 0.92");
    expect(
      detail(res({ region_reasons: ["outline_low"], region_unchanged_score: null })),
    ).toBeNull();
  });
});
