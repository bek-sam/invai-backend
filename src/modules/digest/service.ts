import {
  type Digest,
  type DigestClick,
  type DigestFact,
  type DigestFeedback,
  type DigestFeedbackInput,
  type DigestGlanceItem,
  type DigestInsight,
  type DigestLatest,
  type DigestPlanUsage,
  type DigestRecipient,
  type DigestSettings,
  type DigestSettingsInput,
  type DigestSummary,
  type MarketRecommendation,
  ROLE_PERMISSIONS,
  type Role,
} from "@invai/contracts";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { creditBalance } from "../../ai/credits";
import { digestSummaryMode } from "../../ai/digest-narrative";
import type { TenantContext } from "../../api/context";
import type { Tx } from "../../db/client";
import {
  companies,
  digestClicks,
  digestFeedback,
  digestInsights,
  digestSettings,
  digests,
  digestViews,
  members,
  users,
} from "../../db/schema";
import { isPlaceholderEmail } from "../../integrations/vendors/mailer";
import { notFound, ORPCError } from "../../lib/errors";
import {
  getEmailPreferenceTx,
  isSuppressedTx,
  listEmailPreferencesTx,
  setEmailPreferenceTx,
} from "../../lib/notify";
import { keyset, type PageInput } from "../../lib/pagination";
import { getStatus } from "../billing/service";
import { listRecommendations } from "../market/service";
import { DIGEST_CONFIG as C } from "./config";
import type { Lang } from "./facts";

/*
 * Digest service (T-19-3, `specs/weekly-digest.md`): the request-side reads and writes behind
 * the `digest.*` procedures. Every function runs in the caller's `withTenant` transaction and
 * filters on `ctx.companyId` too. Only `ready` and `skipped_quiet` digests ever leave here
 * (contract `DIGEST_STATUSES`); `building`/`failed` read as NOT_FOUND. The stored AI summary
 * (`digests.narrative`) is never selected by any function in this file (shadow mode, AC18).
 */

type Ctx = Pick<TenantContext, "companyId">;
type UserCtx = { companyId: string; userId: string };

const VISIBLE = ["ready", "skipped_quiet"] as const;
type DigestRow = typeof digests.$inferSelect;
type InsightRow = typeof digestInsights.$inferSelect;

/** Stored page content (written by build.ts). */
export type StoredContent = {
  steady: boolean;
  incompleteOrders: number;
  partialChannels: Digest["partialChannels"];
  glance: DigestGlanceItem[];
  net: DigestFact | null;
  netChange: DigestFact | null;
  actionCount: number;
};

export function contentOf(row: Pick<DigestRow, "content">): StoredContent {
  const c = row.content as Partial<StoredContent>;
  return {
    steady: c.steady ?? true,
    incompleteOrders: c.incompleteOrders ?? 0,
    partialChannels: c.partialChannels ?? [],
    glance: c.glance ?? [],
    net: c.net ?? null,
    netChange: c.netChange ?? null,
    actionCount: c.actionCount ?? 0,
  };
}

