import type { AuthErrorCode } from "@invai/contracts";
import { type BetterAuthOptions, type BetterAuthPlugin, betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import {
  APIError,
  createAuthEndpoint,
  createAuthMiddleware,
  getSessionFromCtx,
  isAPIError,
} from "better-auth/api";
import { organization, twoFactor } from "better-auth/plugins";
import { createAccessControl } from "better-auth/plugins/access";
import { adminAc, defaultStatements, ownerAc } from "better-auth/plugins/organization/access";
import { and, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "./db/client";
import {
  accounts,
  companies,
  invitations,
  members,
  sessions,
  twoFactors,
  users,
  verifications,
} from "./db/schema";
import { env } from "./env";
import {
  clearAfterSuccess,
  clearLock,
  lockedFor,
  notifyLocked,
  recordFailure,
} from "./lib/account-lockout";
import {
  localeOf,
  resetPasswordEmail,
  resetPasswordLink,
  type SecurityNotice,
  securityNoticeEmail,
  sendAuthMail,
  verificationEmail,
  verifyEmailLink,
} from "./lib/auth-mail";
import { logger } from "./lib/log";
import { isUserMfaRequired, loadMfaState, restartGraceIfNewlyRequired } from "./lib/mfa";
import { isReusedPassword, recordCurrentPassword } from "./lib/password-history";
import { betterAuthConsume } from "./lib/ratelimit";
import { invitePreview } from "./modules/tenancy/invites";
import { onOrganizationCreated } from "./modules/today/org-hooks";

/*
 * Better Auth: email + password, companies are organizations (`companies` table with a `type`
 * column: shop | vendor), members carry the InvAI role. Better Auth's own access control only
 * governs its organization endpoints (invite, remove member...); procedure permissions come from
 * contracts ROLE_PERMISSIONS and are checked in src/api/orpc.ts.
 */

const ac = createAccessControl(defaultStatements);
const staff = ac.newRole({ organization: [], member: [], invitation: [], team: [] });

export const authRoles = {
  owner: ac.newRole(ownerAc.statements),
  admin: ac.newRole(adminAc.statements),
  office: staff,
  designer: staff,
  presser: staff,
  packer: staff,
  receiver: staff,
  vendor: ac.newRole(adminAc.statements),
};

/**
 * Better Auth organization endpoints the apps never call. Team, role and org changes go through
 * the InvAI procedures (team.*, me.updateOrg), which enforce owner rules and write audit rows;
 * leaving these open would let an admin promote or remove owners, or edit `plan`, around them.
 * The web app only uses organization/create, list and set-active, plus accept-invitation for the
 * invitations team.invite and vendors.invite create (src/modules/tenancy/invites.ts).
 */
export const DISABLED_AUTH_PATHS = [
  "/organization/update",
  "/organization/delete",
  "/organization/invite-member",
  "/organization/cancel-invitation",
  "/organization/update-member-role",
  "/organization/remove-member",
  "/organization/leave",
  "/organization/create-role",
  "/organization/update-role",
  "/organization/delete-role",
  "/organization/create-team",
  "/organization/update-team",
  "/organization/remove-team",
  "/organization/add-team-member",
  "/organization/remove-team-member",
  "/organization/set-active-team",
  // Member and invitation listings (emails) belong behind team.read.
  "/organization/list-members",
  "/organization/get-full-organization",
  "/organization/list-invitations",
];

/**
 * GET /api/auth/invite-preview?id=<invitationId>: what the accept-invite page shows before anyone
 * signs in (company, role, the invited email, whether that email already has an account). The id
 * is only in the invite email; anything but a pending invitation returns just its status.
 */
const invitePreviewPlugin = {
  id: "invai-invite-preview",
  endpoints: {
    invitePreview: createAuthEndpoint(
      "/invite-preview",
      { method: "GET", query: z.object({ id: z.string().max(64) }) },
      async (ctx) => ctx.json(await invitePreview(ctx.query.id)),
    ),
  },
} satisfies BetterAuthPlugin;

const log = logger("auth");

/*
 * Account security (T-2-3):
 * - Email verification: sign-up sends a link to WEB_ORIGIN/verify-email?token=. Unverified users
 *   can sign in; the procedures that move money refuse them with EMAIL_NOT_VERIFIED
 *   (EMAIL_VERIFIED_PROCEDURES in src/api/orpc.ts). Accepting an invite marks the email verified.
 * - Password reset: the link goes to WEB_ORIGIN/reset-password?token=, works once, for 1 hour,
 *   and signs every session out. The request answers the same way for unknown emails.
 * - Two-step sign-in (twoFactor plugin): optional TOTP plus backup codes, issuer "InvAI". Turning
 *   it on needs a verified email. Sign-in answers { twoFactorRedirect: true } while the second
 *   step is pending. A completed reset also verifies the email (the link reached the inbox).
 * - Changing the password needs the current one and always signs the other sessions out.
 * Floor PIN sessions (fs1. tokens, modules/tenancy/floor-auth.ts) are separate and untouched.
 *
 * Amazon DPP controls (T-28-2, ADR 0025); the error codes are the contract's AUTH_ERROR_CODES:
 * - Lockout: 10 wrong passwords in a row for one email (known or not) lock its sign-in for 30
 *   minutes: ACCOUNT_LOCKED (423, retryAfterSec), checked before the endpoint so no session is
 *   made. One email per lock; a password reset unlocks (src/lib/account-lockout.ts).
 * - Password history: a new password equal to the current one or any of the previous 9 gets
 *   PASSWORD_REUSED (400) on change and reset (src/lib/password-history.ts).
 * - Required two-step sign-in for owners/admins: enforced in the oRPC guard (src/lib/mfa.ts);
 *   here, a required user can't turn it off (MFA_DISABLE_NOT_ALLOWED, 403).
 */

/** A Better Auth error with one of the contract's auth codes (the web maps them by code). */
function authError(
  status: "LOCKED" | "BAD_REQUEST" | "FORBIDDEN",
  code: AuthErrorCode,
  message: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) {
  return new APIError(status, { code, message, ...extra }, headers);
}

const passwordReused = () =>
  authError("BAD_REQUEST", "PASSWORD_REUSED", "Choose a password you haven't used before");

/** Verification links work for 24 hours: a slow or spam-filtered email must not strand a new shop. */
export const EMAIL_VERIFICATION_TTL_SEC = 24 * 60 * 60;
/** Reset links work once, for 1 hour. */
export const RESET_PASSWORD_TTL_SEC = 60 * 60;

type MailUser = { id: string; email: string; locale?: unknown };

function notify(user: MailUser, kind: SecurityNotice) {
  void sendAuthMail(user.email, kind, securityNoticeEmail(localeOf(user.locale), kind));
}

/** An unexpired pending invitation for this email: accepting it will verify the email. */
async function hasPendingInvite(email: string) {
  const [row] = await db
    .select({ id: invitations.id })
    .from(invitations)
    .where(
      and(
        sql`lower(${invitations.email}) = ${email.toLowerCase()}`,
        eq(invitations.status, "pending"),
        gt(invitations.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return !!row;
}

export const authOptions = {
  appName: "InvAI",
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      users,
      sessions,
      accounts,
      verifications,
      twoFactors,
      companies,
      members,
      invitations,
    },
  }),
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  trustedOrigins: [env.WEB_ORIGIN, env.FLOOR_ORIGIN],
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    maxPasswordLength: 128,
    // Unverified users can sign in; only paid actions need a verified email.
    requireEmailVerification: false,
    resetPasswordTokenExpiresIn: RESET_PASSWORD_TTL_SEC,
    revokeSessionsOnPasswordReset: true,
    // Not awaited: an unknown email returns at once, so a known one must not wait on SMTP either.
    sendResetPassword: async ({ user, token }) => {
      void sendAuthMail(
        user.email,
        "reset_password",
        resetPasswordEmail(localeOf((user as MailUser).locale), resetPasswordLink(token)),
      );
    },
    onPasswordReset: async ({ user }) => {
      log.info("password reset", { userId: user.id });
      // Better Auth updates the password with an updateMany, whose hook gets no row.
      await recordCurrentPassword(user.id);
      await clearLock(user.email);
      // The reset link reached this inbox, so the email is proven.
      if (!user.emailVerified) {
        await db.update(users).set({ emailVerified: true }).where(eq(users.id, user.id));
      }
      notify(user as MailUser, "password_changed");
    },
  },
  emailVerification: {
    sendOnSignUp: true,
    sendOnSignIn: false,
    autoSignInAfterVerification: false,
    expiresIn: EMAIL_VERIFICATION_TTL_SEC,
    sendVerificationEmail: async ({ user, token }, request) => {
      // Server-side sign-ups (the seed) have no request and mark their users verified themselves.
      if (!request) return;
      // An invitee signing up on the accept-invite page is verified when they accept.
      if (new URL(request.url).pathname.endsWith("/sign-up/email")) {
        if (await hasPendingInvite(user.email)) return;
      }
      void sendAuthMail(
        user.email,
        "verify_email",
        verificationEmail(localeOf((user as MailUser).locale), verifyEmailLink(token)),
      );
    },
  },
  disabledPaths: DISABLED_AUTH_PATHS,
  // Per-IP limits on the auth endpoints (Better Auth only enables them in production by default).
  // Better Auth's own rules also apply: /two-factor/* 3 per 10 s, plus a per-challenge limit of 5
  // codes and a 15-minute account lock after 10 wrong codes.
  //
  // `customStorage` (T-2-3 follow-up, T-12-3 item 2): Better Auth's default `storage: "memory"`
  // is a plain in-process Map, so two API processes each allow the full quota -- the count never
  // leaves whichever process handled the request. `betterAuthConsume` (lib/ratelimit.ts) runs the
  // same fixed-window check Better Auth's own storages use, but as one Redis EVAL shared by every
  // process against the same Valkey. This only moves the rate limiter; sessions/verification stay
  // on the Postgres adapter (no `secondaryStorage` set here).
  rateLimit: {
    enabled: !env.isTest,
    window: 60,
    max: 100,
    customStorage: { consume: betterAuthConsume },
    customRules: {
      "/sign-in/email": { window: 60, max: 20 }, // per IP; a shop office shares one IP
      "/sign-up/email": { window: 60, max: 5 },
      "/organization/create": { window: 60, max: 5 },
      "/invite-preview": { window: 60, max: 30 },
      "/organization/accept-invitation": { window: 60, max: 10 },
      "/request-password-reset": { window: 15 * 60, max: 5 },
      "/reset-password": { window: 15 * 60, max: 10 },
      "/send-verification-email": { window: 15 * 60, max: 5 },
      "/change-password": { window: 15 * 60, max: 10 },
    },
  },
  user: {
    modelName: "users",
    additionalFields: {
      // The language of account and invite emails; the web account page saves it with updateUser.
      locale: {
        type: "string",
        required: false,
        defaultValue: "en",
        input: true,
        validator: { input: z.enum(["en", "es"]) },
      },
    },
  },
  session: {
    modelName: "sessions",
    expiresIn: 60 * 60 * 24 * 14,
    updateAge: 60 * 60 * 24,
  },
  account: { modelName: "accounts" },
  verification: { modelName: "verifications" },
  advanced: {
    database: { generateId: "uuid" },
    useSecureCookies: env.isProd,
    defaultCookieAttributes: { httpOnly: true, sameSite: "lax", secure: env.isProd },
  },
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      // A locked email answers 423 before the endpoint runs: no password check, no session.
      if (ctx.path === "/sign-in/email" && typeof ctx.body?.email === "string") {
        const retryAfterSec = await lockedFor(ctx.body.email);
        if (retryAfterSec !== null) {
          throw authError(
            "LOCKED",
            "ACCOUNT_LOCKED",
            "Too many wrong passwords. Try again later, or reset your password.",
            { retryAfterSec },
            { "Retry-After": String(retryAfterSec) },
          );
        }
      }
      if (ctx.path === "/change-password") {
        // Only with the right current password: otherwise a stolen session could test guesses
        // against the old passwords. A wrong one falls through to the endpoint's INVALID_PASSWORD.
        const session = await getSessionFromCtx(ctx);
        const { currentPassword, newPassword } = (ctx.body ?? {}) as Record<string, unknown>;
        if (session && typeof currentPassword === "string" && typeof newPassword === "string") {
          const verify = ctx.context.password.verify;
          const current = await ctx.context.internalAdapter.findCredentialAccount(session.user.id);
          if (
            current?.password &&
            (await verify({ hash: current.password, password: currentPassword })) &&
            (await isReusedPassword(session.user.id, newPassword, verify))
          ) {
            throw passwordReused();
          }
        }
        // Changing the password always signs the other sessions out, whatever the client sends.
        return { context: { body: { ...(ctx.body ?? {}), revokeOtherSessions: true } } };
      }
      if (ctx.path === "/reset-password") {
        // Find the user from the reset token without consuming it; a bad or expired token falls
        // through to the endpoint's INVALID_TOKEN.
        const token = ctx.body?.token ?? ctx.query?.token;
        const newPassword = ctx.body?.newPassword;
        if (typeof token === "string" && typeof newPassword === "string") {
          const verification = await ctx.context.internalAdapter.findVerificationValue(
            `reset-password:${token}`,
          );
          if (
            verification &&
            verification.expiresAt > new Date() &&
            (await isReusedPassword(verification.value, newPassword, ctx.context.password.verify))
          ) {
            throw passwordReused();
          }
        }
      }
      // Owners and admins of a real shop must keep two-step sign-in on (ADR 0025).
      if (ctx.path === "/two-factor/disable") {
        const session = await getSessionFromCtx(ctx);
        if (session && (await loadMfaState(session.user.id))?.required) {
          throw authError(
            "FORBIDDEN",
            "MFA_DISABLE_NOT_ALLOWED",
            "Owners and admins must keep two-step sign-in on",
          );
        }
      }
      // Two-step sign-in needs a verified email first. Otherwise someone who signed up with a
      // stranger's address could turn it on and lock the real owner out even after a reset.
      if (ctx.path === "/two-factor/enable") {
        const session = await getSessionFromCtx(ctx);
        if (session && !session.user.emailVerified) {
          throw APIError.from("FORBIDDEN", {
            code: "EMAIL_NOT_VERIFIED",
            message: "Verify your email first",
          });
        }
      }
    }),
    after: createAuthMiddleware(async (ctx) => {
      if (ctx.path === "/sign-in/email" && typeof ctx.body?.email === "string") {
        const email: string = ctx.body.email;
        const returned = ctx.context.returned;
        if (isAPIError(returned)) {
          if (
            (returned.body as { code?: string } | undefined)?.code !== "INVALID_EMAIL_OR_PASSWORD"
          )
            return;
          const { crossed } = await recordFailure(email);
          // Not awaited: the locking attempt answers like any wrong password, without SMTP.
          if (crossed) void notifyLocked(email);
        } else if (returned) {
          // The password was right (a pending second step included): the streak ends.
          await clearAfterSuccess(email);
        }
        return;
      }
      if (ctx.path !== "/change-password") return;
      const returned = ctx.context.returned as { user?: MailUser } | undefined;
      if (!returned || isAPIError(returned) || !returned.user) return;
      log.info("password changed", { userId: returned.user.id });
      notify(returned.user, "password_changed");
    }),
  },
  databaseHooks: {
    // Password history: every password set (sign-up, invite, seed, change; reset is in
    // onPasswordReset) enters it.
    account: {
      create: {
        after: async (account) => {
          if (account.providerId === "credential") await recordCurrentPassword(account.userId);
        },
      },
      update: {
        after: async (account) => {
          if (account?.providerId === "credential" && account.userId) {
            await recordCurrentPassword(account.userId);
          }
        },
      },
    },
    user: {
      update: {
        // Two-step sign-in flips on in /two-factor/verify-totp (first code) and off in /disable.
        after: async (user, ctx) => {
          if (ctx?.path === "/two-factor/verify-totp" && user.twoFactorEnabled === true) {
            log.info("two-factor on", { userId: user.id });
            notify(user as MailUser, "two_factor_on");
          } else if (ctx?.path === "/two-factor/disable" && user.twoFactorEnabled === false) {
            log.info("two-factor off", { userId: user.id });
            notify(user as MailUser, "two_factor_off");
          }
        },
      },
    },
    session: {
      create: {
        // A fresh session starts in the user's first company so `me.get` works right away.
        before: async (session) => {
          const [membership] = await db
            .select({ organizationId: members.organizationId })
            .from(members)
            .where(eq(members.userId, session.userId))
            .orderBy(members.createdAt)
            .limit(1);
          return {
            data: { ...session, activeOrganizationId: membership?.organizationId ?? null },
          };
        },
      },
    },
  },
  plugins: [
    organization({
      ac,
      roles: authRoles,
      creatorRole: "owner",
      allowUserToCreateOrganization: true,
      // The invitation id (a random UUID) only travels in the invite email, so opening that link
      // is the proof; accept still requires the invited email, and then marks it verified.
      requireEmailVerificationOnInvitation: false,
      organizationHooks: {
        afterAcceptInvitation: async ({ invitation, user }) => {
          // Joining as owner/admin starts a fresh two-step grace period (ADR 0025).
          await restartGraceIfNewlyRequired(
            user.id,
            await isUserMfaRequired(user.id, { excludeOrgId: invitation.organizationId }),
          );
          if (user.emailVerified) return;
          await db
            .update(users)
            .set({ emailVerified: true })
            .where(
              and(
                eq(users.id, user.id),
                sql`lower(${users.email}) = ${invitation.email.toLowerCase()}`,
              ),
            );
        },
        // Default "Main" location, trial subscription, company.created (src/modules/today).
        afterCreateOrganization: async ({ organization: org, user }) => {
          await onOrganizationCreated({ id: org.id, type: org.type as string | undefined });
          // The creator is its owner: a fresh two-step grace period if that's new (ADR 0025).
          await restartGraceIfNewlyRequired(
            user.id,
            await isUserMfaRequired(user.id, { excludeOrgId: org.id }),
          );
        },
      },
      schema: {
        organization: {
          modelName: "companies",
          additionalFields: {
            // Never client input: vendor orgs are created by vendors.invite, plans by billing.
            type: { type: "string", required: false, defaultValue: "shop", input: false },
            plan: { type: "string", required: false, defaultValue: "trial", input: false },
            timezone: {
              type: "string",
              required: false,
              defaultValue: "America/Phoenix",
              input: true,
            },
            demo: { type: "boolean", required: false, defaultValue: false, input: false },
          },
        },
        member: {
          modelName: "members",
          additionalFields: {
            status: { type: "string", required: false, defaultValue: "active", input: false },
          },
        },
        invitation: { modelName: "invitations" },
      },
    }),
    invitePreviewPlugin,
    twoFactor({
      issuer: "InvAI",
      schema: { twoFactor: { modelName: "twoFactors" } },
    }),
  ],
} satisfies BetterAuthOptions;

export const auth = betterAuth(authOptions);

export type Auth = typeof auth;
