import { ORPCError } from "@orpc/server";

/**
 * Typed error helpers matching contracts `COMMON_ERRORS`. Throw these from services and
 * handlers; oRPC maps them to HTTP status codes and clients get `error.code` + `error.data`.
 * Keep messages safe to show to users.
 */

export function notFound(entity: string, id?: string) {
  return new ORPCError("NOT_FOUND", {
    message: id ? `${entity} ${id} not found` : `${entity} not found`,
    data: { entity, id },
  });
}

export function unauthorized(message = "Sign in required") {
  return new ORPCError("UNAUTHORIZED", { message });
}

export function forbidden(permission: string, message = "Missing permission") {
  return new ORPCError("FORBIDDEN", { message, data: { permission } });
}

/** A paid action (label buy, checkout, billing portal) before the email is verified (HTTP 403). */
export function emailNotVerified() {
  return new ORPCError("EMAIL_NOT_VERIFIED", { status: 403, message: "Verify your email first" });
}

/** Two-step sign-in is required and its grace period ended (T-28-2, ADR 0025, src/lib/mfa.ts). */
export function mfaRequired(deadline: Date | null) {
  return new ORPCError("MFA_REQUIRED", {
    status: 403,
    message: "Turn on two-step sign-in to continue",
    data: { deadline: deadline?.toISOString() ?? null },
  });
}

export function badRequest(message: string, data?: unknown) {
  return new ORPCError("BAD_REQUEST", { message, data });
}

export function conflict(message: string, data?: unknown) {
  return new ORPCError("CONFLICT", { message, data });
}

export type TransitionEntity =
  | "order_item"
  | "sheet"
  | "shipment"
  | "purchase_order"
  | "listing_draft";

/** A state-machine violation (HTTP 409, contracts `INVALID_TRANSITION`). */
export function invalidTransition(entity: TransitionEntity, id: string, from: string, to: string) {
  return new ORPCError("INVALID_TRANSITION", {
    status: 409,
    message: `${entity} ${id}: ${from} -> ${to} is not allowed`,
    data: { entity, id, from, to },
  });
}

export function planLimit(
  meter: "orders" | "aiCredits" | "users" | "connections",
  used: number,
  limit: number,
) {
  return new ORPCError("PLAN_LIMIT_REACHED", {
    status: 402,
    message: "Plan limit reached",
    data: { meter, used, limit },
  });
}

export function rateLimited(retryAfterSec: number) {
  return new ORPCError("RATE_LIMITED", {
    status: 429,
    message: "Too many requests",
    data: { retryAfterSec },
  });
}

/**
 * A floor tablet on a contract version below `MIN_FLOOR_CONTRACT_VERSION`, or with no
 * `X-Contract-Version` header (HTTP 426, T-13-1, ADR 0012). The floor shows "Update needed".
 */
export function clientTooOld(minVersion: string, current: string | null) {
  return new ORPCError("CLIENT_TOO_OLD", {
    status: 426,
    message: "This app is out of date. Update it to continue",
    data: { minVersion, current },
  });
}

/** An external service (imaging, carrier, channel, model) failed (HTTP 502). */
export function upstream(service: string, detail: string | null = null) {
  return new ORPCError("UPSTREAM_FAILED", {
    status: 502,
    message: `${service} failed${detail ? `: ${detail}` : ""}`,
    data: { service, detail },
  });
}

export function notImplemented(name: string) {
  return new ORPCError("NOT_IMPLEMENTED", { message: `${name} is not implemented yet` });
}

export function isORPCError(err: unknown): err is ORPCError<string, unknown> {
  return err instanceof ORPCError;
}

export { ORPCError };
