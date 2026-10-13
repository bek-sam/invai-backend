import { describe, expect, it } from "vitest";
import { assertTestBucket, DEFAULT_TEST_BUCKET, resolveTestBucket } from "./bucket-safety";

describe("test bucket guard (T-43-6)", () => {
  it("defaults to invai-test when nothing is pinned", () => {
    expect(resolveTestBucket(undefined, false)).toBe(DEFAULT_TEST_BUCKET);
    expect(DEFAULT_TEST_BUCKET).toBe("invai-test");
  });

  it.each(["invai-test", "invai-test-t436", "invai-test-a-b1"])("accepts %s", (name) => {
    expect(resolveTestBucket(name, false)).toBe(name);
  });

  it.each([
    "invai-local",
    "invai-full",
    "",
    "invai-test/x",
    "invai-test-",
    "invai-testing",
    "INVAI-test",
    "x/invai-test",
    "invai-ci",
  ])("refuses %j without CI", (name) => {
    expect(() => resolveTestBucket(name, false)).toThrow(/not a test bucket/);
  });

  it("accepts invai-ci only when CI is set", () => {
    expect(assertTestBucket("invai-ci", true)).toBe("invai-ci");
    expect(() => assertTestBucket("invai-ci", false)).toThrow();
  });

  it("still refuses the dev bucket under CI", () => {
    expect(() => assertTestBucket("invai-local", true)).toThrow();
    expect(() => assertTestBucket(undefined, true)).toThrow();
  });
});
