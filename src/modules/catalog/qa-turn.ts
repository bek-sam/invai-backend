import { randomUUID } from "node:crypto";
import { DelayedError, type Job } from "bullmq";
import type { ItemFlag } from "../../db/schema";
import { ImagingError } from "../../integrations/imaging/client";
import { logger } from "../../lib/log";
import { redis } from "../../lib/queues";

const log = logger("catalog.qa-turn");

/*
 * One company's turn at imaging's single print-file QA slot (T-43-3, S-76 / B-399).
 *
 * Imaging answers 429 when its one QA slot is busy, so a shop that loops `designs.runQa` kept
 * every other shop's checks waiting. Two per-company limits, both keyed by the company id only:
 *
 *   - a lease: at most one QA turn in flight per company across the API and all workers.
 *     `SET NX PX` with a random token, released by compare-and-delete (a turn that outlived its
 *     TTL never frees the next holder's lease). The TTL covers the longest allowed turn: every
 *     placement (at most `QA_MAX_CALLS`, one per `PLACEMENTS` value) with a clean-alpha and a QA
 *     call, each at the client's 120 s timeout.
 *   - an allowance: a token bucket of `QA_BURST` refilling one per `QA_REFILL_MS`, charged one
 *     token per `/qa/check` call, not per turn (S-79: a 5-placement design holds the slot five
 *     times as long). A turn is admitted while at least one token is left and is charged all its
 *     calls up front; the balance may go negative (a debt of at most `QA_MAX_CALLS - 1`), and the
 *     next turn is refused until the refill has paid it back. So a design is never refused half
 *     way, and a loop on any placement count holds the slot at most 4.3 s per 20 s (wave 42's
 *     worst QA) once the burst is spent, while a person re-running a 1-placement design by hand
 *     (a few clicks, then one every 20 s) is never refused.
 *
 * The allowance is split in two buckets per company, `design` (runQa, the QA job) and `artwork`
 * (item artwork follow-ups, the inline check), each with this burst and refill; the lease is shared.
 * A finished turn does not delete the lease but shortens it to `QA_COOLDOWN_MS` (S-81), so one
 * company's design and artwork bursts can't run back to back; only the token holder may shorten it.
 *
 * Yield to a waiting person (T-46-3, S-81 residual). A turn is up to five calls, so a manual Run
 * QA of another shop used to wait through the whole of it: 29.35 s at 4.3 s a call, 30.04 s at
 * 5 s. Now a manual caller whose call imaging refused (429) is registered in the sorted set
 * `qa:manual-waiting` (member = company id, score = server ms) from its first 429 until that call
 * ends (served, given up or failed), and removed again in `finally`. One use of that set, for
 * OTHER companies only (a shop never waits for itself):
 *   - `yieldToManualCaller`: before placement 2.. a turn that holds its lease waits, polling, while
 *     a foreign caller is registered, at most `yieldMaxMs` per placement (imaging's Retry-After +
 *     1 s) and `yieldTotalMs` per turn. The lease stays held through the wait (one call in flight
 *     per company, the artwork bucket can't take it) and the turn then goes on, so a design is
 *     never refused half way. The wait costs one pooled DB connection: `runQa` and the job hold
 *     their `withTenant` transaction across it (router.ts), like they already do across imaging.
 * Not done, on purpose (S-85): refusing a NEW manual turn while any foreign caller is registered. A few
 * shops looping manual Run QA keep a registration live nearly all the time, so a victim shop was
 * refused at once and never joined the race for the free slot (21-60+ s at 5 s a call). The 6 s
 * cooldown already stops the shop that yielded from starting its next turn ahead of the person it
 * yielded to. Jobs and artwork checks never asked either.
 * Livelock: a caller is registered only inside its own busy call, never while it yields at a
 * placement boundary, so two shops' multi-placement turns can't yield to each other. A registration older
 * than `QA_MANUAL_BUDGET_MS` is pruned (a crashed caller), and the caps bound every wait.
 * Design note: the card suggested `qa:manual:<company>` keys registered when `runQa` starts and a
 * "registration older than the turn" test; that can't help a victim who arrives in the middle of
 * the attacker's turn (the attacker's own registration is older), and key scans cost O(keyspace).
 *
 * Valkey trouble fails open with one warn log, like `lib/fairness.ts`: the fairness guarantee is
 * lost, nobody's QA is. Callers: the router's `runQa`, the QA job, `setItemArtwork` and its
 * follow-up job. Not `runDesignQa` itself: the seed runs it in sequence and stays unthrottled.
 */

