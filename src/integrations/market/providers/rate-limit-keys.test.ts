import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * Reviewer finding 2: a provider's own API key/token must never become part of a Redis rate-limit
 * key, so it can never end up in Redis itself, in a BullMQ `failedReason` (kept 7 days in Valkey)
 * or in a log line. Census and Jungle Scout already used a constant bucket
 * (`market:census`/`market:jungle_scout`); this proves Google Trends and Pinterest now do too, and
 * that the error `takeToken` throws on a real rate-limit-exceeded event carries no key material.
 *
 * `takeToken` is mocked in this file only (module mocks are per test file in Vitest), so the
 * 401/403 and AC7 tests in `providers.test.ts` keep exercising the real Redis-backed limiter.
 */

const takeTokenMock = vi.fn(async (_key: string, _opts: unknown, _maxWaitMs?: number) => {
  return undefined;
});
vi.mock("../../suppliers/ratelimit", () => ({
  takeToken: (key: string, opts: unknown, maxWaitMs?: number) =>
    takeTokenMock(key, opts, maxWaitMs),
}));

const { googleTrendsDemandProvider } = await import("./google-trends");
const { pinterestDemandProvider } = await import("./pinterest");

const respond = (body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));

describe("Google Trends and Pinterest rate-limit keys never carry the secret", () => {
  afterEach(() => {
    takeTokenMock.mockClear();
    vi.unstubAllGlobals();
  });

  it("Google Trends buckets on the constant key market:google_trends", async () => {
    vi.stubGlobal("fetch", respond({ query: "x", points: [] }));
    await googleTrendsDemandProvider().series({ queries: ["x"], granularity: "month", years: 1 });
    expect(takeTokenMock).toHaveBeenCalledTimes(1);
    const [key] = takeTokenMock.mock.calls[0] as [string, unknown];
    expect(key).toBe("market:google_trends");
  });

  it("Pinterest Trends buckets on the constant key market:pinterest_trends", async () => {
    vi.stubGlobal("fetch", respond({ trends: [] }));
    await pinterestDemandProvider().series({ queries: ["x"], granularity: "week", years: 1 });
    expect(takeTokenMock).toHaveBeenCalledTimes(1);
    const [key] = takeTokenMock.mock.calls[0] as [string, unknown];
    expect(key).toBe("market:pinterest_trends");
  });
});

describe("a thrown rate-limit error carries no key material", () => {
  afterEach(() => vi.doUnmock("../../suppliers/ratelimit"));

  it("rate limit wait exceeded uses only the constant key, never a secret", async () => {
    vi.doUnmock("../../suppliers/ratelimit");
    vi.resetModules();
    const { takeToken } = await import("../../suppliers/ratelimit");
    const key = "market:google_trends"; // the constant every real market adapter now uses
    // Drain the one token, then force the next wait past a 5ms deadline so takeToken throws
    // its "rate limit wait exceeded" error instead of actually waiting out the real bucket.
    await takeToken(key, { capacity: 1, perMs: 1 });
    await expect(takeToken(key, { capacity: 1, perMs: 1_000_000 }, 5)).rejects.toThrow(
      "rate limit wait exceeded for market:google_trends",
    );
    try {
      await takeToken(key, { capacity: 1, perMs: 1_000_000 }, 5);
      throw new Error("expected takeToken to throw");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // No key/token ever looks like this: only the constant source name.
      expect(message).toBe("rate limit wait exceeded for market:google_trends");
      expect(message).not.toMatch(/[A-Za-z0-9_-]{20,}/);
    }
  });
});
