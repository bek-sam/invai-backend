import { describe, expect, it } from "vitest";
import { app } from "./app";

describe("GET /health", () => {
  it("reports dependency status without saying which providers are mocked", async () => {
    const res = await app.request("/health");
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["db", "imaging", "ok", "redis", "s3", "version"]);
    expect(JSON.stringify(body)).not.toMatch(/mock/i);
  });
});
