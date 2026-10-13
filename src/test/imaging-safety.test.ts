import { describe, expect, it } from "vitest";
import { CLOSED_IMAGING_URL, resolveTestImagingUrl } from "./imaging-safety";

describe("test imaging guard (T-44-5)", () => {
  it("defaults to a closed local port, ignoring the .env/shell value", () => {
    expect(resolveTestImagingUrl(undefined, "http://localhost:8000")).toBe(CLOSED_IMAGING_URL);
    expect(resolveTestImagingUrl("", "http://localhost:8100")).toBe(CLOSED_IMAGING_URL);
    expect(CLOSED_IMAGING_URL).toBe("http://127.0.0.1:1");
  });

  it("accepts an explicit opt-in on another port", () => {
    expect(resolveTestImagingUrl("http://127.0.0.1:18765/", "http://localhost:8000")).toBe(
      "http://127.0.0.1:18765",
    );
  });

  it.each([
    "http://localhost:8000",
    "http://127.0.0.1:8000",
    "http://localhost:8100",
    "http://127.0.0.1:8100/",
    "http://0.0.0.0:8000",
  ])("refuses live imaging %s", (url) => {
    expect(() => resolveTestImagingUrl(url)).toThrow(/live imaging/);
  });

  it("refuses the .env value even on another port", () => {
    expect(() =>
      resolveTestImagingUrl("http://img.internal:9000", "http://img.internal:9000"),
    ).toThrow(/live imaging/);
  });

  it("refuses a non-URL opt-in", () => {
    expect(() => resolveTestImagingUrl("nonsense")).toThrow(/not a URL/);
  });
});

describe("worker env (T-44-5)", () => {
  it("sees the closed port, not the .env/shell IMAGING_URL", () => {
    expect(process.env.IMAGING_URL).toBe(
      process.env.TEST_IMAGING_URL
        ? process.env.TEST_IMAGING_URL.replace(/\/$/, "")
        : CLOSED_IMAGING_URL,
    );
  });
});
