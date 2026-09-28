import { env } from "../env";
import { hmacHex, signPayload, verifyPayload } from "./crypto";

/*
 * Signed email links (wave 19, ADR 0016; shape pinned in invai-contracts README "Public link
 * routes"). A link is `${BETTER_AUTH_URL}/l/:token`, served by src/api/links.ts without a session.
 * The token is `signPayload` over `{ v, k, c, u, r, exp }` with a purpose-bound key derived from
 * BETTER_AUTH_SECRET, so a floor session token or any other HMAC in the system can never pass as a
 * link, and no new secret exists to rotate. The verifier here checks signature, shape and expiry
 * only; binding `c` + `u` to an active membership is the route's job (it needs the database).
 *
 * `exp` is rounded to the day, so every token signed for the same person, kind and ref on the same
 * day is byte-identical: the List-Unsubscribe header and the footer link in one email match.
 */

export const LINK_KINDS = ["unsubscribe", "click"] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

export const LINK_TOKEN_VERSION = 1;
/** Unsubscribe links must keep working from an old inbox; clicks are short-lived. */
export const LINK_TTL_DAYS: Record<LinkKind, number> = { unsubscribe: 400, click: 30 };
export const LINK_REF_MAX = 128;
const DAY_SEC = 86_400;

export type LinkPayload = {
  v: typeof LINK_TOKEN_VERSION;
  k: LinkKind;
  /** companyId */
  c: string;
  /** userId */
  u: string;
  /** ref: the notification kind for `unsubscribe`, the handler's own reference for `click`. */
  r: string;
  /** Expiry, seconds since the epoch. */
  exp: number;
};

export type SignLinkInput = { kind: LinkKind; companyId: string; userId: string; ref: string };

/** The purpose-bound signing key: never BETTER_AUTH_SECRET itself. */
export function linkSigningKey(): string {
  return hmacHex(env.BETTER_AUTH_SECRET, `links:v${LINK_TOKEN_VERSION}`);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function signLinkToken(input: SignLinkInput, now: number = Date.now()): string {
  if (!UUID.test(input.companyId) || !UUID.test(input.userId))
    throw new Error("signLink: companyId and userId must be UUIDs");
  if (!input.ref || input.ref.length > LINK_REF_MAX)
    throw new Error(`signLink: ref must be 1..${LINK_REF_MAX} chars`);
  if (!LINK_KINDS.includes(input.kind)) throw new Error(`signLink: unknown kind ${input.kind}`);
  const today = Math.floor(now / 1000 / DAY_SEC) * DAY_SEC;
  const payload: LinkPayload = {
    v: LINK_TOKEN_VERSION,
    k: input.kind,
    c: input.companyId,
    u: input.userId,
    r: input.ref,
    exp: today + LINK_TTL_DAYS[input.kind] * DAY_SEC,
  };
  return signPayload(linkSigningKey(), payload);
}

/** The full URL to put in an email: `${BETTER_AUTH_URL}/l/<token>`. */
export function signLink(input: SignLinkInput, now: number = Date.now()): string {
  return `${env.BETTER_AUTH_URL.replace(/\/$/, "")}/l/${signLinkToken(input, now)}`;
}

/**
 * Signature, shape and expiry. Returns null for anything else: a wrong key, an edited payload,
 * an unknown version or kind, a non-UUID id, an over-long ref, or a token past `exp`.
 */
export function verifyLinkToken(token: string, now: number = Date.now()): LinkPayload | null {
  if (typeof token !== "string" || token.length < 20 || token.length > 2048) return null;
  const raw = verifyPayload<Partial<LinkPayload>>(linkSigningKey(), token);
  if (!raw || typeof raw !== "object") return null;
  if (raw.v !== LINK_TOKEN_VERSION) return null;
  if (raw.k !== "unsubscribe" && raw.k !== "click") return null;
  if (typeof raw.c !== "string" || !UUID.test(raw.c)) return null;
  if (typeof raw.u !== "string" || !UUID.test(raw.u)) return null;
  if (typeof raw.r !== "string" || !raw.r || raw.r.length > LINK_REF_MAX) return null;
  if (typeof raw.exp !== "number" || !Number.isFinite(raw.exp)) return null;
  if (raw.exp * 1000 <= now) return null;
  return { v: 1, k: raw.k, c: raw.c, u: raw.u, r: raw.r, exp: raw.exp };
}

/**
 * Where a redirect may go on the web origin: a plain absolute path (`/digests/2026-W39`), never
 * `//evil`, a scheme, a backslash or a control character. Anything else becomes `/`.
 */
export function safeWebPath(path: unknown): string {
  if (typeof path !== "string" || path.length === 0 || path.length > 2048) return "/";
  if (!path.startsWith("/") || path.startsWith("//") || path.startsWith("/\\")) return "/";
  for (const ch of path) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f || ch === "\\" || /\s/.test(ch)) return "/";
  }
  if (/^\/[^/?#]*:/.test(path)) return "/";
  return path;
}

/* --------------------------------- click handlers --------------------------------- */

export type LinkHandlerInput = { companyId: string; userId: string; ref: string };
/** Records the click for its module and says where the web app should land; null means `/`. */
export type LinkHandler = (input: LinkHandlerInput) => Promise<{ path: string } | null>;

const handlers = new Map<Exclude<LinkKind, "unsubscribe">, LinkHandler>();

/**
 * A module registers the one handler for `click` links in its entry file (loaded by
 * `src/modules/jobs.ts`, which the API imports). Registering twice replaces the handler, so a
 * test can swap it; production has exactly one (the digest module, T-19-3).
 */
export function registerLinkHandler(kind: "click", handler: LinkHandler): void {
  handlers.set(kind, handler);
}

export function getLinkHandler(kind: "click"): LinkHandler | undefined {
  return handlers.get(kind);
}
