import { and, desc, eq, inArray, lt } from "drizzle-orm";
import {
  type DigestNarrativeResult,
  generateDigestNarrative,
  type NarrativeInsight,
} from "../../ai/digest-narrative";
import { afterCommit, type Tx, withTenant } from "../../db/client";
import { digestClicks, digestFeedback, digestInsights, digests } from "../../db/schema";
import { env } from "../../env";
import { errorData, logger } from "../../lib/log";
import { emit } from "../../lib/outbox";
import { publish } from "../../lib/realtime";
import { listDigestMarketItems, recordRecommendationsShown } from "../market/service";
import { DIGEST_CONFIG as C } from "./config";
import { detect } from "./detectors";
import { changeFact, fact, pctChange } from "./facts";
import { marketCandidates } from "./market-watch";
import { rank } from "./rank";
import { anyReader, recipients, type StoredContent, settingsRow, shopInfo } from "./service";
import { computeSnapshot, type WeekWindow } from "./snapshot";
import type { Candidate, History, Ranked, RankedDigest, Snapshot } from "./types";
import { addDays, isoWeekday, localMidnights, localNow, mondayOfWeekKey } from "./week";

/*
 * Building one shop's digest for one ISO week (spec pipeline 2–12). Idempotent on
 * (company, week key): the row is created once, then built under a row lock; a `ready` or
 * `skipped_quiet` row is never rebuilt, so the sweep and the build job can both run twice (AC2).
 * The AI summary runs after the digest is stored, outside any transaction (it calls the model),
 * and only ever updates `narrative_status` / `narrative`.
 */

const log = logger("digest.build");

export type BuildResult =
  | { status: "ready" | "skipped_quiet"; digestId: string }
  | { status: "exists"; digestId: string }
  | { status: "busy" | "disabled" };

const WEEKDAY_INDEX = { mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6 } as const;

/** The glance block (spec step 6): five metrics with this week, last week and the change. */
export function glanceOf(s: Snapshot): StoredContent["glance"] {
  const row = (
    metric: StoredContent["glance"][number]["metric"],
    unit: "cents" | "pct" | "count" | "ratio",
    cur: number | null,
    prev: number | null,
  ) => {
    const changePct = cur === null ? null : pctChange(cur, prev);
    return {
      metric,
      current: fact(`glance.${metric}`, unit, cur),
      previous: prev === null ? null : fact(`glance.${metric}.previous`, unit, prev),
      changePct: changePct === null ? null : Math.round(changePct * 10) / 10,
      change: changeFact(`glance.${metric}.change`, changePct),
    };
  };
  const hadPrevious = s.previous.orders > 0 || s.previous.revenue !== 0;
  const prev = <T>(v: T) => (hadPrevious ? v : null);
  return [
    row("revenue", "cents", s.current.revenue, prev(s.previous.revenue)),
    row("net", "cents", s.current.net, prev(s.previous.net)),
    row("marginPct", "pct", s.current.marginPct, prev(s.previous.marginPct)),
    row("orders", "count", s.current.orders, prev(s.previous.orders)),
    row(
      "onTimeRate",
      "ratio",
      s.fulfillment.onTimeRate,
      s.fulfillment.previousOnTimeRate === null ? null : s.fulfillment.previousOnTimeRate,
    ),
  ];
}

export function contentFor(s: Snapshot, r: RankedDigest): StoredContent {
  const glance = glanceOf(s);
  const net = glance.find((g) => g.metric === "net");
  return {
    steady: r.steady,
    incompleteOrders: s.incompleteOrders,
    partialChannels: [...new Set(s.unhealthyChannels.map((c) => c.channel))],
    glance,
    net: net?.current ?? null,
    netChange: net?.change ?? null,
    actionCount: r.actions.length,
  };
}

/** Zero orders and no open issues (spec step 7): no email, stored `skipped_quiet`. */
export function isQuiet(s: Snapshot): boolean {
  // Orders whose fees aren't computed yet have no profit line: they still count as orders.
  return (
    s.current.orders === 0 &&
    s.incompleteOrders === 0 &&
    s.fulfillment.overdueNow === 0 &&
    s.unhealthyChannels.length === 0
  );
}

