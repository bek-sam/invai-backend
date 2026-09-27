import { UnrecoverableError } from "bullmq";
import { afterEach, describe, expect, it, vi } from "vitest";
import { amazonPricingProvider } from "./amazon-pricing";
import { googleTrendsDemandProvider } from "./google-trends";
import { jungleScoutDemandProvider } from "./jungle-scout";
import { pinterestDemandProvider } from "./pinterest";
import { walmartPricingProvider } from "./walmart-pricing";

/*
 * AC4: the real adapters are skeletons never selected in this build (no key exists), but each
 * goes through the shared `fetchJsonWithPolicy` (`../http.ts`), so a 401/403 from the provider
 * must fail the job for good, not retry. Proven here with a stubbed `fetch`.
 */

const respond = (status: number, body: unknown = {}) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));

// A fresh id per call: the real rate limiter buckets on `market:<source>:<connId>`, so reusing
// one id across tests would make a later test wait out an earlier test's token (capacity 1).
const newConn = () => ({
  id: crypto.randomUUID(),
  companyId: "company-1",
  channel: "amazon" as const,
  cursor: null,
});

describe("real market adapters: 401/403 -> UnrecoverableError", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("Google Trends", async () => {
    vi.stubGlobal("fetch", respond(401));
    await expect(
      googleTrendsDemandProvider().series({ queries: ["a"], granularity: "month", years: 1 }),
    ).rejects.toThrow(UnrecoverableError);
  });

  it("Pinterest Trends", async () => {
    vi.stubGlobal("fetch", respond(403));
    await expect(
      pinterestDemandProvider().series({ queries: ["a"], granularity: "week", years: 1 }),
    ).rejects.toThrow(UnrecoverableError);
  });

  it("Jungle Scout", async () => {
    vi.stubGlobal("fetch", respond(401));
    await expect(
      jungleScoutDemandProvider().series({ queries: ["a"], granularity: "month", years: 1 }),
    ).rejects.toThrow(UnrecoverableError);
  });

  it("Amazon pricing", async () => {
    vi.stubGlobal("fetch", respond(403));
    const c = newConn();
    await expect(
      amazonPricingProvider(c).comparables(c, [
        { ref: "ASIN1", keywords: ["a"], garmentClass: "t-shirt" },
      ]),
    ).rejects.toThrow(UnrecoverableError);
  });

  it("Walmart pricing", async () => {
    vi.stubGlobal("fetch", respond(401));
    const c = newConn();
    await expect(
      walmartPricingProvider(c).comparables(c, [
        { ref: "ITEM1", keywords: ["a"], garmentClass: "t-shirt" },
      ]),
    ).rejects.toThrow(UnrecoverableError);
  });
});

describe("real market adapters: successful parse drops seller identity (AC7)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("Amazon pricing keeps only price, featured flag and offer count", async () => {
    vi.stubGlobal(
      "fetch",
      respond(200, {
        CompetitiveSummaries: [
          {
            Asin: "ASIN1",
            FeaturedBuyingOptions: [
              { LandedPrice: { Amount: 19.99 }, IsFeaturedMerchant: true, SellerId: "A_SELLER_1" },
            ],
            LowestPricedOffers: [
              {
                Offers: [
                  {
                    LandedPrice: { Amount: 17.5 },
                    IsFeaturedMerchant: false,
                    SellerId: "A_SELLER_2",
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    const c = newConn();
    const [comparables] = await amazonPricingProvider(c).comparables(c, [
      { ref: "ASIN1", keywords: ["a"], garmentClass: "t-shirt" },
    ]);
    expect(comparables?.ownRef).toBe("ASIN1");
    const asText = JSON.stringify(comparables);
    expect(asText).not.toContain("A_SELLER_1");
    expect(asText).not.toContain("A_SELLER_2");
    for (const obs of comparables?.observations ?? []) {
      expect(Object.keys(obs).sort()).toEqual(
        ["isFeatured", "landedPriceCents", "offerCount"].sort(),
      );
    }
  });

  it("Walmart pricing keeps only price, featured flag and offer count", async () => {
    vi.stubGlobal(
      "fetch",
      respond(200, {
        items: [
          {
            itemId: "ITEM1",
            offers: [{ price: 22.0, isBuyBoxWinner: true, sellerId: "W_SELLER_1" }],
          },
        ],
      }),
    );
    const c = newConn();
    const [comparables] = await walmartPricingProvider(c).comparables(c, [
      { ref: "ITEM1", keywords: ["a"], garmentClass: "t-shirt" },
    ]);
    const asText = JSON.stringify(comparables);
    expect(asText).not.toContain("W_SELLER_1");
    expect(comparables?.observations[0]).toEqual({
      landedPriceCents: 2200,
      isFeatured: true,
      offerCount: 1,
    });
  });
});
