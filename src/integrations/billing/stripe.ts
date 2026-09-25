import Stripe from "stripe";
import { upstream } from "../../lib/errors";
import { errorData, logger } from "../../lib/log";
import type { BillingProvider, CheckoutRequest } from "./types";

const log = logger("billing.stripe");

/** Every Stripe call gives up after this; the SDK retries network failures twice (with its own idempotency key). */
export const STRIPE_TIMEOUT_MS = 10_000;

function fail(action: string, err: unknown): never {
  log.warn(`stripe ${action} failed`, errorData(err));
  const detail = err instanceof Stripe.errors.StripeError ? err.message : null;
  throw upstream("Stripe", detail);
}

/**
 * The live Stripe provider. `fetch` is injectable so tests can run the real SDK against a
 * fetch mock (no network, no keys).
 */
export function createStripeProvider(
  secretKey: string,
  opts: { fetch?: typeof fetch } = {},
): BillingProvider {
  const stripe = new Stripe(secretKey, {
    timeout: STRIPE_TIMEOUT_MS,
    maxNetworkRetries: 2,
    ...(opts.fetch ? { httpClient: Stripe.createFetchHttpClient(opts.fetch) } : {}),
  });

  async function priceId(lookupKey: string): Promise<string> {
    const prices = await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
    const price = prices.data[0];
    if (!price) throw upstream("Stripe", `no active price with lookup key ${lookupKey}`);
    return price.id;
  }

  return {
    kind: "live",

    async createCheckout(req: CheckoutRequest) {
      try {
        const price = await priceId(req.lookupKey);
        const session = await stripe.checkout.sessions.create({
          mode: req.mode,
          line_items: [{ price, quantity: 1 }],
          client_reference_id: req.companyId,
          ...(req.customerId
            ? { customer: req.customerId }
            : req.mode === "payment"
              ? { customer_creation: "always" as const }
              : {}),
          metadata: req.metadata,
          ...(req.mode === "subscription" ? { subscription_data: { metadata: req.metadata } } : {}),
          success_url: req.successUrl,
          cancel_url: req.cancelUrl,
        });
        if (!session.url) throw upstream("Stripe", "checkout session has no URL");
        return { id: session.id, url: session.url };
      } catch (err) {
        if (err instanceof Stripe.errors.StripeError) fail("checkout", err);
        throw err;
      }
    },

    async createPortal({ customerId, returnUrl }) {
      try {
        const session = await stripe.billingPortal.sessions.create({
          customer: customerId,
          return_url: returnUrl,
        });
        return { url: session.url };
      } catch (err) {
        fail("portal", err);
      }
    },

    async cancelAtPeriodEnd(subscriptionId) {
      try {
        await stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true });
      } catch (err) {
        fail("cancel at period end", err);
      }
    },
  };
}