/** Repeat suppression input (AC12) from the digests before `weekStart`. */
async function historyOf(tx: Tx, companyId: string, weekStart: string): Promise<History> {
  const prior = await tx
    .select({ id: digests.id })
    .from(digests)
    .where(
      and(
        eq(digests.companyId, companyId),
        lt(digests.weekStart, weekStart),
        inArray(digests.status, ["ready", "skipped_quiet"]),
      ),
    )
    .orderBy(desc(digests.weekStart))
    .limit(C.ranking.maxWeeksShownWithoutAction);
  const ids = prior.map((p) => p.id);
  if (!ids.length) return { votedDownLastWeek: new Set(), weeksShownWithoutAction: new Map() };
  const shown = await tx
    .select({
      id: digestInsights.id,
      digestId: digestInsights.digestId,
      fingerprint: digestInsights.fingerprint,
    })
    .from(digestInsights)
    .where(
      and(
        eq(digestInsights.companyId, companyId),
        inArray(digestInsights.digestId, ids),
        eq(digestInsights.section, "action"),
      ),
    );
  const insightIds = shown.map((s) => s.id);
  const clicked = insightIds.length
    ? new Set(
        (
          await tx
            .select({ insightId: digestClicks.insightId })
            .from(digestClicks)
            .where(
              and(
                eq(digestClicks.companyId, companyId),
                inArray(digestClicks.insightId, insightIds),
              ),
            )
        ).map((c) => c.insightId),
      )
    : new Set<string>();
  const down = ids[0]
    ? await tx
        .select({ fingerprint: digestInsights.fingerprint })
        .from(digestFeedback)
        .innerJoin(digestInsights, eq(digestInsights.id, digestFeedback.insightId))
        .where(
          and(
            eq(digestFeedback.companyId, companyId),
            eq(digestFeedback.digestId, ids[0]),
            eq(digestFeedback.vote, "down"),
          ),
        )
    : [];
  // Consecutive weeks (most recent first) each fingerprint was shown with no click.
  const streak = new Map<string, number>();
  const broken = new Set<string>();
  for (const d of ids) {
    const here = shown.filter((s) => s.digestId === d);
    const seen = new Set<string>();
    for (const s of here) {
      seen.add(s.fingerprint);
      if (broken.has(s.fingerprint)) continue;
      if (clicked.has(s.id)) {
        broken.add(s.fingerprint);
        continue;
      }
      streak.set(s.fingerprint, (streak.get(s.fingerprint) ?? 0) + 1);
    }
    for (const f of streak.keys()) if (!seen.has(f)) broken.add(f);
  }
  return {
    votedDownLastWeek: new Set(down.map((d) => d.fingerprint)),
    weeksShownWithoutAction: streak,
  };
}

/** Market watch candidates; a missing, stale or throwing market read gives none (AC16). */
async function marketOf(tx: Tx, companyId: string, asOf: Date): Promise<Candidate[]> {
  try {
    // A savepoint, so a failed market query can't abort the digest's own transaction.
    const recs = await tx.transaction((sp) => listDigestMarketItems(sp, { companyId }, { asOf }));
    return marketCandidates(recs, { mockAllowed: !env.isProd });
  } catch (err) {
    log.warn("market watch unavailable; block left out", { companyId, ...errorData(err) });
    return [];
  }
}

async function windowOf(tx: Tx, companyId: string, weekKey: string): Promise<WeekWindow> {
  const shop = await shopInfo(tx, { companyId });
  const weekStart = mondayOfWeekKey(weekKey);
  const weekEnd = addDays(weekStart, 7);
  const [from, to] = await localMidnights(tx, shop.timezone, [weekStart, weekEnd]);
  return {
    weekKey,
    weekStart,
    weekEnd,
    periodFrom: from as Date,
    periodTo: to as Date,
    timezone: shop.timezone,
  };
}

/**
 * Whether email may still go out for this digest at `at` (spec step 3): only on the slot's day,
 * before 20:00 shop time. Before 07:00 on that day it may go later (`wait`).
 */
export async function emailWindow(
  tx: Tx,
  companyId: string,
  row: { weekEnd: string; timezone: string },
  at: Date,
): Promise<"open" | "wait" | "closed"> {
  const s = await settingsRow(tx, { companyId });
  const slotDay = addDays(row.weekEnd, WEEKDAY_INDEX[s.day]);
  const now = await localNow(tx, row.timezone, at);
  if (now.ymd !== slotDay) return now.ymd < slotDay ? "wait" : "closed";
  if (now.hour >= C.schedule.quietFromHour) return "closed";
  if (now.hour < C.schedule.quietUntilHour) return "wait";
  return "open";
}

