import { env } from "../../env";
import { mockDemandProvider, mockPricingProvider } from "./mock";
import { amazonPricingProvider } from "./providers/amazon-pricing";
import { censusDemandProvider } from "./providers/census";
import { googleTrendsDemandProvider } from "./providers/google-trends";
import { jungleScoutDemandProvider } from "./providers/jungle-scout";
import { pinterestDemandProvider } from "./providers/pinterest";
import { walmartPricingProvider } from "./providers/walmart-pricing";
import type { DemandProvider, PricingProvider, PricingScope } from "./types";

export * from "./http";
export { censusRetailSeries } from "./providers/census";
export * from "./types";

/*
 * Provider selection (research 14 §4.2), following the same shape as `carriers/index.ts`: real
 * only when the source's key is set, otherwise the deterministic mock -- the nightly demand
 * refresh (T-18-3) is global, so unlike carriers/suppliers there is no per-company check here.
 * A pricing provider for a sample workspace is always the mock, even with a key set (AC22),
 * because `marketPricingProvider` is per-company (it needs the tenant's own connection).
 */

/**
 * The demand providers this build knows about: Census (real client + fixture, AC2) and Google
 * Trends, Pinterest Trends and Jungle Scout (mock only today, AC1/AC4 -- no key is ever set in
 * this build). Real only when its own key is set; otherwise the deterministic mock, `mock: true`.
 *
 * Reviewer finding 1: Census is never the per-query hash mock. `censusDemandProvider()` already
 * picks the real client or the recorded fixture itself (`mock: env.mocks.census`), and either way
 * returns exactly the one NAICS-448 series it always has -- never 40 made-up series for 40
 * taxonomy queries labelled "public_dataset". The other three sources have no fixture, so they
 * fall back to the generic per-query mock when their key is unset.
 */
export function marketDemandProviders(): DemandProvider[] {
  return [
    censusDemandProvider(),
    env.mocks.googleTrends
      ? mockDemandProvider("google_trends", "official_api")
      : googleTrendsDemandProvider(),
    env.mocks.pinterest
      ? mockDemandProvider("pinterest_trends", "official_api")
      : pinterestDemandProvider(),
    env.mocks.jungleScout
      ? mockDemandProvider("jungle_scout", "licensed")
      : jungleScoutDemandProvider(),
  ];
}

/**
 * A pricing provider for the shop's own listings on `scope.channel` (AC3): only Amazon and
 * Walmart have a compliant comparables source (research 14 §1.1); every other channel (Etsy,
 * TikTok, Shopify) returns `null` -- the fence in `wave.md`. `null` also when the connection
 * isn't `connected` (spec: "active"). A sample workspace always gets the mock, whatever the
 * connection says (AC22); otherwise the connection's own `provider` field decides ("live" only
 * once a real SP-API/Walmart Marketplace pricing key is behind that channel connection, which
 * no connection in this system has yet -- decision 0006 defers the live Amazon/Walmart channel
 * adapters, so this always resolves to the mock today).
 */
export function marketPricingProvider(scope: PricingScope): PricingProvider | null {
  if (scope.channel !== "amazon" && scope.channel !== "walmart") return null;
  if (scope.connection?.status !== "connected") return null;

  const source = scope.channel === "amazon" ? "amazon_pricing" : "walmart_pricing";
  if (scope.sampleWorkspace || scope.connection.provider !== "live") {
    return mockPricingProvider(source, "official_api", scope.channel);
  }
  const conn = {
    id: scope.connection.id,
    companyId: scope.connection.companyId,
    channel: scope.channel,
    cursor: null,
  };
  return scope.channel === "amazon" ? amazonPricingProvider(conn) : walmartPricingProvider(conn);
}
