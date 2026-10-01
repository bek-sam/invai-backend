import { ORPCError } from "@orpc/server";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { withTenant } from "../db/client";
import { aiCreditLedger, aiJobs, alerts } from "../db/schema";
import { env as realEnv } from "../env";
import { redis } from "../lib/queues";
import { createCompany } from "../test/fixtures";
import { platformSpendKey, spendDay, tenantSpendKey } from "./breaker";
import { chargeCredits, creditBalance } from "./credits";
import { runAssistant } from "./gateway";
import { DEFAULT_MODEL, tokensToCostCents, tokensToCredits } from "./models";
import { ASSISTANT_PROMPT } from "./prompts";
import { anthropicProvider } from "./providers/anthropic";
import type {
  AssistantFinal,
  AssistantRun,
  AssistantStreamEvent,
  AssistantTool,
  ProviderAssistantEvent,
  TokenUsage,
  ToolOutput,
} from "./providers/types";

/*
 * T-P7-5 (B-115): the gateway records spend after every real model round and re-checks the daily
 * caps and the credits before the next round goes out. The real provider is stood in for by a
 * scripted generator that behaves like the SDK runner: a round's request is "sent" only when the
 * generator is pulled, and it yields a `round` event after each round's final message.
 */

/** `env` is `as const` (read-only in types only); these tests flip the AI key flag and caps. */
const env = realEnv as unknown as {
  mocks: { ai: boolean };
  AI_DAILY_PLATFORM_CAP_CENTS: number;
  AI_DAILY_TENANT_CAP_CENTS: number;
};

type Round = { tokensIn: number; tokensOut: number; stopReason: string; text?: string };
const ROUND: Omit<Round, "stopReason"> = { tokensIn: 10_000, tokensOut: 2_000 };
// 10k in at $5/MTok + 2k out at $25/MTok = 5 + 5 cents per round.
const ROUND_CENTS = 10;

type Script = {
  requests: number;
  closed: boolean;
  /** Tenant spend counter as the scripted provider saw it when each request went out. */
  counterAtRequest: (number | null)[];
};

function scriptProvider(companyId: string, passes: Round[][], toolName?: string) {
  const s: Script = { requests: 0, closed: false, counterAtRequest: [] };
  let pass = 0;
  const spy = vi.spyOn(anthropicProvider, "assistant").mockImplementation(async function* (
    run: AssistantRun,
    onUsage?: (u: TokenUsage) => void,
  ): AsyncGenerator<ProviderAssistantEvent, AssistantFinal> {
    const rounds = passes[Math.min(pass, passes.length - 1)] ?? [];
    pass++;
    const total: TokenUsage = { tokensIn: 0, tokensOut: 0, cacheReadTokens: 0 };
    let last: string | null = null;
    try {
      for (const r of rounds) {
        // The runner runs the previous round's tools, then sends this round's request.
        if (last === "tool_use" && toolName) {
          const t = run.tools.find((x) => x.name === toolName);
          if (t) {
            yield { type: "tool_call", name: t.name, input: {} };
            const out = await t.run({});
            yield { type: "tool_result", name: t.name, summary: out.summary, meta: out.meta };
          }
        }
        s.requests++;
        const v = await redis.get(tenantSpendKey(companyId, spendDay(new Date())));
        s.counterAtRequest.push(v == null ? null : Number(v));
        yield { type: "text", text: r.text ?? `round ${s.requests}. ` };
        total.tokensIn += r.tokensIn;
        total.tokensOut += r.tokensOut;
        onUsage?.({ ...total });
        last = r.stopReason;
        yield {
          type: "round",
          usage: { ...total },
          model: DEFAULT_MODEL,
          stopReason: r.stopReason,
        };
      }
    } finally {
      s.closed = true;
    }
    return { usage: total, model: DEFAULT_MODEL, stopReason: last };
  });
  return { s, spy };
}

async function drive(companyId: string, tools: AssistantTool[] = [], message = "How are sales?") {
  const events: AssistantStreamEvent[] = [];
  let settledWith: { credits: number } | null = null;
  const gen = runAssistant(
    { companyId, userId: null, kind: "assistant", creditKind: "assistant" },
    { system: ASSISTANT_PROMPT.system, history: [], message, tools, now: new Date() },
    (r) => {
      settledWith = r;
    },
  );
  let error: unknown = null;
  let result: Awaited<ReturnType<typeof gen.next>>["value"] | null = null;
  try {
    let step = await gen.next();
    while (!step.done) {
      events.push(step.value);
      step = await gen.next();
    }
    result = step.value;
  } catch (err) {
    error = err;
  }
  const text = events.flatMap((e) => (e.type === "text" ? [e.text] : [])).join("");
  return { events, text, error, result, settledWith: settledWith as { credits: number } | null };
}

