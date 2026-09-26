import { describe, expect, it } from "vitest";
import { withShutdownCap } from "./shutdown-timeout";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("withShutdownCap", () => {
  it("resolves true once work finishes before the cap, without waiting for the cap", async () => {
    const start = Date.now();
    const result = await withShutdownCap(delay(20), 2_000);
    expect(result).toBe(true);
    expect(Date.now() - start).toBeLessThan(500);
  });

  // AC4's shape: below the cap the work keeps running untouched; at the cap this returns false
  // right away instead of waiting for `work` to finish.
  it("resolves false at the cap while work is still pending, and doesn't wait for it", async () => {
    let workFinished = false;
    const work = delay(500).then(() => {
      workFinished = true;
    });
    const start = Date.now();
    const result = await withShutdownCap(work, 20);
    const elapsed = Date.now() - start;
    expect(result).toBe(false);
    expect(elapsed).toBeLessThan(200); // returned at ~20ms, not 500ms
    expect(workFinished).toBe(false); // still running, not killed
    await work; // let it actually finish so it doesn't leak into another test
    expect(workFinished).toBe(true);
  });

  it("swallows a rejection from work instead of hanging or throwing", async () => {
    const result = await withShutdownCap(Promise.reject(new Error("boom")), 2_000);
    expect(result).toBe(true);
  });
});
