/*
 * Billing provider (Stripe) behind one interface. Services never see Stripe objects: webhook
 * events are normalized at the edge (`BillingEvent`), and prices are addressed by lookup key
 * (`invai_plan_<plan>` / `invai_pack_<pack>`), which the owner sets on the Stripe prices.
 */

export type CheckoutMode = "subscription" | "payment";

export type CheckoutRequest = {
  companyId: string;
  /** Reuse the company's Stripe customer when it has one. */
  customerId: string | null;
  mode: CheckoutMode;
  /** Stripe price lookup key (see `planLookupKey` / `packLookupKey`). */
  lookupKey: string;
  /** Copied to the session (and the subscription, in subscription mode). Ids and keys only. */
  metadata: Record<string, string>;
  successUrl: string;
  cancelUrl: string;
};

export type BillingProvider = {
  /** "live" = real Stripe API; "mock" = local URLs, no network. */
  kind: "live" | "mock";
  createCheckout(req: CheckoutRequest): Promise<{ id: string; url: string }>;
  createPortal(req: { customerId: string; returnUrl: string }): Promise<{ url: string }>;
  /** Idempotent: Stripe keeps `cancel_at_period_end = true` on a repeat. */
  cancelAtPeriodEnd(subscriptionId: string): Promise<void>;
};

/** Stripe subscription statuses we act on (anything else is `other`). */
export type StripeSubscriptionStatus =
  | "active"
  | "trialing"
  | "past_due"
  | "unpaid"
  | "canceled"
  | "incomplete"
  | "incomplete_expired"
  | "paused"
  | "other";

/** A verified Stripe event, reduced to the fields billing uses. */
export type BillingEvent = {
  id: string;
  type: string;
  created: Date;
  data:
    | {
        kind: "checkout";
        mode: CheckoutMode | "setup";
        /** Our company id (`client_reference_id`, falling back to metadata). */
        companyRef: string | null;
        customerId: string | null;
        subscriptionId: string | null;
        /** `payment_status` is `paid` (or `no_payment_required`). */
        paid: boolean;
        metadata: Record<string, string>;
      }
    | {
        kind: "subscription";
        deleted: boolean;
        subscriptionId: string;
        customerId: string | null;
        companyRef: string | null;
        status: StripeSubscriptionStatus;
        /** Lookup key of the first item's price. */
        lookupKey: string | null;
        metadata: Record<string, string>;
        currentPeriodStart: Date | null;
        currentPeriodEnd: Date | null;
        cancelAtPeriodEnd: boolean;
      }
    | {
        kind: "invoice";
        paid: boolean;
        subscriptionId: string | null;
        customerId: string | null;
        companyRef: string | null;
      }
    | { kind: "other" };
};

export const PLAN_LOOKUP_PREFIX = "invai_plan_";
export const PACK_LOOKUP_PREFIX = "invai_pack_";
export const planLookupKey = (plan: string) => `${PLAN_LOOKUP_PREFIX}${plan}`;
export const packLookupKey = (pack: string) => `${PACK_LOOKUP_PREFIX}${pack}`;
