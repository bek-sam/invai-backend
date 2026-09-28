import type { DigestPreviewResult, EmailSkipReason } from "@invai/contracts";
import { and, desc, eq, inArray } from "drizzle-orm";
import { withTenant } from "../../db/client";
import { digestDeliveries, digestInsights, digests } from "../../db/schema";
import { env } from "../../env";
import { rateLimited } from "../../lib/errors";
import { signLink } from "../../lib/links";
import { errorData, logger } from "../../lib/log";
import {
  buildMessageId,
  emailFooter,
  getEmailPreferenceTx,
  type SkipReason,
  sendUserEmail,
  unsubscribeLink,
} from "../../lib/notify";
import { redis } from "../../lib/queues";
import { listRecommendations } from "../market/service";
import { emailWindow } from "./build";
import { DIGEST_CONFIG as C } from "./config";
import type { Lang } from "./facts";
import { type RenderInsight, type RenderModel, renderEmail } from "./render";
import { contentOf, recipients, shopInfo } from "./service";

/*
 * Digest email (spec step 12, AC23, AC26, A7, A8). One delivery row per (digest, person, email),
 * recorded `pending` before the send and settled after; the send itself is idempotent in
 * T-19-4's `email_sends` (dedupe key `digest:${digestId}:${userId}`), so a crash between the
 * send and the settle can't send twice. Only members with `finance.read` are considered; each
 * one who gets nothing has a `skipped` row with the reason. No mail between 20:00 and 07:00 shop
 * time: a digest built after the window is in-app only (`quiet_hours`).
 */

const log = logger("digest.deliver");

type DigestRow = typeof digests.$inferSelect;

async function renderModel(companyId: string, row: DigestRow, userId: string, links: boolean) {
  return withTenant(companyId, async (tx) => {
    const shop = await shopInfo(tx, { companyId });
    const insights = await tx
      .select()
      .from(digestInsights)
      .where(and(eq(digestInsights.companyId, companyId), eq(digestInsights.digestId, row.id)))
      .orderBy(digestInsights.rank);
    const c = contentOf(row);
    const asRender = (i: (typeof insights)[number]): RenderInsight => ({
      id: i.id,
      detector: i.detector,
      action: i.action as RenderInsight["action"],
      facts: i.facts as RenderInsight["facts"],
    });
    const model: RenderModel = {
      shopName: shop.name,
      weekStart: row.weekStart,
      weekEnd: row.weekEnd,
      glance: c.glance,
      net: c.net,
      netChange: c.netChange,
      steady: c.steady,
      incompleteOrders: c.incompleteOrders,
      partialChannels: c.partialChannels,
      actions: insights.filter((i) => i.section === "action").map(asRender),
      win: insights.filter((i) => i.section === "win").map(asRender)[0] ?? null,
      marketWatch: [],
      linkFor: links
        ? (insightId) =>
            signLink({ kind: "click", companyId, userId, ref: `${row.id}:${insightId}` })
        : undefined,
      unsubscribeUrl: unsubscribeLink(companyId, userId, "digest"),
      manageUrl: `${env.WEB_ORIGIN}/settings/notifications`,
    };
    // Market items keep their recommendation text (and `rec.sample` when mock) in the email too.
    const market = insights.filter((i) => i.section === "market");
    if (market.length) {
      const ids = market.flatMap((m) => (m.recommendationId ? [m.recommendationId] : []));
      const recs = await listRecommendations(tx, { companyId }, { ids, limit: ids.length }).catch(
        () => [],
      );
      model.marketWatch = market
        .map((m) => ({
          ...asRender(m),
          recommendation: recs.find((r) => r.id === m.recommendationId) ?? null,
        }))
        .filter((m) => m.recommendation);
    }
    return { model, shop };
  });
}

/** Renders the email with T-19-4's shared footer (why, one-click unsubscribe, settings, address). */
export async function composeEmail(companyId: string, row: DigestRow, userId: string, lang: Lang) {
  const { model, shop } = await renderModel(companyId, row, userId, true);
  const footer = emailFooter({
    lang,
    shopName: shop.name,
    unsubscribeUrl: model.unsubscribeUrl,
    settingsUrl: model.manageUrl,
  });
  const mail = renderEmail(model, lang, footer);
  return { subject: mail.subject, text: mail.text, html: mail.html };
}

const CONTRACT_REASONS: readonly string[] = [
  "not_member",
  "unverified",
  "suppressed",
  "placeholder",
  "sample_workspace",
  "opted_out",
  "duplicate",
  "quiet_hours",
];
const toContractReason = (r: SkipReason | "quiet_hours"): EmailSkipReason | null =>
  CONTRACT_REASONS.includes(r) ? (r as EmailSkipReason) : null;

export type DeliverResult = { sent: number; skipped: number; waiting: boolean };

