import { and, eq } from "drizzle-orm";
import { type Tx, withTenant } from "../db/client";
import {
  emailSends,
  emailSuppressions,
  members,
  NOTIFICATION_KINDS,
  type NotificationKind,
  type NotificationPreferenceSource,
  notificationPreferences,
  users,
} from "../db/schema";
import { env } from "../env";
import {
  escapeHtml,
  isPlaceholderEmail,
  MAIL_FROM,
  sendMail,
} from "../integrations/vendors/mailer";
import { conflict, forbidden } from "./errors";
import { signLink } from "./links";
import { errorData, logger } from "./log";

const log = logger("notify");

/*
 * Person-facing email (wave 19, T-19-4, ADR 0016). Feature modules (the digest, T-19-3) call
 * `sendUserEmail` and never the mailer directly, so every such mail gets the same gates:
 *
 *   kill switch -> durable dedupe row -> active member -> real (not PIN-only) address ->
 *   verified -> not suppressed -> not a sample workspace -> opted in -> send -> mark sent
 *
 * Every skip is answered, never thrown, with one reason from `SKIP_REASONS`, so the caller can
 * record it on its own delivery row. Send idempotency lives here and only here: one `email_sends`
 * row per `(company, dedupe_key)`, claimed in a short transaction before the transport call and
 * settled in another after it. The transport call itself runs outside any transaction.
 *
 * Every function opens its own `withTenant`; the `*Tx` variants take a tenant transaction for
 * callers that already have one (the `me.notifications` router).
 */

/** What a mail is: the preference it needs is `preferenceKindFor(kind)`. */
export const EMAIL_KINDS = ["digest", "digest_preview"] as const;
export type EmailKind = (typeof EMAIL_KINDS)[number];

/** A preview goes to the owner who asked for it now: it bypasses the opt-in, nothing else. */
export function preferenceKindFor(kind: EmailKind): NotificationKind {
  return kind === "digest_preview" ? "digest" : kind;
}

