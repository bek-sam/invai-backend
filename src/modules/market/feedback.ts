import { and, eq, gte, isNull, sql } from "drizzle-orm";
import type { Tx } from "../../db/client";
import { designs, marketDesignNiches, marketRecommendations } from "../../db/schema";
import { getProfit } from "../finance/service";
import { MARKET_CONFIG } from "./config";
import { activeListings, currentPrices } from "./history";

/*
 * Recommendation feedback (spec step 7): adoption detection and the 28-day outcome label, run
 * daily per shop. State guards make it idempotent: adoption is set once, an outcome once, and a
 * shop's vote always wins (a voted recommendation is never auto-adopted).
 */

const DAY_MS = 86_400_000;
const F = MARKET_CONFIG.feedback;

type Rec = typeof marketRecommendations.$inferSelect;

function windowDays(rule: Rec["rule"]): number {
  if (rule === "R1") return F.listingWindowDays;
  if (rule === "R4") return F.nicheDesignWindowDays;
  return F.priceWindowDays;
}

async function adopted(tx: Tx, companyId: string, rec: Rec, now: Date): Promise<boolean> {
  const params = rec.params as {
    currentPriceCents?: number;
    channel?: string;
    channels?: string[];
    niche?: string;
  };
  const until = new Date(rec.createdAt.getTime() + windowDays(rec.rule) * DAY_MS);
  if (now > until) return false;
  if ((rec.rule === "R2" || rec.rule === "R3") && rec.designId && rec.channel) {
    const p0 = params.currentPriceCents ?? rec.baseline?.priceCents ?? null;
    const p = (await currentPrices(tx, companyId, [rec.designId]))
      .get(rec.designId)
      ?.get(rec.channel);
    return p0 !== null && p !== undefined && p >= p0 * (1 + F.priceMovePct / 100);
  }
  if (rec.rule === "R1" && rec.designId) {
    const want = new Set(params.channels ?? []);
    const listed = await activeListings(tx, companyId, [rec.designId]);
    return listed.some((l) => want.has(l.channel) && l.createdAt > rec.createdAt);
  }
  if (rec.rule === "R4" && rec.niche) {
    const rows = await tx
      .select({ id: designs.id })
      .from(designs)
      .innerJoin(
        marketDesignNiches,
        and(
          eq(marketDesignNiches.designId, designs.id),
          eq(marketDesignNiches.companyId, designs.companyId),
        ),
      )
      .where(
        and(
          eq(designs.companyId, companyId),
          gte(designs.createdAt, rec.createdAt),
          sql`${rec.niche} = any(${marketDesignNiches.niches})`,
        ),
      )
      .limit(1);
    return rows.length > 0;
  }
  return false;
}

/**
 * Difference-in-differences over 28 days after adoption against the baseline stored at creation:
 * Δ = (design net/day after − before) − (controls' net/day after − before). `improved` needs ≥ 10
 * units after; too few units or no design (R4) is `inconclusive`.
 */
export function outcomeLabel(input: {
  unitsAfter: number;
  netPerDayAfter: number;
  netPerDayBefore: number;
  controlNetPerDayAfter: number | null;
  controlNetPerDayBefore: number | null;
}): { outcome: "improved" | "worse" | "inconclusive"; did: number } {
  const dt = input.netPerDayAfter - input.netPerDayBefore;
  const dc =
    input.controlNetPerDayAfter !== null && input.controlNetPerDayBefore !== null
      ? input.controlNetPerDayAfter - input.controlNetPerDayBefore
      : 0;
  const did = Math.round(dt - dc);
  if (input.unitsAfter < F.outcomeMinUnits || did === 0) return { outcome: "inconclusive", did };
  return { outcome: did > 0 ? "improved" : "worse", did };
}

async function outcome(tx: Tx, companyId: string, rec: Rec) {
  const base = rec.baseline;
  if (!rec.adoptedAt || !rec.designId || !base)
    return { outcome: "inconclusive" as const, detail: {} };
  const from = rec.adoptedAt;
  const to = new Date(from.getTime() + F.outcomeAfterDays * DAY_MS);
  const p = await getProfit(
    tx,
    { companyId },
    {
      dimension: "design",
      period: { from: from.toISOString(), to: to.toISOString() },
      limit: 100_000,
    },
  );
  const by = new Map(p.rows.map((r) => [r.key, r]));
  const d = by.get(rec.designId);
  const controls = base.controlDesignIds.filter((id) => id !== rec.designId);
  const cNet = controls.reduce((a, id) => a + (by.get(id)?.net ?? 0), 0);
  const days = F.outcomeAfterDays;
  const res = outcomeLabel({
    unitsAfter: d?.units ?? 0,
    netPerDayAfter: (d?.net ?? 0) / days,
    netPerDayBefore: base.netPerDayCents,
    controlNetPerDayAfter: controls.length ? cNet / days : null,
    controlNetPerDayBefore: base.controlNetPerDayCents,
  });
  return {
    outcome: res.outcome,
    detail: {
      unitsAfter: d?.units ?? 0,
      netAfterCents: d?.net ?? 0,
      didCentsPerDay: res.did,
      controls: controls.length,
    },
  };
}

/** One shop's daily pass over its open recommendations. Returns the number of rows changed. */
export async function trackRecommendations(tx: Tx, companyId: string, now: Date) {
  const horizon = new Date(
    now.getTime() - (F.nicheDesignWindowDays + F.outcomeAfterDays + 30) * DAY_MS,
  );
  const open = await tx
    .select()
    .from(marketRecommendations)
    .where(
      and(
        eq(marketRecommendations.companyId, companyId),
        isNull(marketRecommendations.outcome),
        gte(marketRecommendations.createdAt, horizon),
      ),
    );
  let adoptedN = 0;
  let labelled = 0;
  for (const rec of open) {
    if (rec.adoptedAt) {
      if (now.getTime() - rec.adoptedAt.getTime() < F.outcomeAfterDays * DAY_MS) continue;
      const o = await outcome(tx, companyId, rec);
      await tx
        .update(marketRecommendations)
        .set({ outcome: o.outcome, outcomeAt: now, outcomeDetail: o.detail, updatedAt: now })
        .where(and(eq(marketRecommendations.id, rec.id), isNull(marketRecommendations.outcome)));
      labelled++;
      continue;
    }
    const expired = now.getTime() > rec.createdAt.getTime() + windowDays(rec.rule) * DAY_MS;
    // The shop's vote wins: a voted recommendation is never auto-adopted.
    if (!rec.vote && (await adopted(tx, companyId, rec, now))) {
      await tx
        .update(marketRecommendations)
        .set({ adoptedAt: now, updatedAt: now })
        .where(and(eq(marketRecommendations.id, rec.id), isNull(marketRecommendations.adoptedAt)));
      adoptedN++;
    } else if (expired && rec.vote !== "done") {
      await tx
        .update(marketRecommendations)
        .set({ outcome: "not_adopted", outcomeAt: now, updatedAt: now })
        .where(and(eq(marketRecommendations.id, rec.id), isNull(marketRecommendations.outcome)));
      labelled++;
    }
  }
  // Retention: recommendations are kept 400 days.
  const cutoff = new Date(now.getTime() - MARKET_CONFIG.retention.recommendationsDays * DAY_MS);
  await tx
    .delete(marketRecommendations)
    .where(
      and(
        eq(marketRecommendations.companyId, companyId),
        sql`${marketRecommendations.createdAt} < ${cutoff}`,
      ),
    );
  return { open: open.length, adopted: adoptedN, labelled };
}
