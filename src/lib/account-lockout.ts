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
 *   before: `lockedFor(email)` -> 423 ACCOUNT_LOCKED, so the endpoint (and any session) never runs;
 *   after:  INVALID_EMAIL_OR_PASSWORD -> `recordFailure(email)`; success -> `clearAfterSuccess`.
 * A completed password reset clears the row (`clearLock`).
 *
 * The key is an HMAC of the normalized email, so the table never holds an address, and an email
 * with no account locks exactly like a real one (no account-exists signal). The per-IP limit
 * (decision 0008) is separate and unchanged. Counting is one atomic upsert, so N parallel wrong
 * passwords count N, and exactly one of them sees the count reach the threshold: that one sends
 * the single "account locked" email.
 *
 * A row is stale (the count starts again at 1) once its lock has ended, or when it was not locked
 * and the last failure is older than FAILURE_WINDOW_HOURS. New rows also sweep up to 500 stale
 * ones, so the table holds about a day of failures at most.
 */

const log = logger("auth.lockout");

/** Failures older than this (with no lock) no longer count toward the next lock. */
export const FAILURE_WINDOW_HOURS = 24;

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

/** The table key for an email: HMAC-SHA256 under the auth secret, never the address. */
export const emailKey = (email: string) =>
  hmacHex(env.BETTER_AUTH_SECRET, `sign-in-lock:${normalizeEmail(email)}`);

/** Seconds until the email's lock ends, or null when it isn't locked. */
export async function lockedFor(email: string): Promise<number | null> {
  const res = await db.execute<{ retry: number }>(sql`
    select greatest(1, ceil(extract(epoch from (locked_until - now()))))::int as retry
    from sign_in_failures
    where email_hmac = ${emailKey(email)} and locked_until > now()`);
  return res.rows[0]?.retry ?? null;
}

export type FailureResult = {
  failures: number;
  /** True for exactly one failure per lock: the one that reached the threshold. */
  crossed: boolean;
  retryAfterSec: number | null;
};

/** Count one wrong password for this email; locks it when the count reaches the threshold. */
export async function recordFailure(
  email: string,
  threshold = env.ACCOUNT_LOCK_THRESHOLD,
  minutes = env.ACCOUNT_LOCK_MINUTES,
): Promise<FailureResult> {
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
    failures: row.failures,
    crossed: row.failures === threshold,
    retryAfterSec: row.retry,
  };
}

/** A right password ends the streak. A lock set meanwhile by parallel wrong attempts stays. */
export async function clearAfterSuccess(email: string): Promise<void> {
  await db.execute(sql`
    delete from sign_in_failures
    where email_hmac = ${emailKey(email)} and (locked_until is null or locked_until <= now())`);
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
 * After the failure that locked the email: one email to the account (if one exists), and a warn
 * log with the user id only. `notified_at` is the once-per-lock guard on top of `crossed`.
 * Returns the delivery promise (tests await it); the auth hook doesn't.
 */
export async function notifyLocked(
  email: string,
  minutes = env.ACCOUNT_LOCK_MINUTES,
): Promise<boolean> {
  const [user] = await db
    .select({ id: users.id, email: users.email, locale: users.locale, pinOnly: users.pinOnly })
    .from(users)
    .where(sql`lower(${users.email}) = ${normalizeEmail(email)}`)
    .limit(1);
  if (!user) {
    log.warn("sign-in locked", { userId: null });
    return false;
  }
  log.warn("sign-in locked", { userId: user.id });
  if (user.pinOnly) return false;
  const claimed = await db.execute(sql`
    update sign_in_failures set notified_at = now()
    where email_hmac = ${emailKey(email)} and notified_at is null and locked_until > now()
    returning email_hmac`);
  if (claimed.rows.length === 0) return false;
  return sendAuthMail(
    user.email,
    "account_locked",
    accountLockedEmail(localeOf(user.locale), minutes),
  );
}
