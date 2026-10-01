import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getObject } from "../../lib/s3";
import {
  createImagingClient,
  IMAGING_BUSY_RETRIES,
  ImagingError,
  placeholderPreviewPng,
  retryAfterMs,
} from "./client";

// A stand-in imaging: answers the first `busy` POSTs with 429 + Retry-After, then 200.
let server: Server;
let baseUrl: string;
let busy = 0;
let seen: IncomingMessage["headers"][] = [];
/** T-P2-2: force the stand-in's `/preview` response status (imaging stays reachable). */
let previewStatus: number | null = null;

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push(req.headers);
    req.resume();
    if (req.headers["x-imaging-secret"] !== "s3cret") {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ detail: "missing or invalid imaging credentials" }));
    }
    if (busy > 0) {
      busy--;
      res.writeHead(429, { "content-type": "application/json", "retry-after": "3" });
      return res.end(JSON.stringify({ detail: "imaging is busy; retry later" }));
    }
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (req.url === "/preview" && previewStatus) {
      res.writeHead(previewStatus, { "content-type": "application/json" });
      return res.end(JSON.stringify({ detail: `preview rejected (${previewStatus})` }));
    }
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url === "/preview") {
      return res.end(
        JSON.stringify({ out_key: "server/preview/x.png", width_px: 256, height_px: 128 }),
      );
    }
    res.end(JSON.stringify({ sheets: [] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
  busy = 0;
  seen = [];
  previewStatus = null;
});

function client(secret = "s3cret") {
  const waits: number[] = [];
  const c = createImagingClient(baseUrl, 5_000, secret, async (ms) => {
    waits.push(ms);
  });
  return { c, waits };
}

describe("imaging client (T-9-5)", () => {
  it("sends the shared secret", async () => {
    const { c } = client();
    await expect(c.nest({ items: [] })).resolves.toEqual({ sheets: [] });
    expect(seen[0]?.["x-imaging-secret"]).toBe("s3cret");
  });

  it("surfaces a wrong secret as a 401 ImagingError", async () => {
    const { c } = client("wrong");
    const err = await c.nest({ items: [] }).catch((e) => e);
    expect(err).toBeInstanceOf(ImagingError);
    expect(err.status).toBe(401);
  });

  it("retries a 429 after Retry-After, then succeeds", async () => {
    busy = 2;
    const { c, waits } = client();
    await expect(c.nest({ items: [] })).resolves.toEqual({ sheets: [] });
    expect(seen).toHaveLength(3);
    expect(waits).toEqual([3_000, 3_000]);
  });

  it("gives up after the retry budget with the 429", async () => {
    busy = 100;
    const { c, waits } = client();
    const err = await c.nest({ items: [] }).catch((e) => e);
    expect(err).toBeInstanceOf(ImagingError);
    expect(err.status).toBe(429);
    expect(seen).toHaveLength(IMAGING_BUSY_RETRIES + 1);
    expect(waits).toHaveLength(IMAGING_BUSY_RETRIES);
  });

  it("parses Retry-After as seconds or an HTTP date, clamped", () => {
    const now = Date.parse("2026-09-26T12:00:00Z");
    expect(retryAfterMs("5", now)).toBe(5_000);
    expect(retryAfterMs("Sat, 26 Sep 2026 12:00:07 GMT", now)).toBe(7_000);
    expect(retryAfterMs(null, now)).toBe(2_000);
    expect(retryAfterMs("junk", now)).toBe(2_000);
    expect(retryAfterMs("0", now)).toBe(100);
    expect(retryAfterMs("3600", now)).toBe(30_000);
  });

  it("previews a file through the real endpoint (B-209)", async () => {
    const { c } = client();
    await expect(
      c.preview({ file_key: "co/design/x.png", out_key: "co/preview/x.png", max_px: 512 }),
    ).resolves.toEqual({ out_key: "server/preview/x.png", width_px: 256, height_px: 128 });
  });

  it("falls back to a placeholder PNG when imaging can't be reached (B-209 AC5)", async () => {
    // Port 1 is reserved; connecting to it fails immediately without a stand-in server.
    const unreachable = createImagingClient("http://127.0.0.1:1", 1_000, "s3cret");
    const outKey = `catalog-client-test/preview/${crypto.randomUUID()}.png`;
    const result = await unreachable.preview({ file_key: "co/design/x.png", out_key: outKey });
    expect(result).toEqual({ out_key: outKey, width_px: 64, height_px: 64 });
    const written = await getObject(outKey);
    expect(written).toEqual(placeholderPreviewPng());
  });

  it("throws on a 5xx while imaging answers healthy, no placeholder (T-P2-2 AC2)", async () => {
    previewStatus = 503;
    const { c } = client();
    const err = await c
      .preview({ file_key: "co/design/x.png", out_key: "co/preview/x.png" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ImagingError);
    expect(err.status).toBe(503);
  });

  it("throws on a 422 bad-input rejection, no placeholder (T-P2-2 AC2)", async () => {
    previewStatus = 422;
    const { c } = client();
    const err = await c
      .preview({ file_key: "co/design/x.png", out_key: "co/preview/x.png" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ImagingError);
    expect(err.status).toBe(422);
  });
});
