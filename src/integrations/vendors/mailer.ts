import nodemailer from "nodemailer";
import { env } from "../../env";
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
};

export type MailSkipReason = "sample_workspace" | "pin_only";

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

export async function sendMail(
  mail: Mail,
  sender: MailSender,
): Promise<{ messageId: string; skipped?: MailSkipReason }> {
  if (sender !== "account" && (await isSampleWorkspace(sender.companyId))) {
    log.info("mail skipped: sample workspace", { subject: mail.subject });
    return { messageId: "skipped:sample-workspace", skipped: "sample_workspace" };
  }
  if (isPlaceholderEmail(mail.to)) {
    log.info("mail skipped: PIN-only placeholder address", { subject: mail.subject });
    return { messageId: "skipped:pin-only", skipped: "pin_only" };
  }
  const info = await transport.sendMail({ from: MAIL_FROM, ...mail });
  if (!env.SMTP_URL) {
    log.warn("mail NOT sent: SMTP_URL is not set (ALLOW_MOCKS)", { subject: mail.subject });
    return { messageId: info.messageId };
  }
  log.info("mail sent", { to: mail.to, subject: mail.subject, messageId: info.messageId });
  return { messageId: info.messageId };
}

export function escapeHtml(s: string) {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}
