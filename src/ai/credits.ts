import type { CreditsBalance } from "@invai/contracts";
import { ORPCError } from "@orpc/server";
import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "../db/client";
import { aiCreditLedger } from "../db/schema";
import { emit } from "../lib/outbox";
import { currentUsage, getPlan, periodOf, recordUsage } from "../modules/billing/service";
import type { TokenUsage } from "./providers/types";

/*
 * Per-company AI credit ledger. The plan's monthly allowance plus purchased packs, minus usage
 * (billing's monthly meter, which every charge also bumps). Features pause at zero.
 */

export type CreditKind = (typeof aiCreditLedger.$inferInsert)["kind"];

export async function creditBalance(
  tx: Tx,
  companyId: string,
  at = new Date(),
): Promise<CreditsBalance> {
  const p = periodOf(at);
  const plan = await getPlan(tx, companyId);
  const [packs] = await tx
    .select({ n: sql<number>`coalesce(sum(${aiCreditLedger.credits}), 0)::int` })
    .from(aiCreditLedger)
    .where(
      and(
        eq(aiCreditLedger.companyId, companyId),
        eq(aiCreditLedger.period, p.key),
        eq(aiCreditLedger.kind, "pack"),
      ),
    );
  const used = (await currentUsage(tx, companyId, at)).aiCredits;
  const allowance = plan.aiCreditsPerMonth;
  const remaining = allowance + (packs?.n ?? 0) - used;
  return {
    periodStart: p.start.toISOString(),
    periodEnd: p.end.toISOString(),
    allowance,
    packs: packs?.n ?? 0,
    used,
    remaining,
    paused: remaining <= 0,
  };
}

export function creditsExhausted(remaining: number, periodEnd: string) {
  return new ORPCError("CREDITS_EXHAUSTED", {
    status: 402,
    message: "AI credits used up for this period",
    data: { remaining, periodEnd },
  });
}

/** Throws CREDITS_EXHAUSTED when fewer than `needed` credits remain. */
export async function assertCredits(tx: Tx, companyId: string, needed = 1) {
  const b = await creditBalance(tx, companyId);
  if (b.remaining < needed) throw creditsExhausted(b.remaining, b.periodEnd);
  return b;
}

export async function chargeCredits(
  tx: Tx,
  input: {
    companyId: string;
    kind: CreditKind;
    credits: number;
    model: string | null;
    usage: TokenUsage | null;
    aiJobId?: string | null;
    ref?: { type: string; id: string } | null;
    userId?: string | null;
  },
) {
  const [row] = await tx
    .insert(aiCreditLedger)
    .values({
      companyId: input.companyId,
      kind: input.kind,
      credits: -Math.abs(input.credits),
      model: input.model,
      tokensIn: input.usage?.tokensIn ?? null,
      tokensOut: input.usage?.tokensOut ?? null,
      cacheReadTokens: input.usage?.cacheReadTokens ?? null,
      aiJobId: input.aiJobId ?? null,
      refType: input.ref?.type ?? null,
      refId: input.ref?.id ?? null,
      userId: input.userId ?? null,
      period: periodOf().key,
    })
    .returning({ id: aiCreditLedger.id });
  await recordUsage(tx, input.companyId, { aiCredits: Math.abs(input.credits) });
  const balance = await creditBalance(tx, input.companyId);
  if (row) {
    await emit(tx, input.companyId, "credits.consumed", {
      entryId: row.id,
      credits: Math.abs(input.credits),
      remaining: balance.remaining,
    });
  }
  return { entryId: row?.id ?? null, remaining: balance.remaining };
}
