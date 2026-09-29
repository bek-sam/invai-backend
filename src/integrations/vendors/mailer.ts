import nodemailer from "nodemailer";
import { env } from "../../env";
import { sha256Hex } from "../../lib/crypto";
import { logger } from "../../lib/log";
import { type CompanyScope, isSampleWorkspace } from "../../modules/tenancy/demo-flag";

const log = logger("mailer");

/*
 * Outgoing mail for vendor delivery and invites. SMTP_URL and MAIL_FROM come from env; outside
 * production they default to Mailpit (docker compose, UI on http://localhost:8025) so every mail
 * is visible locally. Production boots without them only with ALLOW_MOCKS=true: mail is then
 * logged, not sent.
 */
export const MAIL_FROM = env.MAIL_FROM ?? "InvAI <no-reply@invai.invalid>";

const transport = env.SMTP_URL
  ? nodemailer.createTransport(env.SMTP_URL)
  : nodemailer.createTransport({ jsonTransport: true });

export type Mail = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  /** A deterministic RFC 5322 `<local@domain>` id (person-facing mail, T-19-4); random when unset. */
  messageId?: string;
  /** Extra headers, e.g. RFC 8058 `List-Unsubscribe` / `List-Unsubscribe-Post` (T-19-4). */
  headers?: Record<string, string>;
  /**
   * Stable name of the mail's template for logs (`"vendor.sheet"`, `"digest.weekly"`). Subjects
   * can carry a shop name or weekly profit, so the log gets this key and a hash, never the text.
   */
  template?: string;
};

/**
 * What the log may say about a subject (B-139): the template key when the caller gives one, and
 * a short hash so repeated sends of the same subject can still be matched in a support ticket.
 */
export function subjectLogFields(mail: Pick<Mail, "subject" | "template">) {
  return {
    template: mail.template ?? null,
    subjectHash: sha256Hex(mail.subject).slice(0, 16),
  };
}

/** `sendMail` answers these `messageId`s instead of sending; `mailSkipReason` reads them back. */
export const MAIL_SKIPPED = {
  sample_workspace: "skipped:sample-workspace",
  pin_only: "skipped:pin-only",
} as const;
export type MailSkipReason = keyof typeof MAIL_SKIPPED;

export function mailSkipReason(result: { messageId: string }): MailSkipReason | null {
  for (const [reason, id] of Object.entries(MAIL_SKIPPED))
    if (result.messageId === id) return reason as MailSkipReason;
  return null;
}

/**
 * PIN-only floor staff get a synthetic `pin+<uuid>@floor.invai.internal` email because Better
 * Auth's `users.email` is NOT NULL UNIQUE. It is not a mailbox: `sendMail` never sends there.
 */
export const PIN_ONLY_EMAIL_DOMAIN = "floor.invai.internal";

export function isPlaceholderEmail(address: string) {
  return address.trim().toLowerCase().endsWith(`@${PIN_ONLY_EMAIL_DOMAIN}`);
}

/**
 * Who a mail is sent for. Company mail (invites, vendor sheets) names the company, and a sample
 * workspace (tenancy.demo) never sends any: its sample people and vendors are not real inboxes.
 * `"account"` is a person's own account mail (verify email, password reset, security notices
 * from Better Auth): it is about the user, not any company, so it is always sent. A user in a
 * sample workspace always also has a real company (tenancy.demo refuses to start without one).
 */
export type MailSender = CompanyScope | "account";

export async function sendMail(mail: Mail, sender: MailSender): Promise<{ messageId: string }> {
  if (sender !== "account" && (await isSampleWorkspace(sender.companyId))) {
    log.info("mail skipped: sample workspace", subjectLogFields(mail));
    return { messageId: MAIL_SKIPPED.sample_workspace };
  }
  if (isPlaceholderEmail(mail.to)) {
    log.info("mail skipped: PIN-only placeholder address", subjectLogFields(mail));
    return { messageId: MAIL_SKIPPED.pin_only };
  }
  const { template: _template, ...message } = mail;
  const info = await transport.sendMail({ from: MAIL_FROM, ...message });
  if (!env.SMTP_URL) {
    log.warn("mail NOT sent: SMTP_URL is not set (ALLOW_MOCKS)", subjectLogFields(mail));
    return { messageId: info.messageId };
  }
  // S-36: never log the address itself. `toHash` still lets a support ticket be correlated to a
  // send without writing anyone's real email into the application log.
  log.info("mail sent", {
    companyId: sender === "account" ? undefined : sender.companyId,
    toHash: sha256Hex(mail.to.trim().toLowerCase()).slice(0, 16),
    ...subjectLogFields(mail),
    messageId: info.messageId,
  });
  return { messageId: info.messageId };
}

export function escapeHtml(s: string) {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}
