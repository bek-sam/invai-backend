import type {
  DigestActionKind,
  DigestActionParams,
  DigestDetector,
  TodayAction,
  TodayActionClick,
  TodayActionClickInput,
  TodayActions,
  TodayActionsInput,
} from "@invai/contracts";
import { ORPCError } from "@orpc/server";
import { and, asc, eq, sql } from "drizzle-orm";
import type { TenantContext } from "../../api/context";
import { type Tx, withTenant } from "../../db/client";
import { todayActionClicks, todayActionSets, todayActions } from "../../db/schema";
import { logger } from "../../lib/log";
import { DIGEST_CONFIG as C } from "../digest/config";
import { detect } from "../digest/detectors";
import { rank } from "../digest/rank";
import { shopInfo } from "../digest/service";
import { computeSnapshot } from "../digest/snapshot";
import type { History } from "../digest/types";
import { addDays, localMidnights, localNow } from "../digest/week";

/*
 * Today's action panel (T-A9, AC-E2; architect ruling 2, `waves/A2/reviews/plan-architect.md`).
 * The same snapshot, detectors and ranking as the weekly digest, over the 7 days ending
 * yesterday in the shop's time zone, up to 5 actions. A job builds the day's set once
 * (`buildTodayActions`, idempotent on (company, date)); the read is a plain SELECT, and a day
 * with no set yet answers `generatedAt: null` and asks for the build.
 */

const log = logger("today.actions");

type Ctx = Pick<TenantContext, "companyId">;
type UserCtx = Pick<TenantContext, "companyId" | "userId">;

/** No repeat suppression on Today: a daily panel shows what is true now. */
const NO_HISTORY: History = { votedDownLastWeek: new Set(), weeksShownWithoutAction: new Map() };

export type TodayWindow = {
  date: string;
  windowStart: string;
  windowEnd: string;
  timezone: string;
};

/** The day (default: today in the shop's time zone) and its window: date − 7 .. date − 1. */
export async function todayWindow(
  tx: Tx,
  ctx: Ctx,
  input: { date?: string },
  at: Date = new Date(),
): Promise<TodayWindow & { today: string }> {
  const { timezone } = await shopInfo(tx, ctx);
  const today = (await localNow(tx, timezone, at)).ymd;
  const date = input.date ?? today;
  return {
    date,
    today,
    windowStart: addDays(date, -C.today.windowDays),
    windowEnd: addDays(date, -1),
    timezone,
  };
}

/** Computes the ranked actions for `date` (no storage). */
export async function computeTodayActions(
  tx: Tx,
  ctx: Ctx,
  input: { date: string },
  at: Date = new Date(),
): Promise<TodayActions> {
  const w = await todayWindow(tx, ctx, input, at);
  const [from, to] = await localMidnights(tx, w.timezone, [w.windowStart, w.date]);
  const snapshot = await computeSnapshot(
    tx,
    ctx,
    {
      weekKey: `day-${w.date}`,
      weekStart: w.windowStart,
      weekEnd: w.date,
      periodFrom: from as Date,
      periodTo: to as Date,
      timezone: w.timezone,
    },
    at,
  );
  const ranked = rank(detect(snapshot), NO_HISTORY, { maxActions: C.today.maxActions });
  const generatedAt = new Date().toISOString();
  return {
    date: w.date,
    windowStart: w.windowStart,
    windowEnd: w.windowEnd,
    actions: ranked.actions.map((r) => ({
      ...r.action,
      key: r.fingerprint,
      rank: r.rank,
      detector: r.detector,
      impactCents: r.impactCents === null ? null : Math.round(r.impactCents),
      clickedAt: null,
    })),
    steady: ranked.actions.length === 0,
    generatedAt,
  };
}

export type BuildTodayResult =
  | { status: "built"; date: string; actions: number }
  | { status: "exists"; date: string };

/**
 * Builds and stores one shop's set for one day. Idempotent: the set row is the guard, so a
 * second run (sweep, read-triggered job, retry) finds it and changes nothing. `force` rebuilds
 * in place: the day's actions are deleted and inserted again in the same transaction (their
 * clicks go with them).
 */