function toSummary(row: DigestRow, viewedAt: Date | null): DigestSummary {
  const c = contentOf(row);
  return {
    id: row.id,
    weekKey: row.weekKey,
    weekStart: row.weekStart,
    weekEnd: row.weekEnd,
    status: row.status === "skipped_quiet" ? "skipped_quiet" : "ready",
    narrativeStatus: row.narrativeStatus,
    net: c.net,
    netChange: c.netChange,
    actionCount: c.actionCount,
    viewedAt: viewedAt?.toISOString() ?? null,
    readyAt: row.readyAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toInsight(
  row: InsightRow,
  extra: { myVote: "up" | "down" | null; clicked: boolean; rec: MarketRecommendation | null },
): DigestInsight {
  return {
    id: row.id,
    detector: row.detector,
    rank: row.rank,
    score: row.score,
    confidence: Math.min(1, Math.max(0, row.confidence)),
    impactCents: row.impactCents,
    action: row.action as DigestInsight["action"],
    facts: row.facts as DigestInsight["facts"],
    templateKey: row.templateKey,
    recommendation: row.detector === "market" ? extra.rec : null,
    myVote: extra.myVote,
    clicked: extra.clicked,
  };
}

async function viewedAtFor(tx: Tx, ctx: UserCtx, digestIds: string[]) {
  if (!digestIds.length) return new Map<string, Date>();
  const rows = await tx
    .select({ digestId: digestViews.digestId, viewedAt: digestViews.viewedAt })
    .from(digestViews)
    .where(
      and(
        eq(digestViews.companyId, ctx.companyId),
        eq(digestViews.userId, ctx.userId),
        inArray(digestViews.digestId, digestIds),
      ),
    );
  return new Map(rows.map((r) => [r.digestId, r.viewedAt]));
}

export async function listDigests(tx: Tx, ctx: UserCtx, input: PageInput) {
  const page = keyset(digests.createdAt, digests.id, input);
  const rows = await tx
    .select()
    .from(digests)
    .where(
      and(eq(digests.companyId, ctx.companyId), inArray(digests.status, [...VISIBLE]), page.where),
    )
    .orderBy(...page.orderBy)
    .limit(page.limit + 1);
  const viewed = await viewedAtFor(
    tx,
    ctx,
    rows.map((r) => r.id),
  );
  return page.result(rows, (r) => toSummary(r, viewed.get(r.id) ?? null));
}

async function visibleByWeek(tx: Tx, ctx: Ctx, weekKey: string) {
  const [row] = await tx
    .select()
    .from(digests)
    .where(
      and(
        eq(digests.companyId, ctx.companyId),
        eq(digests.weekKey, weekKey),
        inArray(digests.status, [...VISIBLE]),
      ),
    );
  if (!row) throw notFound("Digest", weekKey);
  return row;
}

async function planUsage(tx: Tx, ctx: Ctx): Promise<DigestPlanUsage> {
  const status = await getStatus(tx, ctx);
  const credits = await creditBalance(tx, ctx.companyId);
  return {
    ordersUsed: status.usage.orders.used,
    ordersLimit: status.usage.orders.limit,
    aiCreditsRemaining: credits.remaining,
  };
}

/** The full digest page. Records the caller's first view. Plan usage only with `billing.read`. */
export async function getDigest(
  tx: Tx,
  ctx: UserCtx & Pick<TenantContext, "permissions">,
  input: { weekKey: string },
): Promise<Digest> {
  const row = await visibleByWeek(tx, ctx, input.weekKey);
  await tx
    .insert(digestViews)
    .values({ companyId: ctx.companyId, digestId: row.id, userId: ctx.userId })
    .onConflictDoNothing();
  const viewed = await viewedAtFor(tx, ctx, [row.id]);
  const insights = await tx
    .select()
    .from(digestInsights)
    .where(and(eq(digestInsights.companyId, ctx.companyId), eq(digestInsights.digestId, row.id)))
    .orderBy(digestInsights.rank);
  const ids = insights.map((i) => i.id);
  const votes = ids.length
    ? await tx
        .select({ insightId: digestFeedback.insightId, vote: digestFeedback.vote })
        .from(digestFeedback)
        .where(
          and(
            eq(digestFeedback.companyId, ctx.companyId),
            eq(digestFeedback.userId, ctx.userId),
            inArray(digestFeedback.insightId, ids),
          ),
        )
    : [];
  const clicks = ids.length
    ? await tx
        .select({ insightId: digestClicks.insightId })
        .from(digestClicks)
        .where(
          and(
            eq(digestClicks.companyId, ctx.companyId),
            eq(digestClicks.userId, ctx.userId),
            inArray(digestClicks.insightId, ids),
          ),
        )
    : [];
  const recIds = insights.flatMap((i) => (i.recommendationId ? [i.recommendationId] : []));
  const recs = recIds.length
    ? await listRecommendations(tx, ctx, { ids: recIds, limit: recIds.length }).catch(() => [])
    : [];
  const map = (i: InsightRow) =>
    toInsight(i, {
      myVote: votes.find((v) => v.insightId === i.id)?.vote ?? null,
      clicked: clicks.some((c) => c.insightId === i.id),
      rec: recs.find((r) => r.id === i.recommendationId) ?? null,
    });
  // A market item whose recommendation is gone (deleted, other shop) is not shown.
  const usable = (i: InsightRow) =>
    i.detector !== "market" || recs.some((r) => r.id === i.recommendationId);
  const c = contentOf(row);
  const out: Digest = {
    ...toSummary(row, viewed.get(row.id) ?? null),
    timezone: row.timezone,
    steady: c.steady,
    incompleteOrders: c.incompleteOrders,
    partialChannels: c.partialChannels,
    glance: c.glance,
    actions: insights
      .filter((i) => i.section === "action" && usable(i))
      .slice(0, 3)
      .map(map),
    win: insights.filter((i) => i.section === "win").map(map)[0] ?? null,
    marketWatch: insights
      .filter((i) => i.section === "market" && usable(i))
      .slice(0, C.ranking.maxMarket)
      .map(map),
  };
  if (ctx.permissions.has("billing.read")) out.planUsage = await planUsage(tx, ctx);
  return out;
}

/** The newest digest, plus `paused` after two quiet weeks in a row. */
export async function latestDigest(tx: Tx, ctx: UserCtx): Promise<DigestLatest> {
  const rows = await tx
    .select()
    .from(digests)
    .where(and(eq(digests.companyId, ctx.companyId), inArray(digests.status, [...VISIBLE])))
    .orderBy(desc(digests.weekStart))
    .limit(C.pausedAfterQuietWeeks);
  const newest = rows[0];
  const paused =
    rows.length >= C.pausedAfterQuietWeeks && rows.every((r) => r.status === "skipped_quiet");
  if (!newest) return { digest: null, paused: false };
  const viewed = await viewedAtFor(tx, ctx, [newest.id]);
  return { digest: toSummary(newest, viewed.get(newest.id) ?? null), paused };
}

async function insightOf(tx: Tx, ctx: Ctx, digestId: string, insightId: string) {
  const [row] = await tx
    .select({ id: digestInsights.id, detector: digestInsights.detector })
    .from(digestInsights)
    .innerJoin(digests, eq(digests.id, digestInsights.digestId))
    .where(
      and(
        eq(digestInsights.companyId, ctx.companyId),
        eq(digestInsights.id, insightId),
        eq(digestInsights.digestId, digestId),
        inArray(digests.status, [...VISIBLE]),
      ),
    );
  if (!row) throw notFound("Digest insight", insightId);
  return row;
}

/** Thumbs: one row per (insight, caller); the latest vote or reason wins; a repeat changes nothing. */
export async function recordFeedback(
  tx: Tx,
  ctx: UserCtx,
  input: DigestFeedbackInput,
): Promise<DigestFeedback> {
  const insight = await insightOf(tx, ctx, input.digestId, input.insightId);
  if (insight.detector === "market")
    throw new ORPCError("MARKET_INSIGHT", {
      status: 409,
      message: "Market watch items are rated with Done or Not useful",
    });
  const reason = input.vote === "down" ? (input.reason ?? null) : null;
  const now = new Date();
  await tx
    .insert(digestFeedback)
    .values({
      companyId: ctx.companyId,
      digestId: input.digestId,
      insightId: input.insightId,
      userId: ctx.userId,
      vote: input.vote,
      reason,
      votedAt: now,
    })
    .onConflictDoUpdate({
      target: [digestFeedback.companyId, digestFeedback.insightId, digestFeedback.userId],
      set: { vote: input.vote, reason, votedAt: now, updatedAt: now },
      setWhere: sql`${digestFeedback.vote} is distinct from ${input.vote} or ${digestFeedback.reason} is distinct from ${reason}`,
    });
  const [row] = await tx
    .select()
    .from(digestFeedback)
    .where(
      and(
        eq(digestFeedback.companyId, ctx.companyId),
        eq(digestFeedback.insightId, input.insightId),
        eq(digestFeedback.userId, ctx.userId),
      ),
    );
  if (!row) throw notFound("Digest feedback", input.insightId);
  return {
    digestId: row.digestId,
    insightId: row.insightId,
    vote: row.vote,
    reason: row.reason,
    votedAt: row.votedAt.toISOString(),
  };
}

/** Records an action click; the first click wins. Also used by the email's signed click link. */
export async function recordClick(
  tx: Tx,
  ctx: UserCtx,
  input: { digestId: string; insightId: string },
): Promise<DigestClick> {
  await insightOf(tx, ctx, input.digestId, input.insightId);
  await tx
    .insert(digestClicks)
    .values({
      companyId: ctx.companyId,
      digestId: input.digestId,
      insightId: input.insightId,
      userId: ctx.userId,
    })
    .onConflictDoNothing();
  const [row] = await tx
    .select()
    .from(digestClicks)
    .where(
      and(
        eq(digestClicks.companyId, ctx.companyId),
        eq(digestClicks.insightId, input.insightId),
        eq(digestClicks.userId, ctx.userId),
      ),
    );
  if (!row) throw notFound("Digest click", input.insightId);
  return {
    digestId: row.digestId,
    insightId: row.insightId,
    clickedAt: row.clickedAt.toISOString(),
  };
}

/** The action path an insight's click link opens (same-origin path from the stored action). */
export async function clickTarget(
  tx: Tx,
  ctx: UserCtx,
  input: { digestId: string; insightId: string },
): Promise<string | null> {
  const [row] = await tx
    .select({ action: digestInsights.action })
    .from(digestInsights)
    .where(
      and(
        eq(digestInsights.companyId, ctx.companyId),
        eq(digestInsights.id, input.insightId),
        eq(digestInsights.digestId, input.digestId),
      ),
    );
  if (!row) return null;
  await recordClick(tx, ctx, input);
  const href = (row.action as { href?: unknown }).href;
  return typeof href === "string" ? href : null;
}

/* ------------------------------------ settings ------------------------------------ */

export type SettingsRow = {
  enabled: boolean;
  day: DigestSettings["day"];
  hour: number;
  aiSummary: boolean;
};

export async function settingsRow(
  tx: Tx,
  ctx: Ctx,
): Promise<SettingsRow & { updatedAt: Date | null }> {
  const [row] = await tx
    .select()
    .from(digestSettings)
    .where(eq(digestSettings.companyId, ctx.companyId));
  return {
    enabled: row?.enabled ?? true,
    day: row?.day ?? C.schedule.defaultDay,
    hour: row?.hour ?? C.schedule.defaultHour,
    aiSummary: row?.aiSummary ?? false,
    updatedAt: row?.updatedAt ?? null,
  };
}

export async function shopInfo(tx: Tx, ctx: Ctx) {
  const [row] = await tx
    .select({ name: companies.name, timezone: companies.timezone })
    .from(companies)
    .where(eq(companies.id, ctx.companyId));
  return { name: row?.name ?? "", timezone: row?.timezone ?? "America/Phoenix" };
}

const FINANCE_ROLES = (Object.keys(ROLE_PERMISSIONS) as Role[]).filter((r) =>
  (ROLE_PERMISSIONS[r] as readonly string[]).includes("finance.read"),
);

export type RecipientRow = DigestRecipient & { lang: Lang; pinOnly: boolean };

/** Active members with `finance.read` (by permission, not role name) and their email state. */
export async function recipients(tx: Tx, ctx: Ctx): Promise<RecipientRow[]> {
  const rows = await tx
    .select({
      userId: users.id,
      name: users.name,
      email: users.email,
      emailVerified: users.emailVerified,
      pinOnly: users.pinOnly,
      locale: users.locale,
    })
    .from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .where(
      and(
        eq(members.organizationId, ctx.companyId),
        eq(members.status, "active"),
        inArray(members.role, FINANCE_ROLES),
      ),
    )
    .orderBy(members.createdAt);
  const out: RecipientRow[] = [];
  for (const r of rows) {
    const pref = await getEmailPreferenceTx(tx, ctx.companyId, r.userId, "digest");
    const placeholder = r.pinOnly || isPlaceholderEmail(r.email);
    const deliverable: DigestRecipient["deliverable"] = placeholder
      ? "placeholder"
      : !r.emailVerified
        ? "unverified"
        : (await isSuppressedTx(tx, ctx.companyId, r.userId))
          ? "suppressed"
          : "ok";
    out.push({
      userId: r.userId,
      name: r.name,
      emailOn: pref.on,
      deliverable,
      lang: r.locale === "es" ? "es" : "en",
      pinOnly: r.pinOnly,
    });
  }
  return out;
}

export async function getSettings(tx: Tx, ctx: Ctx): Promise<DigestSettings> {
  const s = await settingsRow(tx, ctx);
  const shop = await shopInfo(tx, ctx);
  const list = await recipients(tx, ctx);
  return {
    enabled: s.enabled,
    day: s.day,
    hour: s.hour,
    aiSummary: s.aiSummary,
    aiSummaryMode: await digestSummaryMode(),
    timezone: shop.timezone,
    recipients: list.map(({ userId, name, emailOn, deliverable }) => ({
      userId,
      name,
      emailOn,
      deliverable,
    })),
    updatedAt: s.updatedAt?.toISOString() ?? null,
  };
}

export async function setSettings(
  tx: Tx,
  ctx: Ctx,
  input: DigestSettingsInput,
): Promise<DigestSettings> {
  const patch = {
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    ...(input.day !== undefined ? { day: input.day } : {}),
    ...(input.hour !== undefined ? { hour: input.hour } : {}),
    ...(input.aiSummary !== undefined ? { aiSummary: input.aiSummary } : {}),
  };
  await tx
    .insert(digestSettings)
    .values({ companyId: ctx.companyId, ...patch })
    .onConflictDoUpdate({
      target: [digestSettings.companyId],
      set: { ...patch, updatedAt: new Date() },
    });
  return getSettings(tx, ctx);
}

/** An admin turns one recipient's email off (never on). Not an active finance member → NOT_FOUND. */
export async function setRecipientEmail(
  tx: Tx,
  ctx: Ctx,
  input: { userId: string; on: false },
): Promise<DigestSettings> {
  const list = await recipients(tx, ctx);
  if (!list.some((r) => r.userId === input.userId)) throw notFound("Recipient", input.userId);
  const cur = await getEmailPreferenceTx(tx, ctx.companyId, input.userId, "digest");
  if (cur.on)
    await setEmailPreferenceTx(tx, ctx.companyId, input.userId, "digest", {
      on: false,
      source: "admin",
    });
  return getSettings(tx, ctx);
}

/** Whether anyone will read this week's AI summary (spec pipeline 9: skip the model otherwise). */
export async function anyReader(tx: Tx, ctx: Ctx, previousDigestId: string | null) {
  const list = await recipients(tx, ctx);
  for (const r of list) {
    const prefs = await listEmailPreferencesTx(tx, ctx.companyId, r.userId);
    if (prefs.some((p) => p.kind === "digest" && p.on) && r.deliverable === "ok") return true;
  }
  if (!previousDigestId) return false;
  const [v] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(digestViews)
    .where(
      and(eq(digestViews.companyId, ctx.companyId), eq(digestViews.digestId, previousDigestId)),
    );
  return (v?.n ?? 0) > 0;
}
