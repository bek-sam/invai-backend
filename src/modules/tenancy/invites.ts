import { and, eq, gt, ne } from "drizzle-orm";
import { z } from "zod";
import { db, type Tx, withSystem } from "../../db/client";
import type { Role } from "../../db/schema";
import { accounts, companies, invitations, users, vendorConnections } from "../../db/schema";
import { env } from "../../env";
import { escapeHtml, sendMail } from "../../integrations/vendors/mailer";
import { upstream } from "../../lib/errors";
import { logger } from "../../lib/log";

/*
 * Invitations are Better Auth organization invitations (`invitations` table). InvAI creates the
 * row itself (team.invite, vendors.invite) so it can enforce its own team rules, then emails a
 * link to /accept-invite/<id>. The invitee signs up or signs in there and Better Auth's
 * /organization/accept-invitation turns the invitation into an active member with that role.
 * The invitation id (a random UUID) is the secret in the link.
 */

const log = logger("invites");

export const STAFF_INVITE_DAYS = 7;
export const VENDOR_INVITE_DAYS = 14;

export const inviteExpiry = (days: number) => new Date(Date.now() + days * 86_400_000);

export function inviteLink(invitationId: string) {
  return `${env.WEB_ORIGIN}/accept-invite/${invitationId}`;
}

type Locale = "en" | "es";

const ROLE_NAMES: Record<Locale, Record<Role, string>> = {
  en: {
    owner: "Owner",
    admin: "Admin",
    office: "Office",
    designer: "Designer",
    presser: "Presser",
    packer: "Packer",
    receiver: "Receiver",
    vendor: "Vendor",
  },
  es: {
    owner: "Dueño",
    admin: "Administrador",
    office: "Oficina",
    designer: "Diseñador",
    presser: "Planchador",
    packer: "Empacador",
    receiver: "Recepción",
    vendor: "Proveedor",
  },
};

export type InviteEmailInput = {
  /** Sent from a demo company (sample data): the email is never sent (see sendInviteEmail). */
  demo?: boolean;
  locale: string | null | undefined;
  kind: "staff" | "vendor";
  companyName: string;
  inviterName: string | null;
  role: Role;
  link: string;
  expiresAt: Date;
};

/** The invite email in English or Spanish. Plain text plus a simple HTML version. */
export function inviteEmail(input: InviteEmailInput) {
  const locale: Locale = input.locale === "es" ? "es" : "en";
  const who = input.inviterName?.trim() || input.companyName;
  const role = ROLE_NAMES[locale][input.role];
  const date = new Intl.DateTimeFormat(locale === "es" ? "es-MX" : "en-US", {
    month: "long",
    day: "numeric",
  }).format(input.expiresAt);
  const copy =
    locale === "es"
      ? {
          subject:
            input.kind === "vendor"
              ? `${input.companyName} te invitó a su portal de proveedores en InvAI`
              : `${who} te invitó a ${input.companyName} en InvAI`,
          intro:
            input.kind === "vendor"
              ? `${input.companyName} quiere enviarte sus gang sheets DTF por InvAI.`
              : `${who} te invitó a unirte a ${input.companyName} en InvAI como ${role}.`,
          action:
            input.kind === "vendor"
              ? "Crea tu cuenta gratis de proveedor o entra con la tuya"
              : "Crea tu cuenta o entra con la tuya",
          button: "Aceptar invitación",
          expires: `El enlace vence el ${date}. Usa este mismo correo al registrarte.`,
          ignore: "Si no esperabas este correo, ignóralo.",
        }
      : {
          subject:
            input.kind === "vendor"
              ? `${input.companyName} invited you to their vendor portal on InvAI`
              : `${who} invited you to ${input.companyName} on InvAI`,
          intro:
            input.kind === "vendor"
              ? `${input.companyName} wants to send you their DTF gang sheets through InvAI.`
              : `${who} invited you to join ${input.companyName} on InvAI as ${role}.`,
          action:
            input.kind === "vendor"
              ? "Create your free vendor account or sign in"
              : "Create your account or sign in",
          button: "Accept invitation",
          expires: `The link works until ${date}. Sign up with this same email address.`,
          ignore: "If you weren't expecting this email, you can ignore it.",
        };
  const text = `${copy.intro}\n\n${copy.action}: ${input.link}\n\n${copy.expires}\n\n${copy.ignore}`;
  const html = `<p>${escapeHtml(copy.intro)}</p>
<p>${escapeHtml(copy.action)}:</p>
<p><a href="${escapeHtml(input.link)}" style="display:inline-block;padding:10px 16px;background:#111;color:#fff;border-radius:6px;text-decoration:none">${escapeHtml(copy.button)}</a></p>
<p style="color:#666">${escapeHtml(copy.expires)}<br>${escapeHtml(copy.ignore)}</p>`;
  return { subject: copy.subject, text, html };
}

/** How long an invite waits on the mail server before it is reported as not sent. */
export const INVITE_EMAIL_TIMEOUT_MS = 15_000;