export async function buildTodayActions(
  companyId: string,
  date: string,
  opts: { force?: boolean; at?: Date } = {},
): Promise<BuildTodayResult> {
  return withTenant(companyId, async (tx) => {
    const ctx = { companyId };
    const w = await todayWindow(tx, ctx, { date }, opts.at);
    const inserted = await tx
      .insert(todayActionSets)
      .values({ companyId, date, windowStart: w.windowStart, windowEnd: w.windowEnd })
      .onConflictDoNothing()
      .returning({ id: todayActionSets.id });
    let setId = inserted[0]?.id;
    if (!setId) {
      if (!opts.force) return { status: "exists" as const, date };
      const [locked] = await tx
        .select({ id: todayActionSets.id })
        .from(todayActionSets)
        .where(and(eq(todayActionSets.companyId, companyId), eq(todayActionSets.date, date)))
        .for("update");
      setId = locked?.id;
      if (!setId) throw new Error("today action set vanished during rebuild");
    }
    const set = await computeTodayActions(tx, ctx, { date }, opts.at);
    const now = new Date(set.generatedAt as string);
    await tx
      .delete(todayActions)
      .where(and(eq(todayActions.companyId, companyId), eq(todayActions.date, date)));
    if (set.actions.length)
      await tx.insert(todayActions).values(
        set.actions.map((a) => ({
          companyId,
          setId,
          date,
          key: a.key,
          rank: a.rank,
          detector: a.detector,
          kind: a.kind,
          params: a.params as Record<string, unknown>,
          href: a.href,
          impactCents: a.impactCents,
          generatedAt: now,
        })),
      );
    await tx
      .update(todayActionSets)
      .set({ generatedAt: now, windowStart: w.windowStart, windowEnd: w.windowEnd })
      .where(and(eq(todayActionSets.companyId, companyId), eq(todayActionSets.date, date)));
    log.info("today actions built", { companyId, date, actions: set.actions.length });
    return { status: "built" as const, date, actions: set.actions.length };
  });
}

/** Whether a missing set for `date` may be built now (not in the future, not past retention). */
export function buildable(date: string, today: string): boolean {
  return date <= today && date > addDays(today, -C.today.backfillDays);
}

/**
 * `today.actions`: the stored set with the caller's own clicks. With no set yet, `generatedAt`
 * is null, `actions` empty, `steady` false, and `requestBuild` is called for a buildable date.
 */
export async function getTodayActions(
  tx: Tx,
  ctx: UserCtx,
  input: TodayActionsInput,
  opts: { requestBuild?: (date: string) => void; at?: Date } = {},
): Promise<TodayActions> {
  const w = await todayWindow(tx, ctx, input, opts.at);
  const [set] = await tx
    .select()
    .from(todayActionSets)
    .where(and(eq(todayActionSets.companyId, ctx.companyId), eq(todayActionSets.date, w.date)));
  if (!set) {
    if (buildable(w.date, w.today)) opts.requestBuild?.(w.date);
    return {
      date: w.date,
      windowStart: w.windowStart,
      windowEnd: w.windowEnd,
      actions: [],
      steady: false,
      generatedAt: null,
    };
  }
  const rows = await tx
    .select({ a: todayActions, clickedAt: todayActionClicks.clickedAt })
    .from(todayActions)
    .leftJoin(
      todayActionClicks,
      and(
        eq(todayActionClicks.companyId, todayActions.companyId),
        eq(todayActionClicks.actionId, todayActions.id),
        ctx.userId ? eq(todayActionClicks.userId, ctx.userId) : sql`false`,
      ),
    )
    .where(and(eq(todayActions.companyId, ctx.companyId), eq(todayActions.date, w.date)))
    .orderBy(asc(todayActions.rank))
    .limit(C.today.maxActions);
  const actions: TodayAction[] = rows.map(({ a, clickedAt }) => ({
    kind: a.kind as DigestActionKind,
    params: a.params as DigestActionParams,
    href: a.href,
    key: a.key,
    rank: a.rank,
    detector: a.detector as DigestDetector,
    impactCents: a.impactCents,
    clickedAt: clickedAt ? clickedAt.toISOString() : null,
  }));
  return {
    date: set.date,
    windowStart: set.windowStart,
    windowEnd: set.windowEnd,
    actions,
    steady: actions.length === 0,
    generatedAt: set.generatedAt.toISOString(),
  };
}

export function actionNotFound() {
  return new ORPCError("ACTION_NOT_FOUND", {
    status: 404,
    message: "That action is no longer on Today",
  });
}

/** `today.recordActionClick`: the caller's first click wins; a repeat returns the same time. */
export async function recordActionClick(
  tx: Tx,
  ctx: UserCtx,
  input: TodayActionClickInput,
): Promise<TodayActionClick> {
  if (!ctx.userId) throw actionNotFound();
  const [action] = await tx
    .select({ id: todayActions.id })
    .from(todayActions)
    .where(
      and(
        eq(todayActions.companyId, ctx.companyId),
        eq(todayActions.date, input.date),
        eq(todayActions.key, input.key),
      ),
    );
  if (!action) throw actionNotFound();
  await tx
    .insert(todayActionClicks)
    .values({
      companyId: ctx.companyId,
      actionId: action.id,
      date: input.date,
      key: input.key,
      userId: ctx.userId,
    })
    .onConflictDoNothing();
  const [row] = await tx
    .select({ clickedAt: todayActionClicks.clickedAt })
    .from(todayActionClicks)
    .where(
      and(
        eq(todayActionClicks.companyId, ctx.companyId),
        eq(todayActionClicks.actionId, action.id),
        eq(todayActionClicks.userId, ctx.userId),
      ),
    );
  if (!row) throw actionNotFound();
  return { date: input.date, key: input.key, clickedAt: row.clickedAt.toISOString() };
}
