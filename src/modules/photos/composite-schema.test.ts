import { describe, expect, it } from "vitest";
import { PhotoSceneCompositeResult } from "../../integrations/imaging/client";

/* T-37-3 AC1: the composite response parses both with and without the T-37-1 diagnostics. */

const OLD = {
  key: null,
  checks: {
    passes: false,
    failures: ["region_changed"],
    region_unchanged_score: 0.41,
    design_lock_score: null,
  },
};

describe("PhotoSceneCompositeResult", () => {
  it("accepts an old imaging response without the new fields", () => {
    const r = PhotoSceneCompositeResult.parse(OLD);
    expect(r.checks.structural).toBeUndefined();
    expect(r.checks.region_reasons).toBeUndefined();
    expect(r.registration).toBeUndefined();
  });

  it("accepts the new fields and keeps them", () => {
    const r = PhotoSceneCompositeResult.parse({
      ...OLD,
      checks: {
        ...OLD.checks,
        region_reasons: ["outline_low", "registration_at_limit", "box_foreign"],
        box_foreign: 0.012,
        structural: true,
      },
      registration: { scale: 1.1, dx_px: 3, dy_px: -2, score: 0.5, at_limit: true },
    });
    expect(r.checks).toMatchObject({ structural: true, box_foreign: 0.012 });
    expect(r.registration?.at_limit).toBe(true);
    expect(
      PhotoSceneCompositeResult.parse({ ...OLD, checks: { ...OLD.checks, box_foreign: null } })
        .checks.box_foreign,
    ).toBeNull();
  });

  it("accepts blank_delta_e and warnings (T-50-4), and an old answer lacks them", () => {
    const r = PhotoSceneCompositeResult.parse({
      ...OLD,
      checks: { ...OLD.checks, blank_delta_e: 5.4, warnings: ["blank_color_shift", "x"] },
    });
    expect(r.checks.blank_delta_e).toBe(5.4);
    expect(r.checks.warnings).toEqual(["blank_color_shift", "x"]);
    expect(PhotoSceneCompositeResult.parse(OLD).checks.warnings).toBeUndefined();
    expect(
      PhotoSceneCompositeResult.parse({ ...OLD, checks: { ...OLD.checks, blank_delta_e: null } })
        .checks.blank_delta_e,
    ).toBeNull();
  });
});
