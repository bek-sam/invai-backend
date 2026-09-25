import { upstream } from "../../../lib/errors";
import { logger } from "../../../lib/log";
import type { ChannelConn } from "../types";
import { SHOPIFY_API_VERSION } from "./common";

const log = logger("channels.shopify.client");

/*
 * Admin GraphQL client with Shopify's cost-based throttle.
 * https://shopify.dev/docs/apps/build/apis/graphql-admin/rate-limits
 * Every response carries `extensions.cost.throttleStatus {maximumAvailable, currentlyAvailable,
 * restoreRate}`. Before a call we estimate what the bucket holds now and, when the query's
 * expected cost doesn't fit, wait `(cost - available) / restoreRate` seconds. A throttled answer
 * (HTTP 429, or 200 with a THROTTLED error) waits the same way and retries; never a fixed loop.
 * The bucket state is per shop and per process (the worker is the only heavy caller).
 */

type ThrottleStatus = { maximumAvailable: number; currentlyAvailable: number; restoreRate: number };

type GqlResponse<T> = {
  data?: T;
  errors?: { message: string; extensions?: { code?: string } }[];
  extensions?: {
    cost?: {
      requestedQueryCost?: number;
      actualQueryCost?: number | null;
      throttleStatus?: ThrottleStatus;
    };
  };
};

/** Thrown when Shopify refuses the token (401/403): the caller may refresh and retry once. */
export class ShopifyAuthError extends Error {
  constructor(readonly status: number) {
    super(`access denied (${status}); reconnect the store`);
  }
}

const MAX_ATTEMPTS = 5;
const MAX_WAIT_MS = 30_000;
const DEFAULT_COST = 10;

const buckets = new Map<string, ThrottleStatus & { at: number }>();

let sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Tests: replace the sleep so throttle waits are observed instead of slept. */
export function setShopifySleep(fn: (ms: number) => Promise<void>) {
  const prev = sleep;
  sleep = fn;
  return () => {
    sleep = prev;
  };
}

export function resetShopifyThrottle() {
  buckets.clear();
}

/** Points the bucket holds now, from the last status plus what restored since. */
function estimateAvailable(shop: string, now = Date.now()): ThrottleStatus | null {
  const b = buckets.get(shop);
  if (!b) return null;
  const restored = ((now - b.at) / 1000) * b.restoreRate;
  return {
    ...b,
    currentlyAvailable: Math.min(b.maximumAvailable, b.currentlyAvailable + restored),
  };
}

/** Sleep for the bucket, then record what restored meanwhile (the estimate restarts from now). */
async function waitForBucket(shop: string, status: ThrottleStatus | null | undefined, ms: number) {
  await sleep(ms);
  if (status)
    buckets.set(shop, {
      ...status,
      currentlyAvailable: Math.min(
        status.maximumAvailable,
        status.currentlyAvailable + (ms / 1000) * status.restoreRate,
      ),
      at: Date.now(),
    });
}

/** Milliseconds to wait so `cost` points are available (0 when they already are). */
export function throttleWaitMs(status: ThrottleStatus | null | undefined, cost: number): number {
  if (!status || status.restoreRate <= 0) return 0;
  const missing = Math.min(cost, status.maximumAvailable) - status.currentlyAvailable;
  if (missing <= 0) return 0;
  return Math.min(MAX_WAIT_MS, Math.ceil((missing / status.restoreRate) * 1000));
}

function backoffMs(attempt: number, retryAfter: string | null) {
  const hinted = retryAfter ? Number(retryAfter) * 1000 : Number.NaN;
  if (Number.isFinite(hinted) && hinted > 0) return Math.min(MAX_WAIT_MS, hinted);
  return Math.min(MAX_WAIT_MS, 1000 * 2 ** attempt + Math.floor(Math.random() * 250));
}

export type GraphqlOptions = {
  /** Expected query cost, used to wait before the call when the bucket is low. */
  cost?: number;
};

export async function shopifyGraphql<T>(
  conn: Pick<ChannelConn, "externalShopId" | "credentials">,
  query: string,
  variables: Record<string, unknown> = {},
  opts: GraphqlOptions = {},
): Promise<T> {
  const shop = conn.externalShopId;
  const token = conn.credentials?.accessToken;
  if (!shop || !token) throw upstream("Shopify", "connection has no access token; reconnect");
  const url = `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  const cost = opts.cost ?? DEFAULT_COST;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const estimate = estimateAvailable(shop);
    const wait = throttleWaitMs(estimate, cost);
    if (wait > 0) {
      log.info("waiting for the Shopify cost bucket", { shop, waitMs: wait, cost });
      await waitForBucket(shop, estimate, wait);
    }
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-shopify-access-token": token },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    }).catch((err) => {
      throw upstream("Shopify", err instanceof Error ? err.message : String(err));
    });
    if (res.status === 401 || res.status === 403) throw new ShopifyAuthError(res.status);
    if (res.status === 429) {
      await sleep(backoffMs(attempt, res.headers.get("retry-after")));
      continue;
    }
    if (res.status >= 500) {
      if (attempt < MAX_ATTEMPTS - 1) {
        await sleep(backoffMs(attempt, null));
        continue;
      }
      throw upstream("Shopify", `server error (${res.status})`);
    }
    const json = (await res.json()) as GqlResponse<T>;
    const status = json.extensions?.cost?.throttleStatus;
    if (status) buckets.set(shop, { ...status, at: Date.now() });
    if (json.errors?.length) {
      const throttled = json.errors.some(
        (e) => e.extensions?.code === "THROTTLED" || /throttled/i.test(e.message),
      );
      if (throttled && attempt < MAX_ATTEMPTS - 1) {
        const requested = json.extensions?.cost?.requestedQueryCost ?? cost;
        await waitForBucket(
          shop,
          status,
          throttleWaitMs(status, requested) || backoffMs(attempt, null),
        );
        continue;
      }
      throw upstream("Shopify", json.errors.map((e) => e.message).join("; "));
    }
    if (!json.data) throw upstream("Shopify", `empty response (${res.status})`);
    return json.data;
  }
  throw upstream("Shopify", "rate limited; try again shortly");
}