export const SKIP_REASONS = [
  "disabled",
  "duplicate",
  "not_member",
  "placeholder",
  "unverified",
  "suppressed",
  "sample_workspace",
  "opted_out",
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

export type SendUserEmailInput = {
  companyId: string;
  userId: string;
  kind: EmailKind;
  /** Stable business key, e.g. `digest:${digestId}:${userId}`; a repeat sends nothing. */
  dedupeKey: string;
  /** Deterministic `<local@domain>` (`buildMessageId`); the same key always gets the same id. */
  messageId: string;
  subject: string;
  text: string;
  html: string;
  /** Adds the RFC 8058 one-click headers bound to this person and preference kind. */
  unsubscribe: boolean;
};

export type SendUserEmailResult =
  | { status: "sent"; messageId: string }
  | { status: "skipped"; reason: SkipReason };

/** A `pending` row older than this belongs to a crashed attempt and may be taken over. */
const PENDING_STALE_MS = 10 * 60_000;
const UNDO_WINDOW_MS = 24 * 3_600_000;

/* --------------------------------- preferences --------------------------------- */

export type EmailPreference = {
  kind: NotificationKind;
  on: boolean;
  /** Null while never set (default off). */
  source: NotificationPreferenceSource | null;
  updatedAt: string | null;
};

const defaultPreference = (kind: NotificationKind): EmailPreference => ({
  kind,
  on: false,
  source: null,
  updatedAt: null,
});

function toPreference(row: typeof notificationPreferences.$inferSelect): EmailPreference {
  return {
    kind: row.kind,
    on: row.on,
    source: row.source,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** One entry per `NOTIFICATION_KINDS` value, in that order, whether or not it was ever set. */
export async function listEmailPreferencesTx(
  tx: Tx,
  companyId: string,
  userId: string,
): Promise<EmailPreference[]> {
  const rows = await tx
    .select()
    .from(notificationPreferences)
    .where(
      and(
        eq(notificationPreferences.companyId, companyId),
        eq(notificationPreferences.userId, userId),
      ),
    );
  const byKind = new Map(rows.map((r) => [r.kind, toPreference(r)]));
  return NOTIFICATION_KINDS.map((kind) => byKind.get(kind) ?? defaultPreference(kind));
}

export async function getEmailPreferenceTx(
  tx: Tx,
  companyId: string,
  userId: string,
  kind: NotificationKind,
): Promise<EmailPreference> {
  const [row] = await tx
    .select()
    .from(notificationPreferences)
    .where(
      and(
        eq(notificationPreferences.companyId, companyId),
        eq(notificationPreferences.userId, userId),
        eq(notificationPreferences.kind, kind),
      ),
    )
    .limit(1);
  return row ? toPreference(row) : defaultPreference(kind);
}

export function getEmailPreference(
  companyId: string,
  userId: string,
  kind: NotificationKind,
): Promise<EmailPreference> {
  return withTenant(companyId, (tx) => getEmailPreferenceTx(tx, companyId, userId, kind));
}

/**
 * Upsert one preference. Only the person turns a kind on (`source: settings`, from
 * `me.notifications.set` or an Undo); an admin or an unsubscribe link can only turn it off
 * (ADR 0016 §4). The wrong combination is refused, never silently downgraded.
 */
export async function setEmailPreferenceTx(
  tx: Tx,
  companyId: string,
  userId: string,
  kind: NotificationKind,
  input: { on: boolean; source: NotificationPreferenceSource },
): Promise<EmailPreference> {
  if (!NOTIFICATION_KINDS.includes(kind)) throw conflict(`Unknown notification kind ${kind}`);
  if (input.on && input.source !== "settings")
    throw forbidden("none", "Only the person can turn their own email on");
  const [row] = await tx
    .insert(notificationPreferences)
    .values({ companyId, userId, kind, on: input.on, source: input.source })
    .onConflictDoUpdate({
      target: [
        notificationPreferences.companyId,
        notificationPreferences.userId,
        notificationPreferences.kind,
      ],
      set: { on: input.on, source: input.source, updatedAt: new Date() },
    })
    .returning();
  if (!row) throw new Error("preference upsert returned nothing");
  return toPreference(row);
}

export function setEmailPreference(
  companyId: string,
  userId: string,
  kind: NotificationKind,
  input: { on: boolean; source: NotificationPreferenceSource },
): Promise<EmailPreference> {
  return withTenant(companyId, (tx) => setEmailPreferenceTx(tx, companyId, userId, kind, input));
}

/**
 * Undo a one-click unsubscribe (ADR 0016 §3): allowed only while the preference is off, was
 * turned off by an unsubscribe link, and that happened less than 24 h ago. The person's choice,
 * so the restored row says `source: settings`.
 */
export async function undoUnsubscribe(
  companyId: string,
  userId: string,
  kind: NotificationKind,
  now: Date = new Date(),
): Promise<"restored" | "expired" | "not_unsubscribed"> {
  return withTenant(companyId, async (tx) => {
    const current = await getEmailPreferenceTx(tx, companyId, userId, kind);
    if (current.on || current.source !== "unsubscribe_link" || !current.updatedAt)
      return "not_unsubscribed";
    if (now.getTime() - new Date(current.updatedAt).getTime() > UNDO_WINDOW_MS) return "expired";
    await setEmailPreferenceTx(tx, companyId, userId, kind, { on: true, source: "settings" });
    return "restored";
  });
}

/* --------------------------------- suppression --------------------------------- */

export async function isSuppressedTx(tx: Tx, companyId: string, userId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: emailSuppressions.id })
    .from(emailSuppressions)
    .where(and(eq(emailSuppressions.companyId, companyId), eq(emailSuppressions.userId, userId)))
    .limit(1);
  return !!row;
}

/** Bounce, complaint or an operator's decision: no more email of any kind to this person here. */
export function suppressEmail(
  companyId: string,
  userId: string,
  input: { reason: "bounce" | "complaint" | "manual"; detail?: string },
): Promise<void> {
  return withTenant(companyId, async (tx) => {
    await tx
      .insert(emailSuppressions)
      .values({ companyId, userId, reason: input.reason, detail: input.detail ?? null })
      .onConflictDoNothing();
  });
}

/* --------------------------------- mail helpers --------------------------------- */

/** The address part of MAIL_FROM (`Name <addr@domain>` or a bare address). */
export function mailFromAddress(): string {
  const m = MAIL_FROM.match(/<([^>]+)>/);
  return (m?.[1] ?? MAIL_FROM).trim();
}

/** The domain Message-IDs are minted under: MAIL_FROM's domain. */
export function mailDomain(): string {
  const addr = mailFromAddress();
  const at = addr.lastIndexOf("@");
  return at > 0 ? addr.slice(at + 1) : "invai.invalid";
}

/** `<digest.<digestId>.<userId>@<domain>>` from its local part; deterministic per send. */
export function buildMessageId(localPart: string): string {
  if (!/^[A-Za-z0-9._+-]{1,200}$/.test(localPart))
    throw new Error("buildMessageId: local part must be [A-Za-z0-9._+-]{1,200}");
  return `<${localPart}@${mailDomain()}>`;
}

/** The postal address every person-facing footer must show (placeholder until OI-12). */
export function postalAddress(): string {
  return env.MAIL_POSTAL_ADDRESS;
}

/** The one-click link for this person and preference kind (same token as the header, same day). */
export function unsubscribeLink(companyId: string, userId: string, kind: NotificationKind): string {
  return signLink({ kind: "unsubscribe", companyId, userId, ref: kind });
}

/**
 * RFC 8058 one-click headers: an https link a mail client POSTs to, plus a mailto fallback
 * (RFC 2369) to the sending address, and the `One-Click` marker.
 */
export function unsubscribeHeaders(
  companyId: string,
  userId: string,
  kind: NotificationKind,
): Record<string, string> {
  const url = unsubscribeLink(companyId, userId, kind);
  const mailto = `mailto:${mailFromAddress()}?subject=${encodeURIComponent(`unsubscribe ${kind}`)}`;
  return {
    "List-Unsubscribe": `<${url}>, <${mailto}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

export type FooterLang = "en" | "es";

/**
 * The footer every person-facing email ends with (spec `footer.*` copy): why you got this, the
 * one-click unsubscribe, where to manage it, and the postal address. `text` and `html` variants.
 */
export function emailFooter(input: {
  lang: FooterLang;
  shopName: string;
  unsubscribeUrl: string;
  settingsUrl?: string;
}): { text: string; html: string } {
  const es = input.lang === "es";
  const why = es
    ? `Recibes esto porque activaste el resumen semanal de ${input.shopName}.`
    : `You get this because you turned on the weekly review for ${input.shopName}.`;
  const unsub = es ? "Cancelar suscripción con un clic" : "Unsubscribe with one click";
  const manage = es ? "Administra en Configuración" : "Manage in Settings";
  const settingsUrl = input.settingsUrl ?? `${env.WEB_ORIGIN}/settings/notifications`;
  const address = postalAddress();
  const text = [
    "--",
    why,
    `${unsub}: ${input.unsubscribeUrl}`,
    `${manage}: ${settingsUrl}`,
    address,
  ].join("\n");
  const html = `<hr style="border:0;border-top:1px solid #ddd;margin:24px 0">
<p style="color:#666;font-size:12px">${escapeHtml(why)}<br>
<a href="${escapeHtml(input.unsubscribeUrl)}">${escapeHtml(unsub)}</a> &middot; <a href="${escapeHtml(settingsUrl)}">${escapeHtml(manage)}</a><br>
${escapeHtml(address)}</p>`;
  return { text, html };
}

/* --------------------------------- send --------------------------------- */

type Claim =
  | { kind: "claimed"; id: string }
  | { kind: "duplicate" }
  | { kind: "skip"; reason: SkipReason };

/**
 * Claim the dedupe row and run every eligibility check in one short tenant transaction. A skip
 * is written on the row (so the same key stays answered `duplicate` afterwards) and returned.
 */
async function claimAndCheck(input: SendUserEmailInput, now: Date): Promise<Claim> {
  return withTenant(input.companyId, async (tx) => {
    const inserted = await tx
      .insert(emailSends)
      .values({
        companyId: input.companyId,
        userId: input.userId,
        kind: input.kind,
        dedupeKey: input.dedupeKey,
        messageId: input.messageId,
        status: "pending",
      })
      .onConflictDoNothing({ target: [emailSends.companyId, emailSends.dedupeKey] })
      .returning({ id: emailSends.id });
    let rowId = inserted[0]?.id;
    if (!rowId) {
      const [existing] = await tx
        .select()
        .from(emailSends)
        .where(
          and(eq(emailSends.companyId, input.companyId), eq(emailSends.dedupeKey, input.dedupeKey)),
        )
        .for("update")
        .limit(1);
      if (!existing) return { kind: "duplicate" };
      const stale = now.getTime() - existing.updatedAt.getTime() > PENDING_STALE_MS;
      const retryable = existing.status === "failed" || (existing.status === "pending" && stale);
      if (!retryable) return { kind: "duplicate" };
      await tx
        .update(emailSends)
        .set({ status: "pending", reason: null, messageId: input.messageId, updatedAt: now })
        .where(eq(emailSends.id, existing.id));
      rowId = existing.id;
    }

    const skip = async (reason: SkipReason): Promise<Claim> => {
      await tx
        .update(emailSends)
        .set({ status: "skipped", reason, updatedAt: now })
        .where(eq(emailSends.id, rowId));
      return { kind: "skip", reason };
    };

    const [row] = await tx
      .select({
        email: users.email,
        emailVerified: users.emailVerified,
        pinOnly: users.pinOnly,
        memberStatus: members.status,
      })
      .from(members)
      .innerJoin(users, eq(users.id, members.userId))
      .where(and(eq(members.organizationId, input.companyId), eq(members.userId, input.userId)))
      .limit(1);
    if (row?.memberStatus !== "active") return skip("not_member");
    if (row.pinOnly || isPlaceholderEmail(row.email)) return skip("placeholder");
    if (!row.emailVerified) return skip("unverified");
    if (await isSuppressedTx(tx, input.companyId, input.userId)) return skip("suppressed");
    if (input.kind !== "digest_preview") {
      const pref = await getEmailPreferenceTx(
        tx,
        input.companyId,
        input.userId,
        preferenceKindFor(input.kind),
      );
      if (!pref.on) return skip("opted_out");
    }
    return { kind: "claimed", id: rowId };
  });
}

async function settle(
  input: SendUserEmailInput,
  rowId: string,
  outcome: { status: "sent" } | { status: "skipped" | "failed"; reason: string },
) {
  await withTenant(input.companyId, (tx) =>
    tx
      .update(emailSends)
      .set(
        outcome.status === "sent"
          ? { status: "sent", reason: null, sentAt: new Date(), updatedAt: new Date() }
          : { status: outcome.status, reason: outcome.reason.slice(0, 500), updatedAt: new Date() },
      )
      .where(eq(emailSends.id, rowId)),
  );
}

/**
 * Send one person-facing email through the mailer, or answer why not. Never throws for a
 * business reason; a transport error marks the row `failed` and is rethrown so the caller's job
 * retries (the retry takes the row over).
 */
export async function sendUserEmail(input: SendUserEmailInput): Promise<SendUserEmailResult> {
  if (!env.DIGEST_EMAIL_ENABLED) return { status: "skipped", reason: "disabled" };
  if (!input.dedupeKey || input.dedupeKey.length > 200) throw new Error("dedupeKey is required");
  if (!/^<[^\s<>@]+@[^\s<>@]+>$/.test(input.messageId))
    throw new Error("messageId must look like <local@domain>");
  if (!EMAIL_KINDS.includes(input.kind)) throw new Error(`unknown email kind ${input.kind}`);

  const now = new Date();
  const claim = await claimAndCheck(input, now);
  if (claim.kind === "duplicate") return { status: "skipped", reason: "duplicate" };
  if (claim.kind === "skip") return { status: "skipped", reason: claim.reason };

  const ctx = { companyId: input.companyId, userId: input.userId, kind: input.kind };
  // The recipient address is read again here, outside the transaction, from the row we just
  // checked: it is the shop member's own address (never a buyer's) and is not logged.
  const to = await withTenant(input.companyId, async (tx) => {
    const [u] = await tx
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, input.userId))
      .limit(1);
    return u?.email ?? null;
  });
  if (!to) {
    await settle(input, claim.id, { status: "skipped", reason: "not_member" });
    return { status: "skipped", reason: "not_member" };
  }

  const prefKind = preferenceKindFor(input.kind);
  const headers = input.unsubscribe
    ? unsubscribeHeaders(input.companyId, input.userId, prefKind)
    : undefined;

  try {
    const sent = await sendMail(
      {
        to,
        subject: input.subject,
        text: input.text,
        html: input.html,
        messageId: input.messageId,
        headers,
      },
      { companyId: input.companyId },
    );
    if (sent.skipped) {
      const reason: SkipReason = sent.skipped === "pin_only" ? "placeholder" : "sample_workspace";
      await settle(input, claim.id, { status: "skipped", reason });
      log.info("user email skipped", { ...ctx, reason });
      return { status: "skipped", reason };
    }
    await settle(input, claim.id, { status: "sent" });
    log.info("user email sent", { ...ctx, messageId: input.messageId });
    return { status: "sent", messageId: input.messageId };
  } catch (err) {
    await settle(input, claim.id, { status: "failed", reason: String(errorData(err).error) });
    log.error("user email failed", { ...ctx, ...errorData(err) });
    throw err;
  }
}

/** Tests and operators: the durable send row for a key, or null. */
export function getEmailSend(companyId: string, dedupeKey: string) {
  return withTenant(companyId, async (tx) => {
    const [row] = await tx
      .select()
      .from(emailSends)
      .where(and(eq(emailSends.companyId, companyId), eq(emailSends.dedupeKey, dedupeKey)))
      .limit(1);
    return row ?? null;
  });
}
