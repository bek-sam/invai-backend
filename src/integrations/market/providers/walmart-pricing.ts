import { fetchJsonWithPolicy } from "../http";
import type { Comparables, Connection, PriceObservation, PricingProvider } from "../types";

/*
 * Walmart Marketplace API, `POST /v3/price/getPricingInsights` (research 14 §1.1). Covers the
 * seller's own items: current price, Buy Box price, competitive price info. The exact response
 * field list came from a search-index snippet, not a rendered page (the doc page 404'd on
 * WebFetch, research 14) [3P]: confirm the live field names before this is ever pointed at a
 * real Walmart Solution Provider key.
 *   Docs: https://developer.walmart.com/us-marketplace/docs/get-pricing-insights-data-for-your-items
 *   Terms: developer.walmart.com/global-marketplace/docs/terms-and-conditions -- no aggregation
 *   or resale of "Walmart Confidential Information"; results here are per `conn` only.
 * Never reachable in this build: no Walmart Solution Provider app exists (research 14 §1.1,
 * "later"), so no connection can ever be `provider: "live"` for the walmart channel yet.
 */

const BASE = "https://marketplace.walmartapis.com";

type WalmartOffer = { price?: number; isBuyBoxWinner?: boolean; sellerId?: string };
type WalmartPricingInsight = { itemId: string; offers?: WalmartOffer[] };
type WalmartResponse = { items: WalmartPricingInsight[] };

function toObservations(item: WalmartPricingInsight): PriceObservation[] {
  const offers = item.offers ?? [];
  // Walmart's own offer objects carry `sellerId`: dropped here, never returned (AC7).
  return offers.map((o) => ({
    landedPriceCents: Math.round((o.price ?? 0) * 100),
    isFeatured: !!o.isBuyBoxWinner,
    offerCount: offers.length,
  }));
}

export function walmartPricingProvider(conn: Connection): PricingProvider {
  return {
    source: "walmart_pricing",
    mock: false,
    async comparables(_conn, own) {
      const res = await fetchJsonWithPolicy<WalmartResponse>({
        source: "walmart_pricing",
        url: `${BASE}/v3/price/getPricingInsights`,
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ itemIds: own.map((o) => o.ref) }),
        },
        // No published per-seller rate documented [U]: a conservative default until confirmed.
        rateLimit: { key: `market:walmart_pricing:${conn.id}`, capacity: 5, perMs: 60_000 },
      });
      const now = new Date().toISOString();
      const out: Comparables[] = res.items.map((item) => ({
        source: "walmart_pricing",
        licence: "official_api",
        channel: "walmart",
        ownRef: item.itemId,
        observations: toObservations(item),
        asOf: now,
        fetchedAt: now,
        requestKey: `walmart_pricing:${conn.id}:${item.itemId}`,
        mock: false,
      }));
      return out;
    },
  };
}
