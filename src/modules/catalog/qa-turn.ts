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
 * Valkey trouble fails open with one warn log, like `lib/fairness.ts`: the fairness guarantee is
 * lost, nobody's QA is. Callers: the router's `runQa`, the QA job, `setItemArtwork` and its
 * follow-up job. Not `runDesignQa` itself: the seed runs it in sequence and stays unthrottled.
 */

export const QA_BURST = 3;
export const QA_REFILL_MS = 20_000;
export const QA_IN_FLIGHT_RETRY_MS = 3_000;
/**
 * Live timing, equal to the constants above. Only tests call `scaleQaTiming`, to run the same
 * dynamics at a fraction of the wall-clock time; the bounds they assert are never scaled.
 */
const timing = { refillMs: QA_REFILL_MS, inFlightRetryMs: QA_IN_FLIGHT_RETRY_MS };
export function scaleQaTiming(factor: number): void {
  timing.refillMs = Math.round(QA_REFILL_MS * factor);
  timing.inFlightRetryMs = Math.round(QA_IN_FLIGHT_RETRY_MS * factor);
}
/** One QA call per placement; `PLACEMENTS` has five values. */
export const QA_MAX_CALLS = 5;
export const QA_LEASE_TTL_MS = QA_MAX_CALLS * 2 * 120_000;

/** A person waiting on a manual check gives up after this much busy-waiting in total (A12). */
export const QA_MANUAL_BUSY = { retries: 5, budgetMs: 25_000 } as const;
/** Workers never sleep on a 429: they re-delay themselves instead. */
export const QA_NO_BUSY = { retries: 0 } as const;

const leaseKey = (companyId: string) => `qa:lease:${companyId}`;
/** Two allowances per company (architect ruling, T-43-3 r3): a shop's artwork backlog can't eat its design checks. */
export type QaBucket = "design" | "artwork";
const rateKey = (companyId: string, bucket: QaBucket) => `qa:rate:${bucket}:${companyId}`;

const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
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

export type QaTurn =
  | { ok: true; release: () => Promise<void> }
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
    const release = async () => {
      try {
        await redis.eval(RELEASE_SCRIPT, 1, leaseKey(companyId), token);
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
        await release();
        return { ok: false, reason: "rate", retryAfterMs: wait };
      }
    } catch (err) {
      await release();
      throw err;
    }
    return { ok: true, release };
  } catch (err) {
    log.warn("qa turn check failed (allowing)", { companyId, error: String(err) });
    return { ok: true, release: none };
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
  const delay = Math.max(1_000, retryAfterMs) + Math.floor(Math.random() * 1_000);
  await job.moveToDelayed(now + delay, job.token);
  throw new DelayedError();
}
