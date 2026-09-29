import { describe, expect, it } from "vitest";
import { RATE_TTL_MS, rateExpiresAt } from "./rate-ttl";

describe("rate expiry (B-25)", () => {
  it("is the TTL after rating on an ordinary day", () => {
    const ratedAt = new Date("2026-09-29T18:00:00Z");
    expect(rateExpiresAt("usps", ratedAt).getTime()).toBe(ratedAt.getTime() + RATE_TTL_MS);
  });

  it("stops at the USPS price change (midnight Central), not after it", () => {
    // Oct 3 2026, 9 p.m. Central: the peak surcharge starts at midnight Central (05:00Z).
    const ratedAt = new Date("2026-10-04T02:00:00Z");
    expect(rateExpiresAt("usps", ratedAt).toISOString()).toBe("2026-10-04T05:00:00.000Z");
    // UPS has no change that night.
    expect(rateExpiresAt("ups", ratedAt).getTime()).toBe(ratedAt.getTime() + RATE_TTL_MS);
  });

  it("a quote made after the change gets the full TTL", () => {
    const ratedAt = new Date("2026-10-04T06:00:00Z");
    expect(rateExpiresAt("usps", ratedAt).getTime()).toBe(ratedAt.getTime() + RATE_TTL_MS);
  });

  it("takes the price-change list as data", () => {
    const ratedAt = new Date("2026-12-01T12:00:00Z");
    const at = "2026-12-01T18:00:00.000Z";
    expect(rateExpiresAt("mock", ratedAt, [{ carrier: "mock", at }]).toISOString()).toBe(at);
  });
});
