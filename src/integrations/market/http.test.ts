import { UnrecoverableError } from "bullmq";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchJsonWithPolicy, MARKET_MAX_RESPONSE_BYTES, MarketProviderError } from "./http";

const respond = (status: number, body: unknown = {}) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));

const policy = (overrides: Partial<Parameters<typeof fetchJsonWithPolicy>[0]> = {}) => ({
  source: "google_trends" as const,
  url: "https://trends.googleapis.com/v1alpha1/query",
  rateLimit: { key: `http-test:${crypto.randomUUID()}`, capacity: 10, perMs: 100 },
  ...overrides,
});

describe("fetchJsonWithPolicy", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("refuses a host that isn't on the allowlist, without ever calling fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(
      fetchJsonWithPolicy(policy({ url: "https://evil.example.com/steal" })),
    ).rejects.toThrow(MarketProviderError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("401 and 403 throw UnrecoverableError (a bad key needs a person, not a retry)", async () => {
    vi.stubGlobal("fetch", respond(401));
    await expect(fetchJsonWithPolicy(policy())).rejects.toThrow(UnrecoverableError);
    vi.stubGlobal("fetch", respond(403));
    await expect(fetchJsonWithPolicy(policy())).rejects.toThrow(UnrecoverableError);
  });

  it("retries 429 and 5xx with jitter, then succeeds", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        if (calls < 3) return new Response("{}", { status: calls === 1 ? 429 : 500 });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );
    const result = await fetchJsonWithPolicy<{ ok: boolean }>(policy());
    expect(result).toEqual({ ok: true });
    expect(calls).toBe(3);
  });

  it("gives up after exhausting retries on a persistent 500", async () => {
    vi.stubGlobal("fetch", respond(500, { message: "down" }));
    await expect(fetchJsonWithPolicy(policy())).rejects.toThrow(MarketProviderError);
  });

  it("never follows a redirect (no blind redirects, rule 8)", async () => {
    vi.stubGlobal("fetch", respond(302));
    await expect(fetchJsonWithPolicy(policy())).rejects.toThrow(/redirect/);
  });

  it("caps the response body size instead of reading an unbounded stream", async () => {
    const tooBig = "x".repeat(MARKET_MAX_RESPONSE_BYTES + 1);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(tooBig, { status: 200 })),
    );
    await expect(fetchJsonWithPolicy(policy())).rejects.toThrow(/exceeded/);
  });

  it("a plain 4xx (not 401/403) is a typed MarketProviderError, not UnrecoverableError", async () => {
    vi.stubGlobal("fetch", respond(400, { message: "bad request" }));
    await expect(fetchJsonWithPolicy(policy())).rejects.toThrow(MarketProviderError);
  });

  it("a network error retries, then throws MarketProviderError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("timed out", "TimeoutError");
      }),
    );
    await expect(fetchJsonWithPolicy(policy())).rejects.toThrow(MarketProviderError);
  });
});
