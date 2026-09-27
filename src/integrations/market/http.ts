import { logger } from "../../lib/log";
import { permanentFailure } from "../../lib/queues";
import { takeToken } from "../suppliers/ratelimit";
import type { SignalSource } from "./types";

const log = logger("market.http");

/**
 * Thrown by a market provider for anything a retry can't fix by itself (a 4xx that isn't
 * 401/403, a redirect, a body over the size cap, an exhausted retry budget). 401/403 instead
 * throw BullMQ's `UnrecoverableError` via `permanentFailure` (rule: a bad/revoked key needs a
 * person, not five retries).
 */
export class MarketProviderError extends Error {
  constructor(
    public readonly source: SignalSource,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Hosts a real market adapter may call (rule 8: outbound HTTP is allowlisted). Every one of
 * these is unused today (no key is ever set in this build): adding a live one is a one-line
 * change here plus the provider's own adapter file, never a wildcard.
 */
export const MARKET_ALLOWED_HOSTS: ReadonlySet<string> = new Set([
  "api.census.gov",
  "trends.googleapis.com",
  "api.pinterest.com",
  "sellingpartnerapi-na.amazon.com",
  "marketplace.walmartapis.com",
  "developer.junglescout.com",
]);

/** Response size cap (rule 8). Exported so a test can prove the cap without allocating 5 MB. */
export const MARKET_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_BODY_BYTES = MARKET_MAX_RESPONSE_BYTES;
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 500;
const RETRY_CAP_MS = 8_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Full jitter backoff (same shape as `carriers/easypost`'s `RETRY_429`), capped so it never hot-loops. */
function jitterMs(attempt: number): number {
  return Math.random() * Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** attempt);
}

/** Reads the body with a size cap (rule 8), so a misbehaving or hostile response can't exhaust memory. */
async function readCapped(res: Response, source: SignalSource): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return res.text();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      throw new MarketProviderError(
        source,
        `${source}: response exceeded ${MAX_BODY_BYTES} bytes; refusing to read the rest`,
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

export type FetchPolicy = {
  source: SignalSource;
  url: string;
  init?: RequestInit;
  /** Per-provider Redis token bucket (rule 5), e.g. `{ key: "market:amazon_pricing:<connId>", capacity: 1, perMs: 30_000 }`. */
  rateLimit: { key: string; capacity: number; perMs: number };
  timeoutMs?: number;
};

/**
 * Shared outbound policy every real market adapter goes through: allowlisted host (rule 8), a
 * timeout, a per-provider rate limit (rule 5), retry with jitter on 429/5xx (rule 5), no blind
 * redirects (rule 8), a response size cap (rule 8), and `UnrecoverableError` on 401/403 (rule 6:
 * a revoked or wrong key needs a person, not five retries). No test calls a live host through
 * this: they stub `global.fetch` to prove the mapping, since no market provider key is ever set
 * in this build (card fence).
 */
export async function fetchJsonWithPolicy<T>(policy: FetchPolicy): Promise<T> {
  const host = new URL(policy.url).hostname;
  if (!MARKET_ALLOWED_HOSTS.has(host)) {
    throw new MarketProviderError(
      policy.source,
      `${policy.source}: host ${host} is not on the market provider allowlist`,
    );
  }
  await takeToken(policy.rateLimit.key, policy.rateLimit);

  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(policy.url, {
        ...policy.init,
        redirect: "manual",
        signal: AbortSignal.timeout(policy.timeoutMs ?? 10_000),
      });
    } catch (err) {
      if (attempt < MAX_ATTEMPTS - 1) {
        log.warn("market provider network error, retrying", {
          source: policy.source,
          attempt,
          error: String(err),
        });
        await sleep(jitterMs(attempt));
        continue;
      }
      throw new MarketProviderError(
        policy.source,
        `${policy.source}: network error: ${String(err)}`,
      );
    }

    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel().catch(() => {});
      permanentFailure(
        `${policy.source}: unauthorized (${res.status}); disable the source and check the key`,
      );
    }
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => {});
      throw new MarketProviderError(
        policy.source,
        `${policy.source}: refused to follow a redirect (${res.status})`,
      );
    }
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS - 1) {
      await res.body?.cancel().catch(() => {});
      log.warn("market provider retrying", { source: policy.source, status: res.status, attempt });
      await sleep(jitterMs(attempt));
      continue;
    }

    const body = await readCapped(res, policy.source);
    if (!res.ok) {
      throw new MarketProviderError(
        policy.source,
        `${policy.source}: upstream error ${res.status}: ${body.slice(0, 300)}`,
      );
    }
    return JSON.parse(body) as T;
  }
}