export const QA_BURST = 3;
export const QA_REFILL_MS = 20_000;
export const QA_IN_FLIGHT_RETRY_MS = 3_000;
/**
 * After a turn the company keeps its lease this long (S-81): imaging's Retry-After (5 s) + 1 s, so
 * another shop retrying on that hint always finds the slot between two turns of the same company.
 */
export const QA_COOLDOWN_MS = 6_000;
/** `redelayQa` waits at least this long, plus up to the same again as jitter. */
export const QA_REDELAY_FLOOR_MS = 1_000;
/** A person waiting on a manual check gives up after this much busy-waiting in total (A12). */
const QA_MANUAL_BUDGET_MS = 25_000;
/** One yield waits at most imaging's Retry-After (5 s) + 1 s; a turn yields at most twice that in total. */
export const QA_YIELD_MAX_MS = 6_000;
export const QA_YIELD_TOTAL_MS = 12_000;
export const QA_YIELD_POLL_MS = 100;
/**
 * Live timing, equal to the constants above. Only tests call `scaleQaTiming`, to run the same
 * dynamics at a fraction of the wall-clock time. It scales every timer this module owns (refill,
 * in-flight hint, cooldown, the re-delay floor and jitter, the manual busy budget); the caller
 * scales the bounds it asserts by the same factor.
 */
const timing = {
  refillMs: QA_REFILL_MS,
  inFlightRetryMs: QA_IN_FLIGHT_RETRY_MS,
  cooldownMs: QA_COOLDOWN_MS,
  redelayFloorMs: QA_REDELAY_FLOOR_MS,
  yieldMaxMs: QA_YIELD_MAX_MS,
  yieldTotalMs: QA_YIELD_TOTAL_MS,
  yieldPollMs: QA_YIELD_POLL_MS,
};
/** Test-only: the live values, so a test can assert the defaults. */
export const qaTimingNow = () => ({ ...timing, manualBudgetMs: QA_MANUAL_BUSY.budgetMs });
export function scaleQaTiming(factor: number): void {
  timing.refillMs = Math.round(QA_REFILL_MS * factor);
  timing.inFlightRetryMs = Math.round(QA_IN_FLIGHT_RETRY_MS * factor);
  timing.cooldownMs = Math.round(QA_COOLDOWN_MS * factor);
  timing.redelayFloorMs = Math.round(QA_REDELAY_FLOOR_MS * factor);
  timing.yieldMaxMs = Math.round(QA_YIELD_MAX_MS * factor);
  timing.yieldTotalMs = Math.round(QA_YIELD_TOTAL_MS * factor);
  timing.yieldPollMs = Math.max(5, Math.round(QA_YIELD_POLL_MS * factor));
  QA_MANUAL_BUSY.budgetMs = Math.round(QA_MANUAL_BUDGET_MS * factor);
}
/** Test-only: replaces the sleep a waiting person does between busy retries (see `qaCallAwaitingSlot`). */
const sleeper = { sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)) };
export function setQaSleep(fn?: (ms: number) => Promise<void>): void {
  sleeper.sleep = fn ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
}
/** Test-only: tests that take several turns in a row for one company switch the cooldown off (0). */
export function setQaCooldown(ms: number): void {
  timing.cooldownMs = ms;
}
/** One QA call per placement; `PLACEMENTS` has five values. */
export const QA_MAX_CALLS = 5;
export const QA_LEASE_TTL_MS = QA_MAX_CALLS * 2 * 120_000;

