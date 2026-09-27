import { fetchJsonWithPolicy } from "../http";
import type { Comparables, Connection, PriceObservation, PricingProvider } from "../types";

/*
 * Amazon SP-API Product Pricing, `getCompetitiveSummary` (research 14 §1.1).
 *   Docs: https://developer-docs.amazon/sp-api/reference/getcompetitivesummary
 *   Returns the featured buying options (Buy Box), lowest priced offers, reference prices and
 *   similar items for 1-20 ASINs per call. Rate limit: 0.033 req/s, burst 1, per selling
 *   partner (confirmed by research 14, cited against the live reference page).
 *   Auth: an SP-API Restricted Data Token / LWA access token per seller connection, sent as
 *   `x-amz-access-token`; role "Pricing" (non-restricted, no PII).
 * AUP §4.4/§4.6 (research 14 §1.1): pricing fetched for seller A about A's own ASINs, shown only
 * to A, is the documented repricer use -- never pooled across sellers. `comparables()` here is
 * per `conn` (one tenant's connection) for exactly that reason.
 * Never reachable in this build: the SP-API app approval (decision 0006) is pending, so no
 * connection can ever be `provider: "live"` for the amazon channel yet -- `marketPricingProvider`
 * (`index.ts`) never selects this adapter today.
 */

const BASE = "https://sellingpartnerapi-na.amazon.com";

type AmazonOffer = {
  LandedPrice?: { Amount?: number };
  IsFeaturedMerchant?: boolean;
  SellerId?: string;
};
type AmazonCompetitiveSummary = {
  Asin: string;
  FeaturedBuyingOptions?: AmazonOffer[];
  LowestPricedOffers?: { Offers?: AmazonOffer[] }[];
};
type AmazonResponse = { CompetitiveSummaries: AmazonCompetitiveSummary[] };

function toObservations(
  summary: AmazonCompetitiveSummary,
  garmentClass: string,
): PriceObservation[] {
  const offers = [
    ...(summary.FeaturedBuyingOptions ?? []),
    ...(summary.LowestPricedOffers ?? []).flatMap((g) => g.Offers ?? []),
  ];
  // Amazon's own offer objects carry `SellerId`: dropped here, never returned (AC7).
  // getCompetitiveSummary doesn't say whether a competing offer is a personalized listing or its
  // own garment class, so this skeleton (never selected in this build, decision 0006) sets
  // documented defaults: `personalized: false`, and `garmentClass` copied from the request's own
  // item (searchCatalogItems is expected to be scoped to the same garment class already, round
  // 2). Whoever wires a real key should look for a real per-offer signal for both before trusting
  // either.
  return offers.map((o) => ({
    landedPriceCents: Math.round((o.LandedPrice?.Amount ?? 0) * 100),
    isFeatured: !!o.IsFeaturedMerchant,
    offerCount: offers.length,
    personalized: false,
    garmentClass,
  }));
}

export function amazonPricingProvider(conn: Connection): PricingProvider {
  return {
    source: "amazon_pricing",
    mock: false,
    async comparables(_conn, own) {
      const asins = own.map((o) => o.ref).slice(0, 20); // getCompetitiveSummary takes 1-20 ASINs
      const garmentClassByRef = new Map(own.map((o) => [o.ref, o.garmentClass]));
      const res = await fetchJsonWithPolicy<AmazonResponse>({
        source: "amazon_pricing",
        url: `${BASE}/products/pricing/2022-05-01/items/competitiveSummary?asins=${asins.join(",")}&marketplaceId=ATVPDKIKX0DER`,
        // 0.033 req/s, burst 1, per selling partner (research 14 §1.1, confirmed live).
        rateLimit: { key: `market:amazon_pricing:${conn.id}`, capacity: 1, perMs: 30_000 },
      });
      const now = new Date().toISOString();
      const out: Comparables[] = res.CompetitiveSummaries.map((s) => ({
        source: "amazon_pricing",
        licence: "official_api",
        channel: "amazon",
        ownRef: s.Asin,
        observations: toObservations(s, garmentClassByRef.get(s.Asin) ?? "other"),
        asOf: now,
        fetchedAt: now,
        requestKey: `amazon_pricing:${conn.id}:${s.Asin}`,
        mock: false,
      }));
      return out;
    },
  };
}
