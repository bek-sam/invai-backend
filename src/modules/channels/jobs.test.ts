import { describe, expect, it } from "vitest";
import { POLL_EVERY_MS, pollJitterMs } from "./jobs";

/*
 * T-12-3 (B-20), AC6: channel poll jitter. `pollJitterMs` spreads every connection's poll job
 * across the 10-minute window instead of firing them all at once, with a delay that's stable per
 * connection (not random per run) so two ticks don't happen to line different connections up.
 */

describe("pollJitterMs", () => {
  it("spreads 100 connections across the window instead of landing on one instant", () => {
    const ids = Array.from({ length: 100 }, () => crypto.randomUUID());
    const delays = ids.map((id) => pollJitterMs(id));

    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThan(POLL_EVERY_MS);
    }
    // Not identical: at least a handful of distinct offsets across 100 different connections.
    expect(new Set(delays).size).toBeGreaterThan(50);
  });

  it("gives the same connectionId the same delay every time (stable, not random per run)", () => {
    const id = crypto.randomUUID();
    const first = pollJitterMs(id);
    for (let i = 0; i < 5; i++) expect(pollJitterMs(id)).toBe(first);
  });

  it("gives different connections different delays (not a collision-prone hash)", () => {
    const a = pollJitterMs("11111111-1111-1111-1111-111111111111");
    const b = pollJitterMs("22222222-2222-2222-2222-222222222222");
    expect(a).not.toBe(b);
  });

  it("respects a custom spread window", () => {
    const id = crypto.randomUUID();
    const d = pollJitterMs(id, 1000);
    expect(d).toBeGreaterThanOrEqual(0);
    expect(d).toBeLessThan(1000);
  });
});