type Stored = {
  digestId: string;
  status: "ready" | "skipped_quiet";
  ranked: RankedDigest;
  insightIds: Map<Ranked, string>;
  snapshot: Snapshot;
  previousDigestId: string | null;
};

/** Builds and stores the digest inside one transaction holding the row lock. */
async function buildLocked(
  companyId: string,
  weekKey: string,
  at: Date,
): Promise<BuildResult | Stored> {
  return withTenant(companyId, async (tx) => {
    const settings = await settingsRow(tx, { companyId });
    if (!env.DIGEST_ENABLED || !settings.enabled) return { status: "disabled" as const };
    const w = await windowOf(tx, companyId, weekKey);
    await tx
      .insert(digests)
      .values({
        companyId,
        weekKey,
        weekStart: w.weekStart,
        weekEnd: w.weekEnd,
        periodFrom: w.periodFrom,
        periodTo: w.periodTo,
        timezone: w.timezone,
      })
      .onConflictDoNothing();
    const [row] = await tx
      .select()
      .from(digests)
      .where(and(eq(digests.companyId, companyId), eq(digests.weekKey, weekKey)))
      .for("update", { skipLocked: true });
    if (!row) return { status: "busy" as const };
    if (row.status === "ready" || row.status === "skipped_quiet")
      return { status: "exists" as const, digestId: row.id };

    const snapshot = await computeSnapshot(
      tx,
      { companyId },
      { ...w, periodFrom: row.periodFrom, periodTo: row.periodTo, timezone: row.timezone },
      at,
    );
    const quiet = isQuiet(snapshot);
    const history = await historyOf(tx, companyId, row.weekStart);
    const candidates = quiet ? [] : [...detect(snapshot), ...(await marketOf(tx, companyId, at))];
    const ranked = rank(candidates, history);
    const content = contentFor(snapshot, ranked);
    const status = quiet ? ("skipped_quiet" as const) : ("ready" as const);
    const window = await emailWindow(tx, companyId, row, at);

    await tx
      .delete(digestInsights)
      .where(and(eq(digestInsights.companyId, companyId), eq(digestInsights.digestId, row.id)));
    const all: [Ranked, "action" | "win" | "market"][] = [
      ...ranked.actions.map((r) => [r, "action"] as [Ranked, "action"]),
      ...(ranked.win ? [[ranked.win, "win"] as [Ranked, "win"]] : []),
      ...ranked.marketWatch.map((r) => [r, "market"] as [Ranked, "market"]),
    ];
    const insightIds = new Map<Ranked, string>();
    for (const [r, section] of all) {
      const [ins] = await tx
        .insert(digestInsights)
        .values({
          companyId,
          digestId: row.id,
          detector: r.detector,
          section,
          rank: r.rank,
          score: r.score,
          confidence: r.confidence,
          impactCents: r.impactCents === null ? null : Math.round(r.impactCents),
          fingerprint: r.fingerprint,
          templateKey: r.templateKey,
          action: r.action,
          facts: r.facts,
          recommendationId: r.recommendation?.id ?? null,
        })
        .returning({ id: digestInsights.id });
      if (ins) insightIds.set(r, ins.id);
    }
    const shownRecs = all.flatMap(([r]) => (r.recommendation ? [r.recommendation.id] : []));
    if (shownRecs.length)
      await recordRecommendationsShown(
        tx,
        { companyId },
        { ids: shownRecs, shownIn: "digest", refId: row.id },
      );

    const now = new Date();
    await tx
      .update(digests)
      .set({
        status,
        content,
        inAppOnly: window === "closed",
        readyAt: now,
        buildAttempts: row.buildAttempts + 1,
        lastError: null,
        updatedAt: now,
      })
      .where(eq(digests.id, row.id));
    if (status === "ready") {
      await emit(tx, companyId, "digest.ready", { digestId: row.id, weekKey });
      afterCommit(tx, () =>
        publish(companyId, "digest.ready", { digestId: row.id, weekKey }).then(() => undefined),
      );
    }
    const [previous] = await tx
      .select({ id: digests.id })
      .from(digests)
      .where(and(eq(digests.companyId, companyId), lt(digests.weekStart, row.weekStart)))
      .orderBy(desc(digests.weekStart))
      .limit(1);
    return {
      digestId: row.id,
      status,
      ranked,
      insightIds,
      snapshot,
      previousDigestId: previous?.id ?? null,
    };
  });
}

