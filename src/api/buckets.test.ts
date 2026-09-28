import type { ProcedureMeta } from "@invai/contracts";
import { call } from "@orpc/server";
import { beforeAll, describe, expect, it } from "vitest";
import { checkRateLimit, RATE_BUCKET_LIMITS } from "../lib/ratelimit";
import { createCompany, createUser } from "../test/fixtures";
import { anonymousContext, type Context, permissionsFor } from "./context";
import { AI_CHEAP_READS, bucketFor } from "./orpc";
import { router } from "./router";

/*
 * B-133 (wave 18 gate, issue 1): the web polls `ai.credits.balance` and lists conversations,
 * cheap reads that never call a model, yet they drained the 20/min `ai` bucket and blocked the
 * assistant's `ask`. They now count against `reads`; every model-calling procedure stays in `ai`.
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

/** `call()` has no router path unless told; the limiter classifies by it, so pass the real one. */
const BALANCE = ["ai", "credits", "balance"] as const;

const meta = (auth?: ProcedureMeta["auth"]): ProcedureMeta =>
  ({ permission: "org.read", auth }) as unknown as ProcedureMeta;

describe("bucketFor (B-133)", () => {
  it("routes the cheap ai reads to reads and every model-calling ai procedure to ai", () => {
    for (const name of AI_CHEAP_READS)
      expect(bucketFor(name.split("."), meta(), "GET")).toBe("reads");
    expect(bucketFor(["ai", "assistant", "ask"], meta(), "POST")).toBe("ai");
    expect(bucketFor(["ai", "listings", "create"], meta(), "POST")).toBe("ai");
    expect(bucketFor(["ai", "listings", "regenerate"], meta(), "POST")).toBe("ai");
    expect(bucketFor(["ai", "tools", "trademarkCheck"], meta(), "POST")).toBe("ai");
    expect(bucketFor(["orders", "list"], meta(), "GET")).toBe("reads");
    expect(bucketFor(["orders", "hold"], meta(), "POST")).toBe("writes");
    expect(bucketFor(["floor", "login"], meta("station"), "POST")).toBe("auth");
  });

  it("25 credit-balance reads in a minute do not block an ask; the 21st ask is still limited", async () => {
    const company = await createCompany();
    const user = await createUser(company.id, "owner");
    const ctx = userContext(company.id, user.id);
    for (let i = 0; i < 25; i++) {
      const res = (await call(
        procedureAt("ai.credits.balance"),
        {},
        { context: ctx, path: BALANCE },
      )) as {
        remaining: number;
      };
      expect(typeof res.remaining).toBe("number");
    }
    // The ai bucket is still full: all 20 tokens can be taken.
    const ai = RATE_BUCKET_LIMITS.ai;
    for (let i = 0; i < ai.capacity; i++) {
      expect((await checkRateLimit("ai", company.id, ai)).allowed).toBe(true);
    }
    // ...and now the 21st ai call in the minute is refused before the handler (no model call).
    // `ask` streams, so the middleware's error surfaces when the iterator is consumed.
    const asked = await call(
      procedureAt("ai.assistant.ask"),
      { message: "hello" },
      { context: ctx, path: ["ai", "assistant", "ask"] },
    ).then(
      async (out) => {
        const events: unknown[] = [];
        for await (const e of out as AsyncIterable<unknown>) events.push(e);
        return { events };
      },
      (err: unknown) => ({ error: err as { code?: string } }),
    );
    expect(asked).toMatchObject({ error: { code: "RATE_LIMITED" } });
    // Reads are separate: the balance still answers.
    const still = (await call(
      procedureAt("ai.credits.balance"),
      {},
      { context: ctx, path: BALANCE },
    )) as {
      remaining: number;
    };
    expect(typeof still.remaining).toBe("number");
  });
});

describe("rate limit buckets: sanity", () => {
  beforeAll(() => {
    expect(RATE_BUCKET_LIMITS.links.capacity).toBe(60);
  });
  it("keeps the ai bucket small and the links bucket separate", () => {
    expect(RATE_BUCKET_LIMITS.ai.capacity).toBe(20);
    expect(RATE_BUCKET_LIMITS.reads.capacity).toBeGreaterThan(RATE_BUCKET_LIMITS.ai.capacity);
  });
});
