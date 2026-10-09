import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db/client";
import { accounts, passwordHistory } from "../db/schema";
import { logger } from "./log";

/*
 * Password history (T-28-2, B-186, ADR 0025, Amazon DPP "password history retention for the last
 * ten passwords"). A new password may not equal the current one or any of the previous 9.
 *
 * - Recording: `recordCurrentPassword(userId)` copies the credential account's current hash into
 *   `password_history` (Better Auth's own scrypt format; never the password) and keeps the newest
 *   PASSWORD_HISTORY_SIZE. src/auth.ts calls it from `databaseHooks.account.create/update.after`
 *   (sign-up, invite sign-up, the seed, change password) and `onPasswordReset` (Better Auth
 *   updates the reset password with an updateMany, whose after-hook gets no row).
 * - Checking: `isReusedPassword` verifies the candidate against the current hash plus the stored
 *   ones with Better Auth's `ctx.context.password.verify`, so users from before this table existed
 *   are still checked against their current password. Called from the before-hooks of
 *   /change-password and /reset-password, so a refusal changes nothing.
 */

const log = logger("auth.password-history");

/** The current password plus the previous 9. */
export const PASSWORD_HISTORY_SIZE = 10;

export type VerifyPassword = (input: { hash: string; password: string }) => Promise<boolean>;

/** The credential account's current hash (null: no password, e.g. PIN-only staff). */
export async function currentPasswordHash(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ password: accounts.password })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.providerId, "credential")))
    .limit(1);
  return row?.password ?? null;
}

/** The hashes a new password must not match, newest first (current one included). */
export async function blockedHashes(userId: string): Promise<string[]> {
  const current = await currentPasswordHash(userId);
  const rows = await db
    .select({ hash: passwordHistory.hash })
    .from(passwordHistory)
    .where(eq(passwordHistory.userId, userId))
    .orderBy(desc(passwordHistory.createdAt))
    .limit(PASSWORD_HISTORY_SIZE);
  const hashes = rows.map((r) => r.hash);
  if (current && !hashes.includes(current)) hashes.unshift(current);
  return hashes.slice(0, PASSWORD_HISTORY_SIZE);
}

/** True when `password` matches the current or one of the previous 9 passwords. */
export async function isReusedPassword(
  userId: string,
  password: string,
  verify: VerifyPassword,
): Promise<boolean> {
  for (const hash of await blockedHashes(userId)) {
    if (await verify({ hash, password })) return true;
  }
  return false;
}

/**
 * Append the user's current hash (once: each hash carries its own salt, so an equal string is the
 * same password set) and drop all but the newest PASSWORD_HISTORY_SIZE. Never throws: a missed
 * history row must not fail a sign-up or a password change; it is logged instead.
 */
export async function recordCurrentPassword(userId: string): Promise<void> {
  try {
    await db.execute(sql`
      insert into password_history (user_id, hash)
      select a.user_id, a.password from accounts a
      where a.user_id = ${userId} and a.provider_id = 'credential' and a.password is not null
        and not exists (
          select 1 from password_history h where h.user_id = a.user_id and h.hash = a.password)`);
    await db.execute(sql`
      delete from password_history
      where user_id = ${userId} and id not in (
        select id from password_history where user_id = ${userId}
        order by created_at desc, id desc limit ${PASSWORD_HISTORY_SIZE})`);
  } catch (err) {
    log.error("password history not recorded", { userId, error: String(err) });
  }
}