const lastJob = async (companyId: string) => {
  const rows = await withTenant(companyId, (tx) =>
    tx.select().from(aiJobs).where(eq(aiJobs.companyId, companyId)),
  );
  expect(rows).toHaveLength(1);
  return rows[0] as typeof aiJobs.$inferSelect;
};
const charged = async (companyId: string) => {
  const rows = await withTenant(companyId, (tx) =>
    tx.select().from(aiCreditLedger).where(eq(aiCreditLedger.companyId, companyId)),
  );
  return rows.reduce((n, r) => n - r.credits, 0);
};
const counter = async (companyId: string) =>
  Number((await redis.get(tenantSpendKey(companyId, spendDay(new Date())))) ?? 0);

describe("assistant spend per round (T-P7-5, B-115)", () => {
  const saved = {
    ai: env.mocks.ai,
    platform: env.AI_DAILY_PLATFORM_CAP_CENTS,
    tenant: env.AI_DAILY_TENANT_CAP_CENTS,
  };
  const touched: string[] = [];
  let platformBefore = 0;

  beforeEach(async () => {
    env.mocks.ai = false;
    // Platform scope off: these tests only move their own tenant's counter.
    env.AI_DAILY_PLATFORM_CAP_CENTS = 0;
    platformBefore = Number((await redis.get(platformSpendKey(spendDay(new Date())))) ?? 0);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    env.mocks.ai = saved.ai;
    env.AI_DAILY_PLATFORM_CAP_CENTS = saved.platform;
    env.AI_DAILY_TENANT_CAP_CENTS = saved.tenant;
    const day = spendDay(new Date());
    // Give back what these tests added to the shared platform counter, and drop tenant keys.
    const added = Number((await redis.get(platformSpendKey(day))) ?? 0) - platformBefore;
    if (added > 0) await redis.decrby(platformSpendKey(day), added);
    for (const id of touched.splice(0)) {
      await redis.del(tenantSpendKey(id, day), `ai:spend:alerted:tenant:${id}:${day}`);
    }
  });

  const shop = async () => {
    const co = await createCompany();
    touched.push(co.id);
    return co;
  };

  it("AC1+AC3: the tenant cap trips after round 1, so round 2 is never sent; rounds made are charged", async () => {
    const co = await shop();
    env.AI_DAILY_TENANT_CAP_CENTS = 1;
    const { s } = scriptProvider(co.id, [
      [
        { ...ROUND, stopReason: "tool_use" },
        { ...ROUND, stopReason: "tool_use" },
        { ...ROUND, stopReason: "end_turn" },
      ],
    ]);
    const r = await drive(co.id);

    expect(s.requests).toBe(1);
    expect(s.closed).toBe(true);
    // What was answered so far reached the stream, then the typed error the service maps to
    // `{ type: "error", code: "spend_cap" }`.
    expect(r.text).toBe("round 1. ");
    expect(r.error).toBeInstanceOf(ORPCError);
    expect((r.error as ORPCError<string, unknown>).code).toBe("AI_SPEND_CAP_REACHED");

    const job = await lastJob(co.id);
    expect(job).toMatchObject({
      status: "done",
      stopReason: "spend_cap",
      tokensIn: ROUND.tokensIn,
      tokensOut: ROUND.tokensOut,
      costCents: ROUND_CENTS,
      credits: tokensToCredits({ ...ROUND, cacheReadTokens: 0 }),
    });
    expect(await charged(co.id)).toBe(job.credits);
    expect(r.settledWith?.credits).toBe(job.credits);
    // Recorded once, not twice (round + finish).
    expect(await counter(co.id)).toBe(ROUND_CENTS);
    // The existing breaker path raised the critical alert.
    const raised = await withTenant(co.id, (tx) =>
      tx
        .select()
        .from(alerts)
        .where(and(eq(alerts.companyId, co.id), eq(alerts.kind, "ai_spend_cap_tenant"))),
    );
    expect(raised).toHaveLength(1);
    expect(raised[0]?.severity).toBe("critical");
  });

  it("AC2: under the cap, spend lands after each round and the run total equals ai_jobs.costCents", async () => {
    const co = await shop();
    env.AI_DAILY_TENANT_CAP_CENTS = 1_000_000;
    const { s } = scriptProvider(co.id, [
      [
        { tokensIn: 12_345, tokensOut: 1_111, stopReason: "tool_use" },
        { tokensIn: 23_456, tokensOut: 333, stopReason: "pause_turn" },
        { tokensIn: 34_567, tokensOut: 2_777, stopReason: "end_turn" },
      ],
    ]);
    const r = await drive(co.id);

    expect(r.error).toBeNull();
    expect(s.requests).toBe(3);
    expect(r.text).toBe("round 1. round 2. round 3. ");
    // A parallel question would see this run's spend before its next round went out.
    expect(s.counterAtRequest[0]).toBeNull();
    expect(s.counterAtRequest[1]).toBeGreaterThan(0);
    expect(s.counterAtRequest[2]).toBeGreaterThan(s.counterAtRequest[1] ?? 0);

    const job = await lastJob(co.id);
    const usage = { tokensIn: 70_368, tokensOut: 4_221, cacheReadTokens: 0 };
    expect(job).toMatchObject({ status: "done", stopReason: "end_turn", ...usage });
    // Same price as before this change: one price of the whole usage, recorded exactly once.
    expect(job.costCents).toBe(tokensToCostCents(usage, DEFAULT_MODEL));
    expect(await counter(co.id)).toBe(job.costCents);
    expect(await charged(co.id)).toBe(tokensToCredits(usage));
  });

  it("an end_turn round is never checked: a finished answer is not turned into an error", async () => {
    const co = await shop();
    env.AI_DAILY_TENANT_CAP_CENTS = 1;
    const { s } = scriptProvider(co.id, [[{ ...ROUND, stopReason: "end_turn", text: "Done." }]]);
    const r = await drive(co.id);
    expect(r.error).toBeNull();
    expect(s.requests).toBe(1);
    expect(r.text).toBe("Done.");
    const job = await lastJob(co.id);
    expect(job).toMatchObject({ status: "done", stopReason: "end_turn", costCents: ROUND_CENTS });
    expect(await counter(co.id)).toBe(ROUND_CENTS);
  });

  it("AC4: credits that can't cover the next round stop the run the same way", async () => {
    const co = await shop();
    env.AI_DAILY_TENANT_CAP_CENTS = 0;
    await withTenant(co.id, async (tx) => {
      const b = await creditBalance(tx, co.id);
      await chargeCredits(tx, {
        companyId: co.id,
        kind: "assistant",
        credits: b.remaining - 2,
        model: null,
        usage: null,
      });
    });
    const before = await charged(co.id);
    const { s } = scriptProvider(co.id, [
      [
        { ...ROUND, stopReason: "tool_use" },
        { ...ROUND, stopReason: "end_turn" },
      ],
    ]);
    const r = await drive(co.id);

    expect(s.requests).toBe(1);
    expect((r.error as ORPCError<string, unknown>).code).toBe("CREDITS_EXHAUSTED");
    const job = await lastJob(co.id);
    expect(job).toMatchObject({ status: "done", stopReason: "credits_exhausted" });
    // The round that ran is charged in full (12 credits), once.
    expect((await charged(co.id)) - before).toBe(tokensToCredits({ ...ROUND, cacheReadTokens: 0 }));
  });

  it("a market answer's regeneration is skipped when the cap is spent: the tools' answer is shown", async () => {
    const co = await shop();
    env.AI_DAILY_TENANT_CAP_CENTS = 1;
    const out: ToolOutput = {
      data: { rows: [{ label: "Spooky Pumpkin Ghost", trend: "rising", growth4w: 0.18 }] },
      summary: "Market trend: 1 rising",
      answer: "Spooky Pumpkin Ghost: rising, +18.0% over 4 weeks. Google Trends (Sample data).",
      meta: { mock: true, sources: [], recommendations: [] },
    };
    const tool: AssistantTool = {
      name: "get_market_trend",
      description: "trend",
      input: z.object({}),
      run: async () => out,
    };
    const { s, spy } = scriptProvider(
      co.id,
      [
        [
          { tokensIn: 100, tokensOut: 10, stopReason: "tool_use", text: "" },
          { ...ROUND, stopReason: "end_turn", text: "This niche is up 900%!" },
        ],
      ],
      "get_market_trend",
    );
    // Round 1 is under the cap (well under a cent); round 2 then spends past it, so the check
    // before the regeneration trips.
    const r = await drive(co.id, [tool], "Which of my designs are trending?");

    expect(r.error).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(s.requests).toBe(2);
    expect(r.text).not.toContain("900");
    expect(r.text).toContain("+18.0% over 4 weeks");
    const job = await lastJob(co.id);
    expect(job).toMatchObject({ status: "done", stopReason: "spend_cap" });
    expect(await counter(co.id)).toBe(job.costCents);
  });

  it("AC5: the mock provider never reads or moves the counters, even over the cap", async () => {
    const co = await shop();
    env.mocks.ai = true;
    env.AI_DAILY_TENANT_CAP_CENTS = 1;
    const day = spendDay(new Date());
    await redis.set(tenantSpendKey(co.id, day), "999", "EX", 60);
    const mget = vi.spyOn(redis, "mget");
    const real = vi.spyOn(anthropicProvider, "assistant");
    const r = await drive(co.id, [], "Hello");
    expect(r.error).toBeNull();
    expect(r.text.length).toBeGreaterThan(0);
    expect(mget).not.toHaveBeenCalled();
    expect(real).not.toHaveBeenCalled();
    expect(await redis.get(tenantSpendKey(co.id, day))).toBe("999");
    const job = await lastJob(co.id);
    expect(job).toMatchObject({ status: "done", costCents: 0 });
  });
});
