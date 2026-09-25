import Stripe from "stripe";
import { env } from "../../env";
import type { BillingEvent, StripeSubscriptionStatus } from "./types";

/**
 * Signs mock/test webhooks outside production (scripts and tests sign with it; the real secret
 * always wins when set). Production never falls back to it, so without STRIPE_WEBHOOK_SECRET
 * every Stripe webhook is refused there.
 */
export const MOCK_STRIPE_WEBHOOK_SECRET = "whsec_invai_local_mock_do_not_use_in_production";

/** Stripe's default: a signature older than 5 minutes is refused (replay protection). */
export const STRIPE_SIGNATURE_TOLERANCE_SEC = 300;

export function stripeWebhookSecret(): string | null {
  if (env.STRIPE_WEBHOOK_SECRET) return env.STRIPE_WEBHOOK_SECRET;
  return env.isProd ? null : MOCK_STRIPE_WEBHOOK_SECRET;
}

/** A `Stripe-Signature` header for `payload` (tests and the local exercise script). */
export function signStripeWebhook(payload: string, secret = MOCK_STRIPE_WEBHOOK_SECRET, at?: Date) {
  return Stripe.webhooks.generateTestHeaderString({
    payload,
    secret,
    ...(at ? { timestamp: Math.floor(at.getTime() / 1000) } : {}),
  });
}

/**
 * Verify the signature on the raw body, then normalize. Null means "refuse": no secret, a bad or
 * stale signature, or a body that isn't a Stripe event. Nothing is parsed before verification.
 */
export function verifyStripeWebhook(
  rawBody: string,
  signature: string | undefined,
): BillingEvent | null {
  const secret = stripeWebhookSecret();
  if (!secret || !signature) return null;
  let event: Stripe.Event;
  try {
    event = Stripe.webhooks.constructEvent(
      rawBody,
      signature,
      secret,
      STRIPE_SIGNATURE_TOLERANCE_SEC,
    );
  } catch {
    return null;
  }
  if (typeof event?.id !== "string" || typeof event.type !== "string") return null;
  return normalizeStripeEvent(event);
}

const idOf = (v: string | { id: string } | null | undefined) =>
  v == null ? null : typeof v === "string" ? v : v.id;

const strings = (m: Record<string, string> | null | undefined): Record<string, string> =>
  Object.fromEntries(Object.entries(m ?? {}).filter(([, v]) => typeof v === "string"));

const SUB_STATUSES = new Set<string>([
  "active",
  "trialing",
  "past_due",
  "unpaid",
  "canceled",
  "incomplete",
  "incomplete_expired",
  "paused",
]);

const fromUnix = (s: number | null | undefined) =>
  typeof s === "number" ? new Date(s * 1000) : null;

export function normalizeStripeEvent(event: Stripe.Event): BillingEvent {
  const base = { id: event.id, type: event.type, created: new Date(event.created * 1000) };
  switch (event.type) {
    case "checkout.session.completed": {
      const s = event.data.object;
      const metadata = strings(s.metadata);
      return {
        ...base,
        data: {
          kind: "checkout",
          mode: s.mode === "payment" ? "payment" : s.mode === "setup" ? "setup" : "subscription",
          companyRef: s.client_reference_id ?? metadata.companyId ?? null,
          customerId: idOf(s.customer),
          subscriptionId: idOf(s.subscription),
          paid: s.payment_status === "paid" || s.payment_status === "no_payment_required",
          metadata,
        },
      };
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const sub = event.data.object;
      const items = sub.items?.data ?? [];
      const metadata = strings(sub.metadata);
      // Since API 2025-03-31 the billing period lives on the items, not the subscription.
      const ends = items.map((i) => i.current_period_end).filter((n) => typeof n === "number");
      const starts = items.map((i) => i.current_period_start).filter((n) => typeof n === "number");
      return {
        ...base,
        data: {
          kind: "subscription",
          deleted: event.type === "customer.subscription.deleted",
          subscriptionId: sub.id,
          customerId: idOf(sub.customer),
          companyRef: metadata.companyId ?? null,
          status: (SUB_STATUSES.has(sub.status) ? sub.status : "other") as StripeSubscriptionStatus,
          lookupKey: items[0]?.price?.lookup_key ?? null,
          metadata,
          currentPeriodStart: starts.length ? fromUnix(Math.max(...starts)) : null,
          currentPeriodEnd: ends.length ? fromUnix(Math.min(...ends)) : null,
          cancelAtPeriodEnd: sub.cancel_at_period_end === true,
        },
      };
    }
    case "invoice.paid":
    case "invoice.payment_failed": {
      const inv = event.data.object;
      const details = inv.parent?.subscription_details ?? null;
      return {
        ...base,
        data: {
          kind: "invoice",
          paid: event.type === "invoice.paid",
          subscriptionId: idOf(details?.subscription),
          customerId: idOf(inv.customer),
          companyRef: strings(details?.metadata).companyId ?? null,
        },
      };
    }
    default:
      return { ...base, data: { kind: "other" } };
  }
}
