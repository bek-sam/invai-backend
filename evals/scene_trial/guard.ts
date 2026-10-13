import { PHOTO_CHANNELS, PHOTO_SCENE_KINDS, type PhotoChannel, type PhotoSceneKind } from "@invai/contracts";
import { ImageGenError, type ImageProvider } from "../../src/ai/images/types";
import { and, eq, gte, sql } from "drizzle-orm";
import { isDarkBlank, SCENE_PROMPT_LIGHT_REF, SCENE_PROMPT_REF } from "../../src/ai/images/scene-prompt";
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

/** Safety margin added to the worst case of every run (T-41-5 A13: 6 x 2 x 11 + 33 = 165c). */
export const MARGIN_CENTS = 33;
/** Stated upper time of one provider call, used for the end-of-day check (T-41-5 A13). */
export const PER_CALL_UPPER_SECONDS = 180;
/** A paid run must be over this long before the UTC day ends (23:30Z). */
export const CUTOFF_UTC_MINUTES = 23 * 60 + 30;

/** The prompt ref a blank's scenes use: v5 only for dark blanks (luma < 0.35), else the frozen v4. */
export function promptLabelForBlank(blankHex: string): string {
  return isDarkBlank(blankHex) ? SCENE_PROMPT_REF : SCENE_PROMPT_LIGHT_REF;
}

/** Calls a trial can make at most: every scene retries once, or fewer when --max-calls (N) says so. */
export function maxCallsFor(opts: { scenes: number; control: boolean; maxCalls?: number | null }): number {
  if (opts.control) return 1;
  const full = opts.scenes * 2;
  return opts.maxCalls == null ? full : Math.min(full, opts.maxCalls);
}

/** Worst case of a run in cents: min(scenes x 2, N) calls at the price, plus the margin (T-43-2). */
export function worstCaseCents(opts: {
  scenes: number;
  control: boolean;
  perImage: number;
  maxCalls?: number | null;
}): number {
  return maxCallsFor(opts) * opts.perImage + MARGIN_CENTS;
}

/** `--max-calls N`: a positive whole number; null when the flag is absent. */
export function parseMaxCalls(raw: string | null): number | null {
  if (raw === null) return null;
  if (!/^[1-9][0-9]*$/.test(raw.trim())) throw new Error(`--max-calls must be a positive whole number, got "${raw}"`);
  return Number(raw.trim());
}

/** `--channels etsy,shopify` checked against the photo channel enum; the default stays shopify,etsy. */
export function parseChannels(raw: string | null): PhotoChannel[] {
  if (raw === null) return ["shopify", "etsy"];
  const list = raw.split(",").map((c) => c.trim());
  const valid = new Set<string>(PHOTO_CHANNELS);
  const bad = list.find((c) => !valid.has(c));
  if (bad !== undefined) throw new Error(`--channels: "${bad}" is not a photo channel (${PHOTO_CHANNELS.join(", ")})`);
  if (list.length === 0 || new Set(list).size !== list.length) throw new Error("--channels must list each channel once");
  return list as PhotoChannel[];
}

/**
 * The call limit of a trial (--max-calls N). Compositions run one after another; `begin()` marks
 * the start of the next scene. A call is refused when N calls were made already, and a retry (a
 * second call inside one scene) is refused when the calls left would take a first try from a
 * scene that has not started (first tries are reserved). A refusal never reaches the provider.
 */
export function createCallLimiter(opts: { maxCalls: number; scenes: number }) {
  let total = 0;
  let begun = 0;
  let inScene = 0;
  return {
    begin() {
      begun += 1;
      inScene = 0;
    },
    /** Null when the call may go ahead (and counts it); else why it is refused. */
    take(): string | null {
      const left = opts.maxCalls - total;
      if (left <= 0) return `--max-calls ${opts.maxCalls} reached: ${total} calls made`;
      if (inScene >= 1) {
        const waiting = Math.max(0, opts.scenes - begun);
        if (left <= waiting)
          return `--max-calls ${opts.maxCalls}: ${left} call(s) left are reserved for ${waiting} scene(s) without a first try`;
      }
      total += 1;
      inScene += 1;
      return null;
    },
    get calls() {
      return total;
    },
  };
}

