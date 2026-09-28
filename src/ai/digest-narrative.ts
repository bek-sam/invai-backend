import { ORPCError } from "@orpc/server";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { withSystem, withTenant } from "../db/client";
import { aiJobs } from "../db/schema";
import { logger } from "../lib/log";
import { redis } from "../lib/queues";
import { raiseAlert } from "../modules/today/service";
import { creditBalance } from "./credits";
import { runStructured } from "./gateway";
import { ROUTES, tokensToCostCents } from "./models";
import { type DigestNarrativeVars, dataBlock, digestNarrativePrompt } from "./prompts";
import { type NarrativeRule, type RenderedNarrative, validateNarrative } from "./validators/digest";

/*
 * Weekly digest AI summary (T-19-2; spec weekly-digest pipeline 8–10, AC18–AC22).
 *
 * One single-shot call per digest, no tools, through the gateway (credits, PII scrub, ai_jobs,
 * spend breaker). The model sees the ranked insights and their formatted facts inside a data
 * block and answers with `{{factId}}` placeholders only; code substitutes the values and the
 * validator (validators/digest.ts) hard-fails anything else. No retry: any failure means the
 * caller keeps the template text.
 *
 * Mode `off | shadow | on` is global. Wave 19 ships `shadow` (built, validated, stored, never shown
 * or sent) until OI-8; `showable` is true only in `on`, and nothing in this wave sets `on`. A
 * breaker flips the effective mode to `shadow` when more than 10% of summaries in 24 h were
 * rejected, and raises a critical alert.
 */

const log = logger("ai.digest-narrative");

export type DigestLang = "en" | "es";
export type DigestSummaryMode = "off" | "shadow" | "on";
export type DigestNarrativeStatus = "ok" | "rejected" | "skipped_budget" | "skipped_off";

/** One computed fact. The model sees `{{id}}`; code substitutes `formatted[lang]`. */
export type NarrativeFact = {
  id: string;
  raw: number | string | null;
  formatted: { en: string; es: string };
};

/** One ranked insight, in display order. `factIds` are the only facts its text may use. */
export type NarrativeInsight = {
  id: string;
  kind: "data_health" | "action" | "win" | "market" | "glance" | "steady";
  factIds: string[];
  /** The code-written template for this insight in `lang`, placeholders unfilled (trusted copy). */
  template?: string;
};

export type DigestNarrativeInput = {
  digestId: string;
  lang: DigestLang;
  insights: NarrativeInsight[];
  facts: NarrativeFact[];
};

export type DigestNarrativeResult = {
  status: DigestNarrativeStatus;
  /** Substituted summary text (status `ok` only). */
  text?: string;
  /** The same, split into headline and items (status `ok` only), for storage. */
  summary?: Omit<RenderedNarrative, "text">;
  failedRules?: string[];
  /** Real cost of this call in cents (0 on the mock, on a skip, or when reusing a stored run). */
  cents: number;
  /** The effective mode this call ran under. */
  mode: DigestSummaryMode;
  /** True only in mode `on` with status `ok`. In `shadow` the caller stores it and never shows it. */
  showable: boolean;
};

/* ------------------------------------ config ------------------------------------ */

/** Credit reserve (spec pipeline 9): below this many credits left, no call. */
export const DIGEST_CREDIT_RESERVE = 25;
/** Breaker: more than this share of summaries rejected in the window flips the mode to shadow. */
export const BREAKER_REJECT_RATE = 0.1;
export const BREAKER_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Set while the breaker holds the mode at shadow. No TTL: a person clears it after a look. */
export const BREAKER_KEY = "ai:digest_summary:breaker";
const REDIS_TIMEOUT_MS = 500;

/*
 * The switches are T-19-4's (`DIGEST_SUMMARY_MODE`, default shadow; `DIGEST_MAX_CENTS_PER_WEEK`,
 * default 10) in src/env.ts. Read from process.env here with the same names and defaults, at call
 * time, so this card doesn't depend on that commit.
 */