/** Emails a ready digest to every opted-in `finance.read` member. Idempotent per person. */
export async function deliverDigest(
  companyId: string,
  digestId: string,
  at: Date = new Date(),
): Promise<DeliverResult> {
  const prep = await withTenant(companyId, async (tx) => {
    const [row] = await tx
      .select()
      .from(digests)
      .where(and(eq(digests.companyId, companyId), eq(digests.id, digestId)));
    if (row?.status !== "ready") return null;
    const window = row.inAppOnly ? "closed" : await emailWindow(tx, companyId, row, at);
    const list = await recipients(tx, { companyId });
    const out: { userId: string; lang: Lang; skip: SkipReason | "quiet_hours" | null }[] = [];
    for (const r of list) {
      const pref = await getEmailPreferenceTx(tx, companyId, r.userId, "digest");
      const skip = !pref.on ? "opted_out" : window === "closed" ? "quiet_hours" : null;
      out.push({ userId: r.userId, lang: r.lang, skip });
    }
    // Record intent (or the skip) before any send; a settled row is never touched again.
    const existing = await tx
      .select()
      .from(digestDeliveries)
      .where(
        and(eq(digestDeliveries.companyId, companyId), eq(digestDeliveries.digestId, digestId)),
      );
    const todo: typeof out = [];
    for (const r of out) {
      const prior = existing.find((e) => e.userId === r.userId);
      if (prior && prior.status !== "pending" && prior.status !== "failed") continue;
      if (r.skip === null && window === "wait") continue;
      await tx
        .insert(digestDeliveries)
        .values({
          companyId,
          digestId,
          userId: r.userId,
          channel: "email",
          status: r.skip ? "skipped" : "pending",
          reason: r.skip,
          lang: r.lang,
        })
        .onConflictDoUpdate({
          target: [
            digestDeliveries.companyId,
            digestDeliveries.digestId,
            digestDeliveries.userId,
            digestDeliveries.channel,
          ],
          set: { status: r.skip ? "skipped" : "pending", reason: r.skip, updatedAt: new Date() },
        });
      if (!r.skip) todo.push(r);
    }
    return { row, todo, waiting: window === "wait" };
  });
  if (!prep) return { sent: 0, skipped: 0, waiting: false };

  let sent = 0;
  let skipped = 0;
  for (const r of prep.todo) {
    const mail = await composeEmail(companyId, prep.row, r.userId, r.lang);
    const messageId = buildMessageId(`digest.${digestId}.${r.userId}`);
    let status: "sent" | "skipped" | "failed" = "failed";
    let reason: string | null = null;
    try {
      const res = await sendUserEmail({
        companyId,
        userId: r.userId,
        kind: "digest",
        dedupeKey: `digest:${digestId}:${r.userId}`,
        messageId,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        unsubscribe: true,
      });
      status = res.status;
      reason = res.status === "skipped" ? (res.reason ?? null) : null;
    } catch (err) {
      reason = "send_failed";
      log.warn("digest email failed", { companyId, digestId, userId: r.userId, ...errorData(err) });
    }
    // `duplicate`: an earlier attempt already sent it (the durable send row says so).
    if (status === "skipped" && reason === "duplicate") status = "sent";
    if (status === "sent") sent++;
    else skipped++;
    await withTenant(companyId, (tx) =>
      tx
        .update(digestDeliveries)
        .set({
          status,
          reason: status === "sent" ? null : reason,
          messageId: status === "sent" ? messageId : null,
          sentAt: status === "sent" ? new Date() : null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(digestDeliveries.companyId, companyId),
            eq(digestDeliveries.digestId, digestId),
            eq(digestDeliveries.userId, r.userId),
            eq(digestDeliveries.channel, "email"),
          ),
        ),
    );
    if (status === "failed") throw new Error(`digest email to one recipient failed (${reason})`);
  }
  return { sent, skipped, waiting: prep.waiting };
}

/**
 * "Send me a preview now" (AC30, A8): the latest digest to the caller only, bypassing only the
 * opt-in. One per caller per minute (Redis key, 60 s); a repeat is RATE_LIMITED.
 */
export async function sendPreview(
  companyId: string,
  userId: string,
  at: Date = new Date(),
): Promise<DigestPreviewResult | null> {
  const lang: Lang = await withTenant(companyId, async (tx) => {
    const list = await recipients(tx, { companyId });
    return list.find((r) => r.userId === userId)?.lang ?? "en";
  });
  const row = await withTenant(companyId, async (tx) => {
    const [r] = await tx
      .select()
      .from(digests)
      .where(and(eq(digests.companyId, companyId), inArray(digests.status, ["ready"])))
      .orderBy(desc(digests.weekStart))
      .limit(1);
    return r ?? null;
  });
  if (!row) return null;
  const key = `digest:preview:${companyId}:${userId}`;
  const ok = await redis.set(key, "1", "EX", C.preview.windowSec, "NX");
  if (ok !== "OK") {
    const ttl = await redis.ttl(key);
    throw rateLimited(ttl > 0 ? ttl : C.preview.windowSec);
  }
  const minute = Math.floor(at.getTime() / 60_000);
  const mail = await composeEmail(companyId, row, userId, lang);
  const res = await sendUserEmail({
    companyId,
    userId,
    kind: "digest_preview",
    dedupeKey: `digest-preview:${row.id}:${userId}:${minute}`,
    messageId: buildMessageId(`digest-preview.${row.id}.${userId}.${minute}`),
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
    unsubscribe: true,
  });
  return {
    weekKey: row.weekKey,
    status: res.status,
    reason: res.status === "skipped" && res.reason ? toContractReason(res.reason) : null,
  };
}