/**
 * Wraps generateScene on the provider object itself (the singleton getImageProvider returns, which
 * renderSceneJob fetches on its own). A refused call throws a non-retryable ImageGenError that is
 * never billed. Returns the restore function.
 */
export function limitProviderCalls(
  provider: ImageProvider,
  limiter: ReturnType<typeof createCallLimiter>,
): () => void {
  const real = provider.generateScene;
  provider.generateScene = async (input) => {
    const refusal = limiter.take();
    if (refusal) throw new ImageGenError(`refused before the provider: ${refusal}`, false);
    return real.call(provider, input);
  };
  return () => {
    provider.generateScene = real;
  };
}

/** A paid path has no defaults: budget and since must both be given (A12). Null means fine. */
export function paidInputsRefusal(opts: {
  paidPath: boolean;
  budgetRaw: string | undefined;
  sinceRaw: string | undefined;
}): string | null {
  if (!opts.paidPath) return null;
  const missing = [
    opts.budgetRaw === undefined || opts.budgetRaw === "" ? "SCENE_TRIAL_BUDGET_CENTS" : null,
    opts.sinceRaw === undefined || opts.sinceRaw === "" ? "SCENE_TRIAL_SINCE" : null,
  ].filter((m): m is string => m !== null);
  return missing.length
    ? `refused: a paid run needs ${missing.join(" and ")} set explicitly (no defaults on the paid path)`
    : null;
}

/** Refuses when the run's worst case would not end before 23:30Z of the UTC day it starts on. */
export function dayEndRefusal(opts: { now: Date; calls: number }): string | null {
  const day = opts.now.toISOString().slice(0, 10);
  const cutoff = Date.parse(`${day}T00:00:00.000Z`) + CUTOFF_UTC_MINUTES * 60_000;
  const end = opts.now.getTime() + opts.calls * PER_CALL_UPPER_SECONDS * 1000;
  return end > cutoff
    ? `refused: ${opts.calls} calls at up to ${PER_CALL_UPPER_SECONDS}s would end ${new Date(end).toISOString()}, after the 23:30Z cutoff of ${day}`
    : null;
}

export type RunCaps = { shopCap: number; platformCap: number };

/**
 * The caps the runner applies in its own process (never raising a product cap):
 *   per-shop = today's counted rows + 2 x scenes, refused when that passes the configured cap;
 *   platform = current spend counter + (budget - ledger), never above the configured platform cap
 *   (0 or less there means the product cap is off), and refused when it would not cover the
 *   worst case on top of the counter.
 */
export function computeCaps(opts: {
  configuredShopCap: number;
  shopRowsToday: number;
  scenes: number;
  control: boolean;
  platformSpendNow: number;
  configuredPlatformCap: number;
  budget: number;
  ledger: number;
  worstCase: number;
}): { caps: RunCaps; refusal: null } | { caps: null; refusal: string } {
  const shopNeeded = opts.shopRowsToday + (opts.control ? 1 : 2 * opts.scenes);
  if (shopNeeded > opts.configuredShopCap)
    return {
      caps: null,
      refusal: `refused: shop has ${opts.shopRowsToday} rows today, the run needs up to ${shopNeeded}, over the configured per-shop cap ${opts.configuredShopCap}`,
    };
  const room = opts.platformSpendNow + Math.max(0, opts.budget - opts.ledger);
  const platformCap =
    opts.configuredPlatformCap > 0 ? Math.min(room, opts.configuredPlatformCap) : room;
  if (platformCap < opts.platformSpendNow + opts.worstCase)
    return {
      caps: null,
      refusal: `refused: platform cap ${platformCap}c (spend now ${opts.platformSpendNow}c, configured ${opts.configuredPlatformCap}c) cannot cover the worst case ${opts.worstCase}c`,
    };
  return { caps: { shopCap: shopNeeded, platformCap }, refusal: null };
}