/**
 * Send one invite-related email. Callers commit the invitation first and call this with no
 * transaction open (a slow mail server must never hold a pooled connection or a row lock), then
 * remove the invitation if it throws. Throws UPSTREAM_FAILED on a refusal or after the timeout,
 * so the web never says "sent" for an email that didn't go out.
 */
export async function deliverInviteMail(
  mail: { to: string; subject: string; text: string; html?: string },
  timeoutMs = INVITE_EMAIL_TIMEOUT_MS,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      sendMail(mail),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
  } catch (err) {
    log.warn("invite email failed", { error: String(err) });
    throw upstream("Invite email");
  } finally {
    clearTimeout(timer);
  }
}

/** Send the invite email (English or Spanish). See deliverInviteMail for the rules. */
export async function sendInviteEmail(to: string, input: InviteEmailInput, timeoutMs?: number) {
  // A demo company is sample data: its invites stay in the app and never reach a real inbox.
  if (input.demo) {
    log.info("invite email skipped: demo company", { kind: input.kind });
    return;
  }
  return deliverInviteMail({ to, ...inviteEmail(input) }, timeoutMs);
}

/** Company name plus the inviter's name and language, for the email. */
export async function inviteSenders(companyId: string, inviterId: string | null) {
  const [company] = await db
    .select({ name: companies.name, demo: companies.demo })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  const [inviter] = inviterId
    ? await db
        .select({ name: users.name, locale: users.locale })
        .from(users)
        .where(eq(users.id, inviterId))
        .limit(1)
    : [];
  return {
    demo: company?.demo ?? false,
    companyName: company?.name ?? "InvAI",
    inviterName: inviter?.name ?? null,
    locale: inviter?.locale ?? "en",
  };
}

/** Cancel pending invitations for this email in this company, except `keepId` (a re-invite replaces them). */
export async function cancelPendingInvitations(
  tx: Tx,
  companyId: string,
  email: string,
  keepId?: string,
) {
  await tx
    .update(invitations)
    .set({ status: "canceled" })
    .where(
      and(
        eq(invitations.organizationId, companyId),
        eq(invitations.email, email),
        eq(invitations.status, "pending"),
        keepId ? ne(invitations.id, keepId) : undefined,
      ),
    );
}

export type InvitePreview =
  | {
      status: "pending";
      email: string;
      role: string;
      organizationName: string;
      organizationType: string;
      /** For a vendor invite, the shop that sent it (the new vendor org is named after the vendor). */
      invitedBy: string | null;
      /** The email already has a password account: show "Sign in" first instead of "New account". */
      hasAccount: boolean;
    }
  | { status: "expired" | "used" | "not_found" };

/**
 * What the accept page needs before anyone is signed in. Knowing the id is the proof: it is only
 * in the email. Nothing but the status comes back for an invitation that can't be accepted.
 */
export async function invitePreview(id: string): Promise<InvitePreview> {
  if (!z.uuid().safeParse(id).success) return { status: "not_found" };
  const [row] = await db
    .select({
      email: invitations.email,
      role: invitations.role,
      status: invitations.status,
      expiresAt: invitations.expiresAt,
      organizationId: invitations.organizationId,
      organizationName: companies.name,
      organizationType: companies.type,
    })
    .from(invitations)
    .innerJoin(companies, eq(companies.id, invitations.organizationId))
    .where(eq(invitations.id, id))
    .limit(1);
  if (!row || row.status === "canceled") return { status: "not_found" };
  if (row.status !== "pending") return { status: "used" };
  if (!row.expiresAt || row.expiresAt < new Date()) return { status: "expired" };
  const [account] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .innerJoin(users, eq(users.id, accounts.userId))
    .where(and(eq(users.email, row.email.toLowerCase()), eq(accounts.providerId, "credential")))
    .limit(1);
  // Reads vendor_connections across tenants (withSystem): a new vendor org has no session yet,
  // and only the shop's name comes back.
  const invitedBy =
    row.organizationType === "vendor"
      ? await withSystem(async (stx) => {
          const [shop] = await stx
            .select({ name: companies.name })
            .from(vendorConnections)
            .innerJoin(companies, eq(companies.id, vendorConnections.companyId))
            .where(eq(vendorConnections.vendorCompanyId, row.organizationId))
            .orderBy(vendorConnections.createdAt)
            .limit(1);
          return shop?.name ?? null;
        })
      : null;
  return {
    status: "pending",
    email: row.email,
    role: row.role,
    organizationName: row.organizationName,
    organizationType: row.organizationType,
    invitedBy,
    hasAccount: !!account,
  };
}

/** Pending, unexpired invitations of a company, newest first (the team list shows them). */
export async function pendingInvitations(tx: Tx, companyId: string) {
  return tx
    .select()
    .from(invitations)
    .where(
      and(
        eq(invitations.organizationId, companyId),
        eq(invitations.status, "pending"),
        gt(invitations.expiresAt, new Date()),
      ),
    );
}
