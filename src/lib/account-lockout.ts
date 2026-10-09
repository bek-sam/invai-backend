import { eq, sql } from "drizzle-orm";
import { db } from "../db/client";
import { signInFailures, users } from "../db/schema";
import { env } from "../env";
import { accountLockedEmail, localeOf, sendAuthMail } from "./auth-mail";
import { hmacHex } from "./crypto";
import { logger } from "./log";

/*
 * Per-email sign-in lockout (T-28-2, B-185, ADR 0025, Amazon DPP "lockout after ten unsuccessful
 * login attempts"). Wired into Better Auth's /sign-in/email hooks in src/auth.ts:
 *   before: `reserveAttempt(email)` counts the attempt BEFORE the password check (S-57). Only
 *           attempts 1..threshold reach the check; the one that reaches the threshold sets the
 *           lock, and every later one answers 423 ACCOUNT_LOCKED without running the endpoint (no
 *           password check, no session). So one parallel burst tests at most `threshold`
 *           passwords.
 *   after:  INVALID_EMAIL_OR_PASSWORD -> `notifyLocked` (one email per lock); a right password ->
 *           `clearAfterSuccess`; any other error -> `giveBack` (no password was tested).
 * A completed password reset clears the row (`clearLock`). If the endpoint dies without an answer
 * (a 500), the attempt stays counted: failing closed.
 *
 * The key is an HMAC of the normalized email under BETTER_AUTH_SECRET, so the table never holds
 * an address, and an email with no account locks exactly like a real one (no account-exists
 * signal). Rotating the secret resets every counter. The per-IP limit (decision 0008) is separate.
 *
 * A row is stale (the count starts again at 1) once its lock has ended, or when it was not locked
 * and the last attempt is older than FAILURE_WINDOW_HOURS. New rows also sweep up to 500 stale
 * ones, so the table holds about a day of attempts at most.
 */

const log = logger("auth.lockout");

/** Attempts older than this (with no lock) no longer count toward the next lock. */
export const FAILURE_WINDOW_HOURS = 24;

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

/** The table key for an email: HMAC-SHA256 under the auth secret, never the address. */
export const emailKey = (email: string) =>
  hmacHex(env.BETTER_AUTH_SECRET, `sign-in-lock:${normalizeEmail(email)}`);

export type Reservation = {
  /** False: the email is locked; answer 423 without checking the password. */
  allowed: boolean;
  /** Attempts counted in this streak, this one included (refused ones count too). */
  failures: number;
  /** True for exactly one attempt per lock: the one that reached the threshold and set it. */
  crossed: boolean;
  retryAfterSec: number | null;
};

/**
 * Count one sign-in attempt for this email before its password is checked. One atomic upsert, so
 * N parallel attempts count N, exactly one of them reaches the threshold (and sets the lock), and
 * the ones past it are refused.
 */
export async function reserveAttempt(
  email: string,
  threshold = env.ACCOUNT_LOCK_THRESHOLD,
  minutes = env.ACCOUNT_LOCK_MINUTES,
): Promise<Reservation> {
  const key = emailKey(email);
  const stale = sql`((f.locked_until is not null and f.locked_until <= now())
    or (f.locked_until is null
      and f.updated_at < now() - make_interval(hours => ${FAILURE_WINDOW_HOURS})))`;
  const lockAt = sql`now() + make_interval(mins => ${minutes})`;
  const res = await db.execute<{ failures: number; retry: number | null; inserted: boolean }>(sql`
    insert into sign_in_failures as f (email_hmac, failures, locked_until, updated_at)
    values (${key}, 1, case when 1 >= ${threshold} then ${lockAt} end, now())
    on conflict (email_hmac) do update set
      failures = case when ${stale} then 1 else f.failures + 1 end,
      locked_until = case
        when ${stale} then case when 1 >= ${threshold} then ${lockAt} end
        when f.locked_until is null and f.failures + 1 >= ${threshold} then ${lockAt}
        else f.locked_until end,
      notified_at = case when ${stale} then null else f.notified_at end,
      updated_at = now()
    returning failures,
      case when locked_until > now()
        then greatest(1, ceil(extract(epoch from (locked_until - now()))))::int end as retry,
      (xmax = 0) as inserted`);
  const row = res.rows[0];
  if (!row) throw new Error("sign_in_failures upsert returned nothing");
  if (row.inserted) await sweepStale();
  return {
    allowed: row.failures <= threshold,
    failures: row.failures,
    crossed: row.failures === threshold,
    retryAfterSec: row.retry,
  };
}

/**
 * The attempt ended without testing a password (bad input, unverified email): uncount it. A lock
 * that only this attempt's count had set is lifted again.
 */
export async function giveBack(
  email: string,
  threshold = env.ACCOUNT_LOCK_THRESHOLD,
): Promise<void> {
  await db.execute(sql`
    update sign_in_failures set
      failures = failures - 1,
      locked_until = case when failures - 1 < ${threshold} then null else locked_until end
    where email_hmac = ${emailKey(email)} and failures > 0`);
}

/**
 * A right password ends the streak, including a lock its own attempt set (wrong 9 times, right
 * the 10th). A lock that already refused attempts (count past the threshold) stays.
 */
export async function clearAfterSuccess(
  email: string,
  threshold = env.ACCOUNT_LOCK_THRESHOLD,
): Promise<void> {
  await db.execute(sql`
    delete from sign_in_failures
    where email_hmac = ${emailKey(email)}
      and (failures <= ${threshold} or locked_until is null or locked_until <= now())`);
}

/** A completed password reset proves the inbox: it ends any lock at once. */
export async function clearLock(email: string): Promise<void> {
  await db.delete(signInFailures).where(eq(signInFailures.emailHmac, emailKey(email)));
}

async function sweepStale() {
  await db.execute(sql`
    delete from sign_in_failures where email_hmac in (
      select email_hmac from sign_in_failures
      where updated_at < now() - make_interval(hours => ${FAILURE_WINDOW_HOURS})
        and (locked_until is null or locked_until <= now())
      limit 500)`);
}

/**
 * After a wrong password: if the email is locked and nobody was told yet, claim `notified_at`
 * (once per lock, whichever failure gets there first), then send one email to the account (if
 * one exists) and a warn log with the user id only. Returns the delivery promise (tests await
 * it); the auth hook doesn't.
 */
export async function notifyLocked(
  email: string,
  minutes = env.ACCOUNT_LOCK_MINUTES,
): Promise<boolean> {
  const claimed = await db.execute(sql`
    update sign_in_failures set notified_at = now()
    where email_hmac = ${emailKey(email)} and notified_at is null and locked_until > now()
    returning email_hmac`);
  if (claimed.rows.length === 0) return false;
  const [user] = await db
    .select({ id: users.id, email: users.email, locale: users.locale, pinOnly: users.pinOnly })
    .from(users)
    .where(sql`lower(${users.email}) = ${normalizeEmail(email)}`)
    .limit(1);
  log.warn("sign-in locked", { userId: user?.id ?? null });
  if (!user || user.pinOnly) return false;
  return sendAuthMail(
    user.email,
    "account_locked",
    accountLockedEmail(localeOf(user.locale), minutes),
  );
}
