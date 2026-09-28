import { DIGEST_CONFIG as C } from "./config";
import type { Candidate, History, Ranked, RankedDigest } from "./types";

/*
 * Ranking (spec pipeline 6): score = impact × confidence × severity weight. D1 is pinned first
 * (one row per channel, never dropped). Then at most 3 actions, 1 win, and at most 2 Market watch
 * items. A market item takes an action slot only when promotable (R1 with a cross-listing gap or
 * a low blank, R3) and scores into the top 3; at most one does. Repeat suppression (AC12): voted
 * down last week → score × 0.5; shown 3 weeks running with no click → out of the top 3.
 */

export function scoreOf(c: Candidate, history: History): number {
  const impact = Math.max(c.impactCents ?? 0, C.ranking.minImpactCents);
  let score = impact * c.confidence * C.ranking.severity[c.detector];
  if (history.votedDownLastWeek.has(c.fingerprint)) score *= C.ranking.votedDownFactor;
  return Math.round(score * 1000) / 1000;
}

const byScore = (a: { score: number; fingerprint: string }, b: typeof a) =>
  b.score - a.score || a.fingerprint.localeCompare(b.fingerprint);

export function rank(candidates: Candidate[], history: History): RankedDigest {
  const scored = candidates.map((c) => ({ ...c, score: scoreOf(c, history) }));
  const tired = (c: Candidate) =>
    (history.weeksShownWithoutAction.get(c.fingerprint) ?? 0) >=
    C.ranking.maxWeeksShownWithoutAction;

  const pinned = scored.filter((c) => c.detector === "D1").sort(byScore);
  const pool = scored
    .filter(
      (c) =>
        c.detector !== "D1" &&
        (c.section === "action" || (c.section === "market" && c.promotable)) &&
        !tired(c),
    )
    .sort(byScore);

  const actions: (Candidate & { score: number })[] = [...pinned];
  let marketInActions = 0;
  for (const c of pool) {
    if (actions.length >= Math.max(C.ranking.maxActions, pinned.length)) break;
    if (c.section === "market") {
      if (marketInActions >= 1) continue;
      marketInActions++;
    }
    actions.push(c);
  }
  // D1 rows are all kept (one per channel), but never more than the contract's 3 slots.
  const shownActions = actions.slice(0, C.ranking.maxActions);
  const taken = new Set(shownActions.map((c) => c.fingerprint));

  const win = scored.filter((c) => c.section === "win").sort(byScore)[0] ?? null;
  const marketWatch = scored
    .filter((c) => c.section === "market" && !taken.has(c.fingerprint))
    .sort(byScore)
    .slice(0, C.ranking.maxMarket);

  let n = 0;
  const withRank = (c: Candidate & { score: number }): Ranked => ({ ...c, rank: ++n });
  const rankedActions = shownActions.map(withRank);
  const rankedWin = win ? withRank(win) : null;
  const rankedMarket = marketWatch.map(withRank);
  return {
    actions: rankedActions,
    win: rankedWin,
    marketWatch: rankedMarket,
    steady: rankedActions.length === 0,
  };
}