/** A person waiting on a manual check gives up after this much busy-waiting in total (A12). The budget is mutable only for `scaleQaTiming`. */
export const QA_MANUAL_BUSY: { retries: number; budgetMs: number } = {
  retries: 5,
  budgetMs: QA_MANUAL_BUDGET_MS,
};
/** Workers never sleep on a 429: they re-delay themselves instead. */
export const QA_NO_BUSY = { retries: 0 } as const;

const leaseKey = (companyId: string) => `qa:lease:${companyId}`;
/** Two allowances per company (architect ruling, T-43-3 r3): a shop's artwork backlog can't eat its design checks. */
export type QaBucket = "design" | "artwork";
const rateKey = (companyId: string, bucket: QaBucket) => `qa:rate:${bucket}:${companyId}`;

/** Sorted set of companies whose manual QA is sleeping on a 429 (member = company id, score = ms). */
const WAITING_KEY = "qa:manual-waiting";

/** Register (ARGV[1]) and prune entries older than ARGV[2] ms, from the server clock. */
const WAIT_SCRIPT = `
local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - tonumber(ARGV[2]))
redis.call('ZADD', KEYS[1], now, ARGV[1])
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return 1
`;

/** How many companies other than ARGV[1] are registered (after pruning entries older than ARGV[2] ms). */
const FOREIGN_SCRIPT = `
local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - tonumber(ARGV[2]))
local n = redis.call('ZCARD', KEYS[1])
if redis.call('ZSCORE', KEYS[1], ARGV[1]) then n = n - 1 end
return n
`;

const REFUND_SCRIPT = `
local tokens = tonumber(redis.call('HGET', KEYS[1], 'tokens'))
if tokens == nil then return 0 end
redis.call('HSET', KEYS[1], 'tokens', tostring(math.min(tonumber(ARGV[1]), tokens + tonumber(ARGV[2]))))
return 1
`;

const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`;

/** Only the token holder shortens its own lease to the cooldown; another holder's lease is untouched. */
const COOLDOWN_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
return 0
`;

/** Refill from the server clock; with at least one token, charge ARGV[3] calls (debt allowed). */
const ALLOWANCE_SCRIPT = `
local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
local burst = tonumber(ARGV[1])
local refill = tonumber(ARGV[2])
local calls = tonumber(ARGV[3])
local h = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(h[1])
local ts = tonumber(h[2])
if tokens == nil then tokens = burst; ts = now end
tokens = math.min(burst, tokens + (now - ts) / refill)
local wait = 0
if tokens >= 1 then
  tokens = tokens - calls
else
  wait = math.ceil((1 - tokens) * refill)
end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', tostring(now))
redis.call('PEXPIRE', KEYS[1], (burst + tonumber(ARGV[4])) * refill)
return wait
`;

/**
 * How a turn ends. `busy`: imaging answered 429. The allowance is charged up front, so without a
 * refund a worker polling a busy slot burnt a token per poll and was then held back by the refill
 * (10 s a token) while the slot was free between the attacker's turns (T-46-3: the victim's job
 * took 42-62 s in a third of the runs). `ran` = calls of this turn that reached imaging before it
 * answered busy (default 0); the other charged calls are refunded. A turn that ended any other way
 * keeps its full charge (S-79).
 */
export type QaRelease = { busy?: boolean; ran?: number };

/** `runDesignQa` notes here how many placements had been checked when imaging answered 429. */
export const qaCallsRan = new WeakMap<object, number>();

export type QaTurn =
  | { ok: true; release: (opts?: QaRelease) => Promise<void> }
  | { ok: false; reason: "in_flight" | "rate"; retryAfterMs: number };

