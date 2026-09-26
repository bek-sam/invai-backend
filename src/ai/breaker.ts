import { ORPCError } from "@orpc/server";
import { withTenant } from "../db/client";
import { env } from "../env";
import { logger } from "../lib/log";
import { redis } from "../lib/queues";
import { raiseAlert } from "../modules/today/service";

/*
 * Global AI spend breaker (B-15, wave 8 contract stub B). Two daily counters in Valkey, in cents:
 *   ai:spend:platform:<YYYY-MM-DD>              every tenant's real-model spend today
 *   ai:spend:tenant:<companyId>:<YYYY-MM-DD>    one tenant's real-model spend today
 * `assertSpendAvailable` is one MGET before every real provider call; `recordSpend` INCRBYs the
 * call's costCents after the ai_jobs row is written. Days are UTC. Mock calls (no key, or a sample
 * workspace) cost 0 and never read or write the counters. A cap of 0 (or less) turns that scope
 * off.
 *
 * The per-tenant credit ledger (credits.ts) is still the primary per-tenant limit; this breaker
 * is the backstop against a runaway loop or a leaked key. If Valkey does not answer within
 * CHECK_TIMEOUT_MS the check fails open (logged): the credit check has already run, and BullMQ is
 * down with Valkey anyway.
 */

const log = logger("ai.breaker");

/** Counters and alert flags outlive their day by 2h so a late INCRBY never resets them. */
export const SPEND_TTL_SECONDS = 26 * 60 * 60;
const CHECK_TIMEOUT_MS = 500;

export type SpendScope = "platform" | "tenant";

export const spendDay = (now: Date) => now.toISOString().slice(0, 10);
export const platformSpendKey = (day: string) => `ai:spend:platform:${day}`;
export const tenantSpendKey = (companyId: string, day: string) =>
  `ai:spend:tenant:${companyId}:${day}`;
const alertedKey = (scope: SpendScope, key: string, day: string) =>
  `ai:spend:alerted:${scope}:${key}:${day}`;

function nextUtcMidnight(now: Date): string {
  const d = new Date(now);
  d.setUTCHours(24, 0, 0, 0);
  return d.toISOString();
}

export function spendCaps() {
  return {
    platform: env.AI_DAILY_PLATFORM_CAP_CENTS,
    tenant: env.AI_DAILY_TENANT_CAP_CENTS,
  };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`valkey did not answer in ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Throws AI_SPEND_CAP_REACHED (429) when today's tenant or platform spend has reached its cap.
 * The tenant scope is checked first (it is the one the shop can act on). The first hit of a scope
 * each day raises a critical alert on the calling company.
 */
export async function assertSpendAvailable(
  companyId: string,
  now = new Date(),
  caps: { platform: number; tenant: number } = spendCaps(),
): Promise<void> {
  if (caps.platform <= 0 && caps.tenant <= 0) return;
  const day = spendDay(now);
  let values: (string | null)[];
  try {
    values = await withTimeout(
      redis.mget(tenantSpendKey(companyId, day), platformSpendKey(day)),
      CHECK_TIMEOUT_MS,
    );
  } catch (err) {
    log.error("spend check skipped: valkey unavailable", { error: (err as Error).message });
    return;
  }
  const tenantSpent = Number(values[0] ?? 0);
  const platformSpent = Number(values[1] ?? 0);
  if (caps.tenant > 0 && tenantSpent >= caps.tenant) {
    await capReached(companyId, "tenant", caps.tenant, tenantSpent, now);
  }
  if (caps.platform > 0 && platformSpent >= caps.platform) {
    await capReached(companyId, "platform", caps.platform, platformSpent, now);
  }
}

async function capReached(
  companyId: string,
  scope: SpendScope,
  capCents: number,
  spentCents: number,
  now: Date,
): Promise<never> {
  const day = spendDay(now);
  const resetAt = nextUtcMidnight(now);
  await alertOnce(companyId, scope, capCents, spentCents, day).catch((err) =>
    log.error("could not raise spend-cap alert", { scope, error: (err as Error).message }),
  );
  throw new ORPCError("AI_SPEND_CAP_REACHED", {
    status: 429,
    message: "AI spend cap reached; try again after it resets",
    data: { scope, capCents, spentCents, resetAt },
  });
}

async function alertOnce(
  companyId: string,
  scope: SpendScope,
  capCents: number,
  spentCents: number,
  day: string,
) {
  const flag = alertedKey(scope, scope === "tenant" ? companyId : "all", day);
  const first = await redis.set(flag, companyId, "EX", SPEND_TTL_SECONDS, "NX");
  if (first !== "OK") return;
  log.error("AI spend cap reached", { scope, companyId, capCents, spentCents, day });
  const dollars = (c: number) => `$${(c / 100).toFixed(2)}`;
  await withTenant(companyId, (tx) =>
    raiseAlert(tx, companyId, {
      kind: scope === "tenant" ? "ai_spend_cap_tenant" : "ai_spend_cap_platform",
      severity: "critical",
      title:
        scope === "tenant"
          ? "AI spend cap reached for today"
          : "Platform AI spend cap reached for today",
      message:
        scope === "tenant"
          ? `This workspace spent ${dollars(spentCents)} on AI today (cap ${dollars(capCents)}). AI features pause until midnight UTC.`
          : `InvAI's daily AI spend cap (${dollars(capCents)}) was reached. AI features pause for every workspace until midnight UTC.`,
      dedupeKey: `ai_spend_cap:${scope}:${day}`,
      data: { scope, capCents, spentCents, day },
    }),
  );
}

/**
 * Adds a finished call's real cost to today's counters. Runs after the ai_jobs transaction; the
 * call is already billed by Anthropic, so a Valkey failure is logged, never thrown.
 */
export async function recordSpend(companyId: string, costCents: number, now = new Date()) {
  if (!(costCents > 0)) return;
  const day = spendDay(now);
  const p = platformSpendKey(day);
  const t = tenantSpendKey(companyId, day);
  try {
    await withTimeout(
      redis
        .multi()
        .incrby(p, costCents)
        .expire(p, SPEND_TTL_SECONDS, "NX")
        .incrby(t, costCents)
        .expire(t, SPEND_TTL_SECONDS, "NX")
        .exec(),
      CHECK_TIMEOUT_MS * 4,
    );
  } catch (err) {
    log.error("could not record AI spend", { companyId, costCents, error: (err as Error).message });
  }
}
