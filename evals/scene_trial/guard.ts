import { PHOTO_SCENE_KINDS, type PhotoSceneKind } from "@invai/contracts";
import { and, eq, gte, sql } from "drizzle-orm";
import { withSystem } from "../../src/db/client";
import { aiJobs } from "../../src/db/schema";

/*
 * The spend guard of the scene trial runner (T-37-2 AC4, T-38-2), kept apart from run.ts so a
 * test in src/ can pin it without starting the runner.
 */

/** Cents spent on every OpenAI call (any kind, so paid text routes count too) since `since`, all tenants. */
export async function ledgerCents(since: Date): Promise<number> {
  const [row] = await withSystem((tx) =>
    tx
      .select({ cents: sql<number>`coalesce(sum(${aiJobs.costCents}), 0)::int` })
      .from(aiJobs)
      .where(and(eq(aiJobs.provider, "openai"), gte(aiJobs.createdAt, since))),
  );
  return row?.cents ?? 0;
}

/** Refuses when the ledger plus the worst case of the coming run would pass the budget. */
export function budgetVerdict(opts: {
  ledger: number;
  worstCase: number;
  budget: number;
}): { ok: boolean; reason: string } {
  const total = opts.ledger + opts.worstCase;
  return total > opts.budget
    ? {
        ok: false,
        reason: `ledger ${opts.ledger}c + worst case ${opts.worstCase}c = ${total}c exceeds the budget ${opts.budget}c`,
      }
    : {
        ok: true,
        reason: `ledger ${opts.ledger}c + worst case ${opts.worstCase}c <= ${opts.budget}c`,
      };
}

/**
 * The paid-run refusals of the runner, in the order it applies them: the provider must have been
 * asked for in the process env, --yes-paid must be present, the provider must have resolved to the
 * real one, and the ledger plus the worst case must fit the budget. Null means the run may go on.
 */
export function paidRunRefusal(opts: {
  paid: boolean;
  requestedOpenAi: boolean;
  yesPaid: boolean;
  providerName: string;
  ledger: number;
  worstCase: number;
  budget: number;
}): string | null {
  if (!opts.paid && !opts.requestedOpenAi) return null;
  if (!opts.requestedOpenAi) return "refused: IMAGE_GEN_PROVIDER=openai is not set in the process environment";
  if (!opts.yesPaid) return "refused: a paid run needs --yes-paid";
  if (!opts.paid)
    return `refused: openai was requested but the provider resolved to ${opts.providerName} (missing key, paid AI not opted in, or sample workspace: set INVAI_PAID_AI=1 in the shell)`;
  const v = budgetVerdict(opts);
  return v.ok ? null : `refused before any call: ${v.reason}`;
}

/** `--kinds studio,home,...` as the scene kinds passed to createSet; null when the flag is absent. */
export function parseKinds(raw: string | null, scenes: number): PhotoSceneKind[] | null {
  if (raw === null) return null;
  const kinds = raw.split(",").map((k) => k.trim());
  const valid = new Set<string>(PHOTO_SCENE_KINDS);
  const bad = kinds.find((k) => !valid.has(k));
  if (bad !== undefined) throw new Error(`--kinds: "${bad}" is not a scene kind (${PHOTO_SCENE_KINDS.join(", ")})`);
  if (kinds.length !== scenes) throw new Error(`--kinds must list exactly ${scenes} kinds (one per scene), got ${kinds.length}`);
  return kinds as PhotoSceneKind[];
}