/** `calls` = the `/qa/check` calls this turn will make (one per placement), 1..QA_MAX_CALLS. */
export async function takeQaTurn(
  companyId: string,
  calls: number,
  bucket: QaBucket,
): Promise<QaTurn> {
  const charge = Math.min(QA_MAX_CALLS, Math.max(1, Math.floor(calls)));
  const token = randomUUID();
  const none = async () => {};
  try {
    const got = await redis.set(leaseKey(companyId), token, "PX", QA_LEASE_TTL_MS, "NX");
    if (got !== "OK") {
      // A turn is normally a few seconds (wave 42: worst 4.3 s), so ask again soon.
      return { ok: false, reason: "in_flight", retryAfterMs: timing.inFlightRetryMs };
    }
    const free = async () => {
      try {
        await redis.eval(RELEASE_SCRIPT, 1, leaseKey(companyId), token);
      } catch (err) {
        log.warn("qa lease release failed", { companyId, error: String(err) });
      }
    };
    // `busy`: imaging answered 429, so this turn never held the slot and owes no cooldown.
    const release = async (opts?: QaRelease) => {
      if (opts?.busy) {
        // Imaging refused, so the calls that did not run were charged for nothing (see QaRelease).
        const unused = Math.max(0, charge - Math.floor(opts.ran ?? 0));
        if (unused > 0) {
          try {
            await redis.eval(REFUND_SCRIPT, 1, rateKey(companyId, bucket), QA_BURST, unused);
          } catch (err) {
            log.warn("qa allowance refund failed", { companyId, error: String(err) });
          }
        }
        return free();
      }
      try {
        await redis.eval(COOLDOWN_SCRIPT, 1, leaseKey(companyId), token, timing.cooldownMs);
      } catch (err) {
        log.warn("qa lease release failed", { companyId, error: String(err) });
      }
    };
    try {
      const wait = (await redis.eval(
        ALLOWANCE_SCRIPT,
        1,
        rateKey(companyId, bucket),
        QA_BURST,
        timing.refillMs,
        charge,
        QA_MAX_CALLS,
      )) as number;
      if (wait > 0) {
        await free(); // no turn ran, so no cooldown
        return { ok: false, reason: "rate", retryAfterMs: wait };
      }
    } catch (err) {
      await free();
      throw err;
    }
    return { ok: true, release };
  } catch (err) {
    log.warn("qa turn check failed (allowing)", { companyId, error: String(err) });
    return { ok: true, release: none };
  }
}

/** True while another company's manual QA is sleeping on a 429. Valkey trouble: false (one warn). */
export async function foreignManualWaiting(companyId: string): Promise<boolean> {
  try {
    const n = (await redis.eval(
      FOREIGN_SCRIPT,
      1,
      WAITING_KEY,
      companyId,
      QA_MANUAL_BUDGET_MS,
    )) as number;
    return n > 0;
  } catch (err) {
    log.warn("qa waiting check failed (allowing)", { companyId, error: String(err) });
    return false;
  }
}

async function markManualWaiting(companyId: string): Promise<void> {
  try {
    await redis.eval(WAIT_SCRIPT, 1, WAITING_KEY, companyId, QA_MANUAL_BUDGET_MS);
  } catch (err) {
    log.warn("qa waiting mark failed (allowing)", { companyId, error: String(err) });
  }
}

async function clearManualWaiting(companyId: string): Promise<void> {
  try {
    await redis.zrem(WAITING_KEY, companyId);
  } catch (err) {
    log.warn("qa waiting clear failed", { companyId, error: String(err) });
  }
}

/**
 * Before placement 2.. of a turn that holds its lease: wait while another company's manual QA is
 * sleeping on a 429, within `yieldMaxMs` here and `yieldTotalMs` for the turn (`state.spentMs`).
 * The lease is untouched. Returns how long it waited.
 */
