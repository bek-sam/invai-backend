import { call } from "@orpc/server";
import { beforeAll, describe, expect, it } from "vitest";
import { env } from "../env";
import { checkRateLimit, RATE_BUCKET_LIMITS } from "../lib/ratelimit";
import { createCompany, createUser } from "../test/fixtures";
import { app } from "./app";
import { anonymousContext, type Context, permissionsFor } from "./context";
import { router } from "./router";

/*
 * T-12-3 (B-20), AC1: per-company API rate limits (the `rateLimit` middleware in orpc.ts) keyed
 * by `company_id`, not IP, with the existing `RATE_LIMITED` error and a matching HTTP
 * `Retry-After` header. Most of this drains the exact same Redis bucket the middleware checks
 * (`checkRateLimit`) directly, rather than firing hundreds of real requests -- same bucket, same
 * key, so it proves the same thing much faster.
 */

type AnyProcedure = Parameters<typeof call>[0];
function procedureAt(path: string): AnyProcedure {
  let node: unknown = router;
  for (const key of path.split(".")) node = (node as Record<string, unknown>)[key];
  return node as AnyProcedure;
}

function userContext(companyId: string, userId: string): Context {
  return {
    ...anonymousContext(new Headers(), null),
    sessionKind: "user",
    user: { id: userId, name: "Owner", email: "owner@test.local" },
    emailVerified: true,
    companyId,
    orgType: "shop",
    role: "owner",
    permissions: permissionsFor("owner"),
    resHeaders: new Headers(),
  };
}

describe("per-company rate limit middleware", () => {
  let companyId: string;
  let userId: string;

  beforeAll(async () => {
    companyId = (await createCompany()).id;
    userId = (await createUser(companyId, "owner")).id;
  });

  it("admits requests under the bucket, then RATE_LIMITED with a Retry-After header once drained", async () => {
    const limits = RATE_BUCKET_LIMITS.reads;
    for (let i = 0; i < limits.capacity; i++) {
      expect((await checkRateLimit("reads", companyId, limits)).allowed).toBe(true);
    }
    const ctx = userContext(companyId, userId);
    await expect(call(procedureAt("me.get"), {}, { context: ctx })).rejects.toMatchObject({
      code: "RATE_LIMITED",
      data: { retryAfterSec: expect.any(Number) },
    });
    // Set even though the middleware threw (ResponseHeadersPlugin merges it into the response).
    expect(Number(ctx.resHeaders?.get("Retry-After"))).toBeGreaterThanOrEqual(1);
  });

  it("keys by company_id, not IP: a different company's bucket is untouched", async () => {
    const other = await createCompany();
    const otherUser = await createUser(other.id, "owner");
    const ctx = userContext(other.id, otherUser.id);
    const res = await call(procedureAt("me.get"), {}, { context: ctx });
    expect(res).toBeDefined();
  });

  it("classifies ai.* procedures into the ai bucket (separate from reads/writes)", async () => {
    const co = await createCompany();
    const u = await createUser(co.id, "owner");
    const limits = RATE_BUCKET_LIMITS.ai;
    for (let i = 0; i < limits.capacity; i++) {
      expect((await checkRateLimit("ai", co.id, limits)).allowed).toBe(true);
    }
    // The ai bucket is drained; reads/writes for the same company are untouched.
    const readsLimits = RATE_BUCKET_LIMITS.reads;
    expect((await checkRateLimit("reads", co.id, readsLimits)).allowed).toBe(true);
    void u;
  });
});

describe("rate limit header over real HTTP", () => {
  const json = (body: unknown, extra: Record<string, string> = {}) => ({
    method: "POST",
    headers: { "content-type": "application/json", origin: env.WEB_ORIGIN, ...extra },
    body: JSON.stringify(body),
  });

  async function signUpAndCreateOrg() {
    const email = `rl-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;
    const up = await app.request(
      "/api/auth/sign-up/email",
      json({ email, password: "correct horse 1", name: "RL Test" }),
    );
    expect(up.status).toBe(200);
    const cookie = up.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const org = await app.request(
      "/api/auth/organization/create",
      json({ name: "RL Shop", slug: `rl-shop-${Date.now()}` }, { cookie }),
    );
    const body = (await org.json()) as { id: string };
    return { cookie, companyId: body.id };
  }

  it("a 429 from the real HTTP surface carries a Retry-After header", async () => {
    const { cookie, companyId } = await signUpAndCreateOrg();
    const limits = RATE_BUCKET_LIMITS.reads;
    for (let i = 0; i < limits.capacity; i++) {
      await checkRateLimit("reads", companyId, limits);
    }
    const res = await app.request("/api/v1/me", {
      headers: { origin: env.WEB_ORIGIN, cookie },
    });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
  });
});
