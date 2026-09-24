import nodemailer from "nodemailer";
import { logger } from "../../lib/log";

const log = logger("mailer");

/*
 * Outgoing mail for vendor delivery and invites. SMTP_URL defaults to Mailpit
 * (docker compose, UI on http://localhost:8025) so every mail is visible locally.
 */
const SMTP_URL = process.env.SMTP_URL ?? "smtp://localhost:1025";
export const MAIL_FROM = process.env.MAIL_FROM ?? "InvAI <sheets@invai.local>";

const transport = nodemailer.createTransport(SMTP_URL);

export type Mail = { to: string; subject: string; text: string; html?: string; replyTo?: string };

export async function sendMail(mail: Mail): Promise<{ messageId: string }> {
  const info = await transport.sendMail({ from: MAIL_FROM, ...mail });
  log.info("mail sent", { to: mail.to, subject: mail.subject, messageId: info.messageId });
  return { messageId: info.messageId };
}

export function escapeHtml(s: string) {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}