export async function yieldToManualCaller(
  companyId: string,
  state: { spentMs: number },
  sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
): Promise<number> {
  const limit = Math.min(timing.yieldMaxMs, timing.yieldTotalMs - state.spentMs);
  let waited = 0;
  while (waited < limit && (await foreignManualWaiting(companyId))) {
    const step = Math.min(timing.yieldPollMs, limit - waited);
    await sleep(step);
    waited += step;
  }
  state.spentMs += waited;
  return waited;
}

/**
 * One imaging call for a person who waits on a busy slot (`busy.retries` > 0): the same retry
 * rules as the client (hint from the 429, `retries`, total `budgetMs`), but the sleeps happen here
 * so the company is registered from its first 429 until the call ends (served, refused for good
 * or failed), and always removed again.
 * Anyone else (a worker with `retries: 0`, the seed) calls straight through.
 */
export async function qaCallAwaitingSlot<T>(
  companyId: string,
  busy: { retries?: number; budgetMs?: number } | undefined,
  call: (busy: { retries: number; budgetMs?: number } | undefined) => Promise<T>,
): Promise<T> {
  const retries = busy?.retries ?? 0;
  if (retries <= 0) return call(busy ? { retries: 0 } : undefined);
  let waited = 0;
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        return await call({ retries: 0 });
      } catch (err) {
        if (!isImagingBusy(err) || attempt >= retries) throw err;
        const wait = err.retryAfterMs ?? 5_000;
        if (busy?.budgetMs !== undefined && waited + wait > busy.budgetMs) throw err;
        waited += wait;
        await markManualWaiting(companyId);
        await sleeper.sleep(wait);
      }
    }
  } finally {
    await clearManualWaiting(companyId);
  }
}

/** Seconds for the `RATE_LIMITED` error and the logs; never below one. */
export const retrySeconds = (ms: number) => Math.max(1, Math.ceil(ms / 1000));

export const isImagingBusy = (err: unknown): err is ImagingError =>
  err instanceof ImagingError && err.status === 429;

/** Item flags from a QA result: one per code, the worst severity wins (T-42-5). */
export function artworkQaFlags(
  issues: { code: string; severity: string; message: string }[],
): { code: string; severity: ItemFlag["severity"]; message: string }[] {
  const worst = new Map<
    string,
    { code: string; severity: ItemFlag["severity"]; message: string }
  >();
  for (const issue of issues) {
    const f = {
      code: issue.code === "low_dpi" ? "artwork_low_dpi" : "artwork_qa_failed",
      severity: (issue.severity === "error" ? "error" : "warn") as ItemFlag["severity"],
      message: issue.message,
    };
    const cur = worst.get(f.code);
    if (!cur || (cur.severity !== "error" && f.severity === "error")) worst.set(f.code, f);
  }
  return [...worst.values()];
}

/** A QA job that is still waiting for its turn after this long leaves the design pending. */
export const QA_WAIT_LIMIT_MS = 30 * 60_000;

/**
 * A worker never sleeps on a busy imaging slot (S-76): it moves its own job to the delayed set
 * and frees the render worker. Retry-After plus jitter, at least 1 s. Past `QA_WAIT_LIMIT_MS`
 * since the job was added it gives up with one warn log; the design stays `pending`.
 * `job.token` is set by the BullMQ worker (A11).
 */
export async function redelayQa(
  job: Pick<Job, "timestamp" | "token" | "moveToDelayed">,
  retryAfterMs: number,
  ctx: { companyId: string; what: string; id: string },
  now = Date.now(),
): Promise<{ gaveUp: true }> {
  if (now - job.timestamp > QA_WAIT_LIMIT_MS) {
    log.warn("qa still waiting for a turn, giving up", ctx);
    return { gaveUp: true };
  }
  const delay =
    Math.max(timing.redelayFloorMs, retryAfterMs) +
    Math.floor(Math.random() * timing.redelayFloorMs);
  await job.moveToDelayed(now + delay, job.token);
  throw new DelayedError();
}
