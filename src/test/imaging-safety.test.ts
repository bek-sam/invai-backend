import { describe, expect, it } from "vitest";
import {
  CLOSED_IMAGING_URL,
  liveImagingUrls,
  readEnvFileImagingUrls,
  resolveTestImagingUrl,
} from "./imaging-safety";

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

  const hosts = [
    "localhost",
    "LocalHost",
    "localhost.",
    "127.0.0.1",
    "127.0.0.2",
    "127.255.255.254",
    "0x7f.1",
    "2130706433",
    "[::1]",
    "[::]",
    "0.0.0.0",
    "[::ffff:127.0.0.1]",
    "[::ffff:7f00:1]",
    "host.docker.internal",
    "my-mac.local",
    "192.168.1.20",
  ];
  const cases = ["8000", "8100"].flatMap((port) => hosts.map((h) => [h, port] as const));

  it.each(cases)("refuses live imaging http://%s:%s (any spelling of the host)", (host, port) => {
    expect(() => resolveTestImagingUrl(`http://${host}:${port}`)).toThrow(/live imaging/);
  });

  it("refuses a path-carrying live opt-in", () => {
    expect(() => resolveTestImagingUrl("http://127.0.0.1:8100/")).toThrow(/live imaging/);
  });

  it.each(hosts)("refuses the shell IMAGING_URL port under host spelling %s", (host) => {
    expect(() => resolveTestImagingUrl("http://127.0.0.1:18765", [`http://${host}:18765`])).toThrow(
      /live imaging/,
    );
    expect(() => resolveTestImagingUrl(`http://${host}:18765`, ["http://localhost:18765"])).toThrow(
      /live imaging/,
    );
  });

  it("refuses when only .env names the live port (the shell names another)", () => {
    expect(() =>
      resolveTestImagingUrl("http://127.0.0.1:18766", [
        "http://localhost:8100",
        "http://localhost:18766",
      ]),
    ).toThrow(/live imaging/);
  });

  it("applies the default port 80/443 of a live URL written without one", () => {
    expect(() => resolveTestImagingUrl("http://127.0.0.1:80", ["http://img.internal"])).toThrow(
      /live imaging/,
    );
    expect(() => resolveTestImagingUrl("https://127.0.0.1:443", ["https://img.internal"])).toThrow(
      /live imaging/,
    );
    expect(() => resolveTestImagingUrl("http://127.0.0.1", ["http://img.internal"])).toThrow(
      /live imaging/,
    );
  });

  it("applies the default port per scheme, across schemes", () => {
    // live https without a port is :443, so an http opt-in on :443 hits it
    expect(() => resolveTestImagingUrl("http://127.0.0.1:443", ["https://img.internal"])).toThrow(
      /live imaging/,
    );
    // live http without a port is :80, so an https opt-in on :80 hits it
    expect(() => resolveTestImagingUrl("https://127.0.0.1:80", ["http://img.internal"])).toThrow(
      /live imaging/,
    );
    // and the other default is not live
    expect(resolveTestImagingUrl("http://127.0.0.1:80", ["https://img.internal"])).toBe(
      "http://127.0.0.1",
    );
  });

  it("accepts a loopback opt-in on a non-live port, whatever the live URLs are", () => {
    for (const host of ["127.0.0.1", "localhost.", "[::1]", "127.0.0.2"]) {
      expect(
        resolveTestImagingUrl(`http://${host}:18765`, [
          "http://localhost:8000",
          "http://localhost:18999",
        ]),
      ).toMatch(/:18765$/);
    }
  });

  it("refuses the .env value even on another port", () => {
    expect(() =>
      resolveTestImagingUrl("http://img.internal:9000", "http://img.internal:9000"),
    ).toThrow(/live imaging/);
  });

  it("ignores an unparsable live value", () => {
    expect(resolveTestImagingUrl("http://127.0.0.1:18765", ["nonsense", undefined])).toMatch(
      /18765/,
    );
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

describe("readEnvFileImagingUrls (T-45-3)", () => {
  it("reads IMAGING_URL from each file's own text, ignoring missing files", () => {
    const files: Record<string, string> = {
      ".env": "A=1\nIMAGING_URL=http://localhost:8000\n",
      ".env.local": "B=2\n",
    };
    expect(readEnvFileImagingUrls([".env", ".env.local", ".env.none"], (f) => files[f])).toEqual([
      "http://localhost:8000",
    ]);
  });

  it("reads the real file system and tolerates a missing path", () => {
    expect(readEnvFileImagingUrls(["/nonexistent/.env"])).toEqual([]);
  });
});

describe("liveImagingUrls (T-45-3, A7)", () => {
  it("returns the shell value and the env files' values, so an opt-in on the .env port is refused", () => {
    const files: Record<string, string> = { ".env": "IMAGING_URL=http://localhost:18770\n" };
    const live = liveImagingUrls("http://localhost:8100", [".env", ".env.local"], (f) => files[f]);
    expect(live).toEqual(["http://localhost:8100", "http://localhost:18770"]);
    expect(() => resolveTestImagingUrl("http://127.0.0.1:18770", live)).toThrow(/live imaging/);
  });
});
