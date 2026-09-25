import { env } from "../../env";
import { mockBillingProvider } from "./mock";
import { createStripeProvider } from "./stripe";
import type { BillingProvider } from "./types";

export * from "./types";
export { MOCK_STRIPE_WEBHOOK_SECRET, signStripeWebhook, verifyStripeWebhook } from "./webhook";

let live: BillingProvider | null = null;

/** Stripe when STRIPE_SECRET_KEY is set, otherwise the mock (local URLs, no network). */
export function billingProvider(): BillingProvider {
  if (env.mocks.billing || !env.STRIPE_SECRET_KEY) return mockBillingProvider;
  live ??= createStripeProvider(env.STRIPE_SECRET_KEY);
  return live;
}