const Switches = z.object({
  DIGEST_SUMMARY_MODE: z.enum(["off", "shadow", "on"]).catch("shadow").default("shadow"),
  DIGEST_MAX_CENTS_PER_WEEK: z.coerce.number().int().min(0).catch(10).default(10),
});
export function digestSwitches() {
  return Switches.parse({
    DIGEST_SUMMARY_MODE: process.env.DIGEST_SUMMARY_MODE || undefined,
    DIGEST_MAX_CENTS_PER_WEEK: process.env.DIGEST_MAX_CENTS_PER_WEEK || undefined,
  });
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
 * Global AI summary mode, breaker-aware. `off` stays off. A tripped breaker, or a breaker state
 * that can't be read, gives `shadow` (fails closed: shadow output is never shown).
 */
export async function digestSummaryMode(): Promise<DigestSummaryMode> {
  const configured = digestSwitches().DIGEST_SUMMARY_MODE;
  if (configured !== "on") return configured;
  try {
    const tripped = await withTimeout(redis.get(BREAKER_KEY), REDIS_TIMEOUT_MS);
    return tripped ? "shadow" : "on";
  } catch (err) {
    log.warn("breaker state unreadable; summary mode held at shadow", {
      error: (err as Error).message,
    });
    return "shadow";
  }
}

/* ------------------------------------ call ------------------------------------ */

const budgetErrors = new Set(["CREDITS_EXHAUSTED", "AI_SPEND_CAP_REACHED"]);

function varsFor(input: DigestNarrativeInput): DigestNarrativeVars {
  return {
    lang: input.lang,
    insights: input.insights.map((i) => ({
      id: i.id,
      kind: i.kind,
      factIds: i.factIds,
      template: i.template ?? null,
    })),
    facts: input.facts.map((f) => ({ id: f.id, value: f.formatted[input.lang] })),
  };
}

/**
 * Worst-case cost before the call: the whole prompt as input (about 3.5 characters a token, no
 * cache) and the route's full `maxTokens` as output.
 */
export function estimateNarrativeCents(vars: DigestNarrativeVars): number {
  const route = ROUTES.digest_narrative;
  const chars = digestNarrativePrompt.system.length + digestNarrativePrompt.user(vars).length;
  return tokensToCostCents(
    { tokensIn: Math.ceil(chars / 3.5), tokensOut: route.maxTokens, cacheReadTokens: 0 },
    route.model,
  );
}

/** Real spend on summaries for this shop in the 7 days before `now`, in cents. */
async function weekSpentCents(companyId: string, now: Date): Promise<number> {
  const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const [row] = await withTenant(companyId, (tx) =>
    tx
      .select({ cents: sql<number>`coalesce(sum(${aiJobs.costCents}), 0)::int` })
      .from(aiJobs)
      .where(
        and(
          eq(aiJobs.companyId, companyId),
          eq(aiJobs.kind, "digest_narrative"),
          gte(aiJobs.createdAt, since),
        ),
      ),
  );
  return row?.cents ?? 0;
}

/** The finished call for this digest, if any: one charge per digest, reused on a rebuild. */
async function priorRun(companyId: string, digestId: string) {
  const [row] = await withTenant(companyId, (tx) =>
    tx
      .select({ id: aiJobs.id, output: aiJobs.output })
      .from(aiJobs)
      .where(
        and(
          eq(aiJobs.companyId, companyId),
          eq(aiJobs.kind, "digest_narrative"),
          eq(aiJobs.entityType, "digest"),
          eq(aiJobs.entityId, digestId),
          eq(aiJobs.status, "done"),
        ),
      )
      .orderBy(aiJobs.createdAt)
      .limit(1),
  );
  return row ?? null;
}

/** Stores the validation outcome on the ai_jobs row (the breaker counts these). */
async function recordOutcome(
  companyId: string,
  aiJobId: string,
  outcome: { status: "ok" | "rejected"; failedRules: string[]; mode: DigestSummaryMode },
) {
  await withTenant(companyId, (tx) =>
    tx
      .update(aiJobs)
      .set({
        output: sql`coalesce(${aiJobs.output}, '{}'::jsonb) || ${JSON.stringify({ validation: outcome })}::jsonb`,
      })
      .where(eq(aiJobs.id, aiJobId)),
  );
}

function checked(
  output: unknown,
  input: DigestNarrativeInput,
): { ok: true; rendered: RenderedNarrative } | { ok: false; failedRules: NarrativeRule[] } {
  const v = validateNarrative(output, input);
  return v.ok ? { ok: true, rendered: v.rendered } : { ok: false, failedRules: v.failedRules };
}

/**
 * Writes the digest summary for one shop's digest. Never throws for a model or budget problem:
 * the status says what happened and the caller keeps the template text for anything but an
 * `ok` that is `showable`.
 */
export async function generateDigestNarrative(
  companyId: string,
  input: DigestNarrativeInput,
  now = new Date(),
): Promise<DigestNarrativeResult> {
  const mode = await digestSummaryMode();
  const base = { cents: 0, mode, showable: false };
  if (mode === "off") return { ...base, status: "skipped_off" };

  const done = (r: ReturnType<typeof checked>, cents: number): DigestNarrativeResult =>
    r.ok
      ? {
          status: "ok",
          text: r.rendered.text,
          summary: { headline: r.rendered.headline, items: r.rendered.items },
          cents,
          mode,
          showable: mode === "on",
        }
      : { status: "rejected", failedRules: r.failedRules, cents, mode, showable: false };

  // A rebuild of the same digest reuses the stored output: no second call, no second charge.
  const prior = await priorRun(companyId, input.digestId);
  if (prior) {
    const { validation: _v, ...output } = (prior.output ?? {}) as Record<string, unknown>;
    return done(checked(output, input), 0);
  }

  const vars = varsFor(input);
  const estimate = estimateNarrativeCents(vars);
  const cap = digestSwitches().DIGEST_MAX_CENTS_PER_WEEK;
  if ((await weekSpentCents(companyId, now)) + estimate > cap) {
    log.info("digest summary skipped: weekly cap", { companyId, estimate, cap });
    return { ...base, status: "skipped_budget" };
  }
  const balance = await withTenant(companyId, (tx) => creditBalance(tx, companyId, now));
  if (balance.remaining < DIGEST_CREDIT_RESERVE) {
    log.info("digest summary skipped: credit reserve", { companyId, remaining: balance.remaining });
    return { ...base, status: "skipped_budget" };
  }

  let run: Awaited<ReturnType<typeof runStructured<DigestNarrativeVars, unknown>>>;
  try {
    run = await runStructured(
      {
        companyId,
        userId: null,
        kind: "digest_narrative",
        creditKind: "digest_narrative",
        entity: { type: "digest", id: input.digestId },
      },
      digestNarrativePrompt,
      vars,
    );
  } catch (err) {
    if (err instanceof ORPCError && budgetErrors.has(err.code)) {
      log.info("digest summary skipped: AI budget", { companyId, code: err.code });
      return { ...base, status: "skipped_budget" };
    }
    // Refusal, cut-off or schema failure: the gateway marked the ai_jobs row failed; the breaker
    // counts it as a rejection.
    log.warn("digest summary rejected: model call failed", {
      companyId,
      digestId: input.digestId,
      error: (err as Error).message,
    });
    await checkDigestSummaryBreaker(companyId, now).catch(breakerError);
    return { ...base, status: "rejected", failedRules: ["schema"] };
  }

  const [job] = await withTenant(companyId, (tx) =>
    tx.select({ costCents: aiJobs.costCents }).from(aiJobs).where(eq(aiJobs.id, run.aiJobId)),
  );
  const result = done(checked(run.output, input), job?.costCents ?? 0);
  await recordOutcome(companyId, run.aiJobId, {
    status: result.status === "ok" ? "ok" : "rejected",
    failedRules: result.failedRules ?? [],
    mode,
  });
  if (result.status === "rejected")
    // The metric: one structured log line per rejection, with the rule ids.
    log.warn("digest summary rejected", {
      companyId,
      digestId: input.digestId,
      failedRules: result.failedRules,
      promptRef: `${digestNarrativePrompt.id}@${digestNarrativePrompt.version}`,
    });
  await checkDigestSummaryBreaker(companyId, now).catch(breakerError);
  return result;
}

const breakerError = (err: unknown) =>
  log.error("digest summary breaker check failed", { error: (err as Error).message });

/* ------------------------------------ breaker ------------------------------------ */

/**
 * Rejection rate of digest summaries in the 24 hours before `now`, across every shop. A failed
 * model call counts as a rejection. Cross-tenant by design (a global breaker): `withSystem`,
 * counts only, no row content leaves this function.
 */
export async function digestSummaryRejectRate(now = new Date()) {
  const since = new Date(now.getTime() - BREAKER_WINDOW_MS);
  const [row] = await withSystem((tx) =>
    tx
      .select({
        total: sql<number>`count(*)::int`,
        rejected: sql<number>`(count(*) filter (where ${aiJobs.status} = 'failed' or ${aiJobs.output}->'validation'->>'status' = 'rejected'))::int`,
      })
      .from(aiJobs)
      .where(
        and(
          eq(aiJobs.kind, "digest_narrative"),
          inArray(aiJobs.status, ["done", "failed"]),
          gte(aiJobs.createdAt, since),
        ),
      ),
  );
  const total = row?.total ?? 0;
  const rejected = row?.rejected ?? 0;
  return { total, rejected, rate: total > 0 ? rejected / total : 0 };
}

/**
 * Trips the breaker when more than 10% of summaries were rejected in 24 hours: the mode is held
 * at `shadow` (Valkey flag, set once) and a critical alert is raised on the shop whose summary
 * tipped it, plus an error log for the platform. Returns whether it tripped on this call.
 */
export async function checkDigestSummaryBreaker(companyId: string, now = new Date()) {
  const stats = await digestSummaryRejectRate(now);
  if (!(stats.rate > BREAKER_REJECT_RATE)) return { tripped: false, ...stats };
  const first = await redis.set(BREAKER_KEY, now.toISOString(), "NX");
  if (first !== "OK") return { tripped: false, ...stats };
  log.error("digest summary breaker tripped: AI summary mode held at shadow", {
    companyId,
    ...stats,
  });
  const day = now.toISOString().slice(0, 10);
  await withTenant(companyId, (tx) =>
    raiseAlert(tx, companyId, {
      kind: "ai_summary_breaker",
      severity: "critical",
      title: "AI summaries paused",
      message:
        "Too many AI-written digest summaries failed their checks today, so InvAI switched them off. Your digest still arrives with the standard summary.",
      dedupeKey: `ai_summary_breaker:${day}`,
      data: { ...stats, day },
    }),
  ).catch((err) =>
    log.error("could not raise digest breaker alert", { error: (err as Error).message }),
  );
  return { tripped: true, ...stats };
}

/** Exported for the eval harness: the exact text the model receives for one digest. */
export const narrativeUserBlock = (input: DigestNarrativeInput) =>
  dataBlock("digest_facts", varsFor(input));
