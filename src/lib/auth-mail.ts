import { env } from "../env";
import { escapeHtml, sendMail } from "../integrations/vendors/mailer";
import { logger } from "./log";

/*
 * Account emails from Better Auth (src/auth.ts): verify your email, reset your password, and
 * security notices (password changed, two-step sign-in on or off). English or Spanish from
 * `users.locale`. Links point at the web app, which calls the Better Auth routes with the token.
 *
 * Delivery never blocks or fails the auth request: a reset request must answer the same way
 * (and in about the same time) whether or not the email exists, so mail goes out in the
 * background and failures are logged, not thrown.
 */

const log = logger("auth-mail");

export type AuthMailLocale = "en" | "es";
export type SecurityNotice = "password_changed" | "two_factor_on" | "two_factor_off";
export type AuthMail = { subject: string; text: string; html: string };

export const localeOf = (locale: unknown): AuthMailLocale => (locale === "es" ? "es" : "en");

/** The link in the verification email: the web page calls `authClient.verifyEmail({ query: { token } })`. */
export const verifyEmailLink = (token: string) =>
  `${env.WEB_ORIGIN}/verify-email?token=${encodeURIComponent(token)}`;

/** The link in the reset email: the web page calls `authClient.resetPassword({ newPassword, token })`. */
export const resetPasswordLink = (token: string) =>
  `${env.WEB_ORIGIN}/reset-password?token=${encodeURIComponent(token)}`;

const button = (href: string, label: string) =>
  `<p><a href="${escapeHtml(href)}" style="display:inline-block;padding:10px 16px;background:#111;color:#fff;border-radius:6px;text-decoration:none">${escapeHtml(label)}</a></p>`;

function linkMail(
  copy: { subject: string; intro: string; button: string; expires: string; ignore: string },
  link: string,
): AuthMail {
  const text = `${copy.intro}\n\n${link}\n\n${copy.expires}\n\n${copy.ignore}`;
  const html = `<p>${escapeHtml(copy.intro)}</p>
${button(link, copy.button)}
<p style="color:#666">${escapeHtml(copy.expires)}<br>${escapeHtml(copy.ignore)}</p>`;
  return { subject: copy.subject, text, html };
}

export function verificationEmail(locale: AuthMailLocale, link: string): AuthMail {
  return linkMail(
    locale === "es"
      ? {
          subject: "Confirma tu correo en InvAI",
          intro: "Confirma tu correo para comprar etiquetas y administrar tu plan en InvAI.",
          button: "Confirmar correo",
          expires: "El enlace vence en 24 horas.",
          ignore: "Si no creaste una cuenta en InvAI, ignora este correo.",
        }
      : {
          subject: "Confirm your email for InvAI",
          intro: "Confirm your email so you can buy labels and manage your plan in InvAI.",
          button: "Confirm email",
          expires: "The link works for 24 hours.",
          ignore: "If you didn't create an InvAI account, you can ignore this email.",
        },
    link,
  );
}

export function resetPasswordEmail(locale: AuthMailLocale, link: string): AuthMail {
  return linkMail(
    locale === "es"
      ? {
          subject: "Cambia tu contraseña de InvAI",
          intro: "Alguien pidió cambiar la contraseña de tu cuenta de InvAI. Elige una nueva aquí:",
          button: "Cambiar contraseña",
          expires:
            "El enlace vence en 1 hora y sirve una sola vez. Al cambiarla, se cierran tus otras sesiones.",
          ignore: "Si no fuiste tú, ignora este correo. Tu contraseña no cambia.",
        }
      : {
          subject: "Reset your InvAI password",
          intro:
            "Someone asked to reset the password for your InvAI account. Choose a new one here:",
          button: "Reset password",
          expires: "The link works once, for 1 hour. Resetting signs you out everywhere else.",
          ignore: "If this wasn't you, ignore this email. Your password stays the same.",
        },
    link,
  );
}

const NOTICES: Record<AuthMailLocale, Record<SecurityNotice, { subject: string; body: string }>> = {
  en: {
    password_changed: {
      subject: "Your InvAI password was changed",
      body: "The password for your InvAI account was just changed, and your other sessions were signed out.",
    },
    two_factor_on: {
      subject: "Two-step sign-in is on for your InvAI account",
      body: "Signing in to InvAI now also asks for a code from your authenticator app. Keep your backup codes somewhere safe.",
    },
    two_factor_off: {
      subject: "Two-step sign-in is off for your InvAI account",
      body: "Signing in to InvAI no longer asks for a code from your authenticator app.",
    },
  },
  es: {
    password_changed: {
      subject: "Se cambió tu contraseña de InvAI",
      body: "Se acaba de cambiar la contraseña de tu cuenta de InvAI y se cerraron tus otras sesiones.",
    },
    two_factor_on: {
      subject: "Activaste el inicio de sesión en dos pasos en InvAI",
      body: "Ahora, al entrar a InvAI también te pedimos un código de tu app de autenticación. Guarda tus códigos de respaldo en un lugar seguro.",
    },
    two_factor_off: {
      subject: "Desactivaste el inicio de sesión en dos pasos en InvAI",
      body: "Al entrar a InvAI ya no te pedimos un código de tu app de autenticación.",
    },
  },
};

const NOT_YOU: Record<AuthMailLocale, string> = {
  en: "If this wasn't you, reset your password right away and contact us.",
  es: "Si no fuiste tú, cambia tu contraseña de inmediato y escríbenos.",
};

export function securityNoticeEmail(locale: AuthMailLocale, kind: SecurityNotice): AuthMail {
  const notice = NOTICES[locale][kind];
  const resetLink = `${env.WEB_ORIGIN}/forgot-password`;
  const text = `${notice.body}\n\n${NOT_YOU[locale]}\n${resetLink}`;
  const html = `<p>${escapeHtml(notice.body)}</p>
<p style="color:#666">${escapeHtml(NOT_YOU[locale])}<br><a href="${escapeHtml(resetLink)}">${escapeHtml(resetLink)}</a></p>`;
  return { subject: notice.subject, text, html };
}

/** How long an account email may wait on the mail server before it is logged as not sent. */
export const AUTH_MAIL_TIMEOUT_MS = 15_000;

/**
 * Send an account email without making the caller wait. Returns the delivery promise (it never
 * rejects) so tests can await it; auth callbacks don't.
 */
export function sendAuthMail(
  to: string,
  kind: "verify_email" | "reset_password" | SecurityNotice,
  mail: AuthMail,
  timeoutMs = AUTH_MAIL_TIMEOUT_MS,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    sendMail({ to, ...mail }),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
    }),
  ])
    .then(() => true)
    .catch((err) => {
      // No address in the log: the kind is enough to find the failure.
      log.warn("account email not sent", { kind, error: String(err) });
      return false;
    })
    .finally(() => clearTimeout(timer));
}