const NARRATIVE_KIND: Record<string, NarrativeInsight["kind"]> = {
  D1: "data_health",
  D8: "win",
  market: "market",
};

/** The AI summary (shadow in wave 19): outside any transaction, then one small update. */
async function narrate(companyId: string, s: Stored): Promise<void> {
  const decision = await withTenant(companyId, async (tx) => {
    const settings = await settingsRow(tx, { companyId });
    const list = await recipients(tx, { companyId });
    const readers = await anyReader(tx, { companyId }, s.previousDigestId);
    const es = list.filter((r) => r.lang === "es").length;
    return { settings, readers, lang: es > list.length / 2 ? ("es" as const) : ("en" as const) };
  });
  let status: "none" | "shadow" | "ok" | "rejected" | "skipped_budget" | "skipped_off" = "none";
  let narrative: Record<string, unknown> = {};
  if (s.status === "ready" && decision.readers) {
    const shown = [
      ...s.ranked.actions,
      ...(s.ranked.win ? [s.ranked.win] : []),
      ...s.ranked.marketWatch,
    ];
    const glance = glanceOf(s.snapshot);
    const facts = [...glance.map((g) => g.current), ...shown.flatMap((r) => r.facts)];
    const insights: NarrativeInsight[] = [
      { id: "glance", kind: "glance", factIds: glance.map((g) => g.current.id) },
      ...shown.map((r) => ({
        id: s.insightIds.get(r) ?? r.fingerprint,
        kind: NARRATIVE_KIND[r.detector] ?? ("action" as const),
        factIds: r.facts.map((f) => f.id),
      })),
    ];
    let result: DigestNarrativeResult;
    try {
      result = await generateDigestNarrative(companyId, {
        digestId: s.digestId,
        lang: decision.lang,
        insights,
        facts: facts.map((f) => ({ id: f.id, raw: f.value, formatted: f.formatted })),
      });
    } catch (err) {
      log.warn("digest summary failed; template kept", { companyId, ...errorData(err) });
      return;
    }
    // In `on` mode a shop that turned the summary off keeps the template (spec pipeline 10).
    status =
      result.status === "ok"
        ? result.mode === "on"
          ? decision.settings.aiSummary
            ? "ok"
            : "skipped_off"
          : "shadow"
        : result.status;
    narrative = {
      mode: result.mode,
      lang: decision.lang,
      cents: result.cents,
      ...(result.text ? { text: result.text } : {}),
      ...(result.summary ? { summary: result.summary } : {}),
      ...(result.failedRules ? { failedRules: result.failedRules } : {}),
    };
  }
  await withTenant(companyId, (tx) =>
    tx
      .update(digests)
      .set({ narrativeStatus: status, narrative, updatedAt: new Date() })
      .where(and(eq(digests.companyId, companyId), eq(digests.id, s.digestId))),
  );
}

/** Build (or return) one shop's digest for one week. Safe to call any number of times. */
export async function buildDigest(
  companyId: string,
  weekKey: string,
  at: Date = new Date(),
): Promise<BuildResult> {
  let out: BuildResult | Stored;
  try {
    out = await buildLocked(companyId, weekKey, at);
  } catch (err) {
    const e = errorData(err);
    log.error("digest build failed", { companyId, weekKey, ...e });
    await withTenant(companyId, (tx) =>
      tx
        .update(digests)
        .set({
          status: "failed",
          lastError: String(e.error ?? "error").slice(0, 500),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(digests.companyId, companyId),
            eq(digests.weekKey, weekKey),
            inArray(digests.status, ["building", "failed"]),
          ),
        ),
    ).catch(() => undefined);
    throw err;
  }
  if (!("ranked" in out)) return out;
  await narrate(companyId, out).catch((err) =>
    log.warn("digest summary step failed", { companyId, ...errorData(err) }),
  );
  log.info("digest built", { companyId, weekKey, status: out.status, digestId: out.digestId });
  return { status: out.status, digestId: out.digestId };
}

/** Local-time slot check used by the sweep's SQL and by tests. */
export function slotReached(
  now: { ymd: string; hour: number },
  s: { day: keyof typeof WEEKDAY_INDEX; hour: number },
): boolean {
  const dow = isoWeekday(now.ymd) - 1;
  const slot = WEEKDAY_INDEX[s.day];
  return dow > slot || (dow === slot && now.hour >= s.hour);
}
