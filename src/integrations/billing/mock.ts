import { env } from "../../env";
import type { BillingProvider } from "./types";

/**
 * Mock Stripe: no network, deterministic local URLs back to the web billing page. A mock
 * checkout never changes the plan (with mock Stripe, `billing.changePlan` does that directly);
 * signed test webhooks still work, with `MOCK_STRIPE_WEBHOOK_SECRET` outside production.
 */
export const mockBillingProvider: BillingProvider = {
  kind: "mock",
  async createCheckout(req) {
    const id = `cs_mock_${req.mode}_${req.lookupKey}`;
    const url = new URL("/settings/billing", env.WEB_ORIGIN);
    url.searchParams.set("checkout", "success");
    url.searchParams.set("mock", "1");
    url.searchParams.set("session", id);
    return { id, url: url.toString() };
  },
  async createPortal() {
    const url = new URL("/settings/billing", env.WEB_ORIGIN);
    url.searchParams.set("portal", "mock");
    return { url: url.toString() };
  },
  async cancelAtPeriodEnd() {},
};
