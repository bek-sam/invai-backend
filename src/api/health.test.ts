import { afterEach, describe, expect, it, vi } from "vitest";
import { db } from "../db/client";
import { app } from "./app";

describe("GET /health", () => {
  it("reports dependency status without saying which providers are mocked", async () => {
    const res = await app.request("/health");
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["db", "imaging", "ok", "redis", "s3", "version"]);
    expect(JSON.stringify(body)).not.toMatch(/mock/i);
  });
});

// T-12-2 (B-16): /livez vs /health vs /readyz. A DB outage that would fail /health today must
// not fail /livez, and /readyz mirrors /health's db+redis verdict without imaging/S3.
describe("GET /livez, GET /readyz", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("/livez is always 200 and makes no DB/Redis/imaging/S3 calls, fast", async () => {
    const dbSpy = vi.spyOn(db, "execute").mockRejectedValue(new Error("db is down"));
    const start = performance.now();
    const res = await app.request("/livez");
    const elapsedMs = performance.now() - start;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(elapsedMs).toBeLessThan(50);
    expect(dbSpy).not.toHaveBeenCalled();
  });

  it("/health fails and /readyz fails the same way when the DB is down; /livez still 200", async () => {
    vi.spyOn(db, "execute").mockRejectedValue(new Error("db is down"));

    const health = await app.request("/health");
    expect(health.status).toBe(503);

    const ready = await app.request("/readyz");
    expect(ready.status).toBe(503);
    expect(await ready.json()).toEqual({ ok: false, db: false, redis: true });

    const live = await app.request("/livez");
    expect(live.status).toBe(200);
  });

  it("/readyz is 200 with DB and Redis both up", async () => {
    const res = await app.request("/readyz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, db: true, redis: true });
  });
});
