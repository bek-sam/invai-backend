import { afterEach, describe, expect, it, vi } from "vitest";
import { redis } from "./queues";
import { betterAuthConsume, checkRateLimit, RATE_BUCKET_LIMITS, takeToken } from "./ratelimit";

/*
 * T-12-3 (B-20): per-tenant API rate limits, a Valkey token bucket keyed by company_id (AC1), and
 * Better Auth's own rate limiter moved off its per-process in-memory Map onto the same Redis
 * (AC2). Both fail open on a Redis error/timeout (AC3), matching the existing convention in this
 * file (PIN lockouts).
 */

const uniq = () => crypto.randomUUID();

describe("per-tenant token bucket (AC1)", () => {
  it("admits up to capacity, then rejects with a retryAfterSec that later admits the next request", async () => {
    const key = `test:${uniq()}`;
    const limits = { capacity: 3, refillPerSec: 3 }; // fast refill so the test doesn't sleep long
    for (let i = 0; i < 3; i++) {
      const res = await takeToken(key, limits);
      expect(res.allowed).toBe(true);
    }
    // The 4th (N+1th) request inside the window is rejected.
    const denied = await takeToken(key, limits);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSec).toBeGreaterThanOrEqual(1);

    // After waiting retryAfterSec, the next request is actually admitted.
    await new Promise((r) => setTimeout(r, denied.retryAfterSec * 1000 + 50));
    const after = await takeToken(key, limits);
    expect(after.allowed).toBe(true);
  });

  it("keeps auth/reads/writes/ai as separate buckets for the same company", async () => {
    const companyId = uniq();
    const tiny = { capacity: 1, refillPerSec: 1 / 60 };
    expect((await checkRateLimit("reads", companyId, tiny)).allowed).toBe(true);
    // Draining "reads" doesn't touch "writes", "auth" or "ai" for the same company.
    expect((await checkRateLimit("reads", companyId, tiny)).allowed).toBe(false);
    expect((await checkRateLimit("writes", companyId, tiny)).allowed).toBe(true);
    expect((await checkRateLimit("auth", companyId, tiny)).allowed).toBe(true);
    expect((await checkRateLimit("ai", companyId, tiny)).allowed).toBe(true);
  });

  it("keeps two companies' buckets separate", async () => {
    const tiny = { capacity: 1, refillPerSec: 1 / 60 };
    const a = uniq();
    const b = uniq();
    expect((await checkRateLimit("writes", a, tiny)).allowed).toBe(true);
    expect((await checkRateLimit("writes", a, tiny)).allowed).toBe(false);
    // Company B's bucket is untouched by A's exhaustion.
    expect((await checkRateLimit("writes", b, tiny)).allowed).toBe(true);
  });

  it("has sane production defaults for every bucket", () => {
    for (const bucket of ["auth", "reads", "writes", "ai"] as const) {
      expect(RATE_BUCKET_LIMITS[bucket].capacity).toBeGreaterThan(0);
      expect(RATE_BUCKET_LIMITS[bucket].refillPerSec).toBeGreaterThan(0);
    }
  });
});

describe("fail-open on Redis trouble (AC3)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("a timed-out token bucket check allows the request", async () => {
    vi.spyOn(redis, "eval").mockImplementation(() => new Promise(() => {})); // never resolves
    const res = await takeToken(`test:${uniq()}`, { capacity: 1, refillPerSec: 1 });
    expect(res.allowed).toBe(true);
    expect(res.retryAfterSec).toBe(0);
  });

  it("a rejected token bucket check allows the request", async () => {
    vi.spyOn(redis, "eval").mockRejectedValue(new Error("ECONNREFUSED"));
    const res = await takeToken(`test:${uniq()}`, { capacity: 1, refillPerSec: 1 });
    expect(res.allowed).toBe(true);
  });

  it("a timed-out Better Auth consume check allows the request", async () => {
    vi.spyOn(redis, "eval").mockImplementation(() => new Promise(() => {}));
    const res = await betterAuthConsume(`test:${uniq()}`, { window: 60, max: 1 });
    expect(res.allowed).toBe(true);
    expect(res.retryAfter).toBeNull();
  });
});

describe("Better Auth rate limiting moved to Valkey (AC2)", () => {
  it("two 'processes' sharing one Redis see the combined count, not each their own", async () => {
    const key = `test:${uniq()}`;
    const rule = { window: 60, max: 5 };
    // Two independent call sites (simulating two API processes -- each with no shared JS state,
    // only the same Redis) hitting the same key. If the counter were per-process (Better Auth's
    // default in-memory `storage: "memory"`), each "process" alternating below would see its own
    // count of 1, 2, 3 and neither would ever trip `max: 5` even after 10 combined requests.
    const processA = () => betterAuthConsume(key, rule);
    const processB = () => betterAuthConsume(key, rule);

    const results: { allowed: boolean; retryAfter: number | null }[] = [];
    for (let i = 0; i < 6; i++) results.push(await (i % 2 === 0 ? processA : processB)());

    // Requests 1-5 (combined, across both "processes") are admitted; the 6th trips the limit.
    expect(results.slice(0, 5).every((r) => r.allowed)).toBe(true);
    expect(results[5]?.allowed).toBe(false);
    expect(results[5]?.retryAfter).toBeGreaterThanOrEqual(1);
  });

  it("fixed window resets once it elapses, from either 'process'", async () => {
    const key = `test:${uniq()}`;
    const rule = { window: 1, max: 1 };
    expect((await betterAuthConsume(key, rule)).allowed).toBe(true);
    expect((await betterAuthConsume(key, rule)).allowed).toBe(false);
    await new Promise((r) => setTimeout(r, 1100));
    expect((await betterAuthConsume(key, rule)).allowed).toBe(true);
  });
});
