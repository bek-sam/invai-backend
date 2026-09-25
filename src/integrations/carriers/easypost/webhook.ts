import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../../../env";
import { type EpTracker, normalizeEasypostTracker, type TrackerUpdate } from "../tracking";

/*
 * EasyPost webhooks (https://docs.easypost.com/guides/webhooks-guide, Event object
 * https://docs.easypost.com/docs/events). Checked against the official clients:
 * easypost-python `easypost/util.py` `validate_webhook` and easypost-node `src/utils/util.ts`
 * `validateWebhook`:
 *   X-Hmac-Signature: hmac-sha256-hex=<hex HMAC-SHA256(NFKD(secret) as UTF-8, raw body)>
 * No timestamp is signed, so replays are stopped by the event-id dedupe instead. EasyPost wants a
 * 2xx within 7 s, retries 6 times, and disables endpoints that keep failing.
 */

/** Mock mode signs webhooks with a fixed dev secret so local tests can post signed events. */
export const MOCK_EASYPOST_WEBHOOK_SECRET = "mock-easypost-webhook-secret";

export function easypostWebhookSecret(): string {
  return env.EASYPOST_WEBHOOK_SECRET ?? MOCK_EASYPOST_WEBHOOK_SECRET;
}

const SIGNATURE_PREFIX = "hmac-sha256-hex=";

/** The `X-Hmac-Signature` value EasyPost sends for `body`. */
export function signEasypostBody(body: string, secret = easypostWebhookSecret()): string {
  const key = Buffer.from(secret.normalize("NFKD"), "utf8");
  return `${SIGNATURE_PREFIX}${createHmac("sha256", key).update(body, "utf8").digest("hex")}`;
}

type Headers = Record<string, string | undefined>;

/** Constant-time check of `X-Hmac-Signature` over the raw body. */
export function verifyEasypostSignature(headers: Headers, body: string, secret: string): boolean {
  const got = Object.entries(headers).find(([k]) => k.toLowerCase() === "x-hmac-signature")?.[1];
  if (!got?.startsWith(SIGNATURE_PREFIX)) return false;
  const a = Buffer.from(got.slice(SIGNATURE_PREFIX.length).toLowerCase(), "utf8");
  const b = Buffer.from(signEasypostBody(body, secret).slice(SIGNATURE_PREFIX.length), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The parts of a verified EasyPost Event we act on (no PII). */
export type EasypostEvent = {
  id: string;
  /** e.g. `tracker.updated`, `tracker.created`, `refund.successful`. */
  description: string;
  mode: "test" | "production" | null;
  tracker: TrackerUpdate | null;
};

/** Parse a verified body. Returns null when it isn't an Event with an id. */
export function parseEasypostEvent(body: string): EasypostEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const e = raw as {
    id?: unknown;
    object?: unknown;
    description?: unknown;
    mode?: unknown;
    result?: EpTracker | null;
  };
  if (typeof e.id !== "string" || !e.id || typeof e.description !== "string") return null;
  const isTracker = e.description.startsWith("tracker.") && e.result?.object === "Tracker";
  return {
    id: e.id,
    description: e.description,
    mode: e.mode === "test" || e.mode === "production" ? e.mode : null,
    tracker: isTracker && e.result ? normalizeEasypostTracker(e.result) : null,
  };
}

/**
 * Which event mode this deployment accepts: EasyPost test keys start `EZTK`, production keys
 * `EZAK`. With no key (mock carrier) or an unknown prefix, any mode is accepted.
 */
export function acceptedEventMode(apiKey = env.EASYPOST_API_KEY): "test" | "production" | null {
  if (apiKey?.startsWith("EZTK")) return "test";
  if (apiKey?.startsWith("EZAK")) return "production";
  return null;
}
