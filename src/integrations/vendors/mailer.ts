import nodemailer from "nodemailer";
import { env } from "../../env";
import { logger } from "../../lib/log";

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

export type Mail = { to: string; subject: string; text: string; html?: string; replyTo?: string };

export async function sendMail(mail: Mail): Promise<{ messageId: string }> {
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
