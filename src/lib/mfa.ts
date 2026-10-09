import { and, eq, isNull, ne } from "drizzle-orm";
import { db } from "../db/client";
import { type CompanyType, companies, members, type Role, users } from "../db/schema";
import { env } from "../env";
import { logger } from "./log";

/*
 * Required two-step sign-in (T-28-2, B-188, ADR 0025, Amazon DPP: MFA for accounts that can reach
 * buyer data). One rule everywhere:
 *
 * - Required = the user holds an active `owner` or `admin` membership in any org that is not a
 *   sample workspace (`companies.demo`). Vendor orgs only carry the `vendor` role, so vendors are
 *   never required. It is per user, not per active org, so `me.switchOrg` can't dodge it.
 * - Deadline = `users.mfa_grace_starts_at` + MFA_GRACE_DAYS. The start is restarted (now()) when
 *   a user who was not required becomes required (`restartGraceIfNewlyRequired`): role change,
 *   reactivation, invitation accepted, creating a real org. At most once per user (S-58):
 *   `users.mfa_required_since` is set the first time the user is seen required (that restart, or
 *   a demotion/deactivation of an already-required user) and never cleared; while it is set, no
 *   restart happens, so demote/re-promote can't keep the deadline in the future.
 * - Enforcement: `guard` in src/api/orpc.ts answers MFA_REQUIRED (403, data.deadline) for user
 *   sessions past the deadline without two-step sign-in, except MFA_EXEMPT_PROCEDURES. Better
 *   Auth routes, floor and station sessions, webhooks, SSE /events and /l links are outside it.
 * - src/auth.ts refuses /two-factor/disable while the user is required.
 */

const log = logger("auth.mfa");

export const MFA_REQUIRED_ROLES: readonly Role[] = ["owner", "admin"];

/** What a past-deadline user can still call: enough to load the app shell and switch orgs. */
export const MFA_EXEMPT_PROCEDURES: ReadonlySet<string> = new Set(["me.get", "me.switchOrg"]);

export type MfaMembership = { type: CompanyType; role: Role; demo: boolean };
export type MfaState = { required: boolean; enabled: boolean; deadline: Date | null };

export function isMfaRequired(memberships: readonly MfaMembership[]): boolean {
  return memberships.some(
    (m) => m.type !== "vendor" && !m.demo && MFA_REQUIRED_ROLES.includes(m.role),
  );
}

export function mfaState(
  input: {
    memberships: readonly MfaMembership[];
    twoFactorEnabled: boolean;
    graceStartsAt: Date;
  },
  graceDays = env.MFA_GRACE_DAYS,
): MfaState {
  const required = isMfaRequired(input.memberships);
  return {
    required,
    enabled: input.twoFactorEnabled,
    deadline: required
      ? new Date(input.graceStartsAt.getTime() + graceDays * 24 * 60 * 60 * 1000)
      : null,
  };
}

/** True when the state must refuse the call: required, not enabled, deadline passed. */
export function mfaBlocks(state: MfaState | undefined, now = new Date()): boolean {
  return !!state?.required && !state.enabled && state.deadline !== null && now >= state.deadline;
}

/** Active memberships with the sample flag (`excludeOrgId`: as if that membership didn't exist). */
async function activeMemberships(userId: string, excludeOrgId?: string) {
  return db
    .select({ type: companies.type, role: members.role, demo: companies.demo })
    .from(members)
    .innerJoin(companies, eq(companies.id, members.organizationId))
    .where(
      and(
        eq(members.userId, userId),
        eq(members.status, "active"),
        excludeOrgId ? ne(members.organizationId, excludeOrgId) : undefined,
      ),
    );
}

/** Is the user required right now (optionally ignoring one org, for "before joining it")? */
export async function isUserMfaRequired(
  userId: string,
  opts: { excludeOrgId?: string } = {},
): Promise<boolean> {
  return isMfaRequired(await activeMemberships(userId, opts.excludeOrgId));
}

/** The user's full state from the database (Better Auth hooks, which have no oRPC context). */
export async function loadMfaState(userId: string): Promise<MfaState | null> {
  const [user] = await db
    .select({ enabled: users.twoFactorEnabled, graceStartsAt: users.mfaGraceStartsAt })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) return null;
  return mfaState({
    memberships: await activeMemberships(userId),
    twoFactorEnabled: user.enabled,
    graceStartsAt: user.graceStartsAt,
  });
}

/**
 * Call after a change that can make a user required, with `wasRequired` read before it. A user
 * who just became required gets a fresh grace period, so a long-time office user promoted to
 * admin is not blocked on the spot. Already-required users keep their deadline.
 */
export async function restartGraceIfNewlyRequired(
  userId: string,
  wasRequired: boolean,
): Promise<boolean> {
  const firstTime = and(eq(users.id, userId), isNull(users.mfaRequiredSince));
  if (wasRequired) {
    // Seen required (before a demotion or deactivation, say): any later promotion keeps the
    // deadline this user already has.
    await db.update(users).set({ mfaRequiredSince: new Date() }).where(firstTime);
    return false;
  }
  if (!(await isUserMfaRequired(userId))) return false;
  const now = new Date();
  const [row] = await db
    .update(users)
    .set({ mfaGraceStartsAt: now, mfaRequiredSince: now })
    .where(firstTime)
    .returning({ id: users.id });
  if (!row) return false;
  log.info("two-step grace started", { userId });
  return true;
}
