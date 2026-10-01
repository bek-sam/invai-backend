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

  // B-229 part 1: this used real timers, so the two full-jitter retry sleeps (up to ~500ms then
  // ~1000ms) made the test's actual duration flaky and slow. An injected sleep makes it
  // deterministic and fast, and the fetch call count now asserts the retry budget directly
  // instead of just the final error — no assertion is weaker than before.
  //
  // `vi.useFakeTimers()` (sinon's full clock install) was tried first and reproducibly hung this
  // test: `takeToken`'s real Redis round trip (the per-provider rate limiter http.ts always
  // calls first) never resolved once a sinon fake clock was installed, even restricted to
  // `toFake: ["setTimeout", "clearTimeout"]` (confirmed with a standalone repro against the same
  // Redis client). Stubbing just the global `setTimeout` function to run its callback
  // immediately avoids that: ioredis and pg resolve a prior-cached reference to the *real*
  // setTimeout from module load time, so only http.ts's own `sleep()` (which looks up
  // `globalThis.setTimeout` fresh on every call) is affected.
  it("gives up after exhausting retries on a persistent 500", async () => {
    vi.stubGlobal("setTimeout", ((fn: () => void) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    const fetchSpy = respond(500, { message: "down" });
    vi.stubGlobal("fetch", fetchSpy);
    await expect(fetchJsonWithPolicy(policy())).rejects.toThrow(MarketProviderError);
    expect(fetchSpy).toHaveBeenCalledTimes(3); // 1 initial attempt + 2 retries, then give up
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
