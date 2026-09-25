import { env } from "../../env";
import { type CompanyScope, isSampleWorkspace } from "../../modules/tenancy/demo-flag";
import { mockBillingProvider } from "./mock";
import { createStripeProvider } from "./stripe";
import type { BillingProvider } from "./types";

export * from "./types";
export { MOCK_STRIPE_WEBHOOK_SECRET, signStripeWebhook, verifyStripeWebhook } from "./webhook";

let live: BillingProvider | null = null;

/**
 * Stripe when STRIPE_SECRET_KEY is set, otherwise the mock (local URLs, no network). A sample
 * workspace (tenancy.demo) always gets the mock; billing's service also refuses real-money
 * actions there with DEMO_MODE before it gets this far.
 */
export async function billingProvider(scope: CompanyScope): Promise<BillingProvider> {
  if (env.mocks.billing || !env.STRIPE_SECRET_KEY) return mockBillingProvider;
  if (await isSampleWorkspace(scope.companyId)) return mockBillingProvider;
  live ??= createStripeProvider(env.STRIPE_SECRET_KEY);
  return live;
}
