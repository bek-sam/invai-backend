import { describe, expect, it } from "vitest";
import { marketDemandProviders, marketPricingProvider } from "./index";

describe("marketDemandProviders (AC3: real only when the key is set)", () => {
  it("returns the four demand sources, all mock in this build (no key is ever set)", () => {
    const providers = marketDemandProviders();
    expect(providers.map((p) => p.source)).toEqual([
      "census",
      "google_trends",
      "pinterest_trends",
      "jungle_scout",
    ]);
    expect(providers.every((p) => p.mock)).toBe(true);
  });

  it("reviewer finding 1: census is the recorded fixture, never a per-query hash mock", async () => {
    const [census] = marketDemandProviders();
    // 40 taxonomy queries in, still exactly one NAICS-448 series out, on the fixture's own scale.
    const queries = Array.from({ length: 40 }, (_, i) => `taxonomy-query-${i}`);
    const series = await census?.series({ queries, granularity: "month", years: 3 });
    expect(series).toHaveLength(1);
    expect(series?.[0]?.query).toBe("naics_448_clothing_retail");
    expect(series?.[0]?.licence).toBe("public_dataset");
    expect(series?.[0]?.scale).toBe("absolute");
    expect(series?.[0]?.mock).toBe(true);

    // Calling it again with a completely different query list returns the identical fixture:
    // the fixture never varies by query, unlike the generic per-query mock other sources use.
    const again = await census?.series({
      queries: ["other query"],
      granularity: "month",
      years: 3,
    });
    expect(again?.[0]?.points).toEqual(series?.[0]?.points);
  });
});

describe("marketPricingProvider (AC3: Amazon/Walmart only, sample workspace always mock)", () => {
  const connected = {
    id: "c1",
    companyId: "co1",
    status: "connected" as const,
    provider: "mock" as const,
  };

  it("is null for Etsy, TikTok and Shopify (the fence)", () => {
    for (const channel of ["etsy", "tiktok", "shopify"] as const) {
      expect(
        marketPricingProvider({ sampleWorkspace: false, channel, connection: connected }),
      ).toBeNull();
    }
  });

  it("is null when there is no connection, or it isn't active", () => {
    expect(
      marketPricingProvider({ sampleWorkspace: false, channel: "amazon", connection: null }),
    ).toBeNull();
    expect(
      marketPricingProvider({
        sampleWorkspace: false,
        channel: "amazon",
        connection: { ...connected, status: "pending" },
      }),
    ).toBeNull();
  });

  it("is the mock for a sample workspace even when the connection is live (AC22)", () => {
    const provider = marketPricingProvider({
      sampleWorkspace: true,
      channel: "amazon",
      connection: { ...connected, provider: "live" },
    });
    expect(provider?.source).toBe("amazon_pricing");
    expect(provider?.mock).toBe(true);
  });

  it("is the mock for a real (non-sample) workspace whose connection isn't live yet", () => {
    const provider = marketPricingProvider({
      sampleWorkspace: false,
      channel: "walmart",
      connection: connected,
    });
    expect(provider?.source).toBe("walmart_pricing");
    expect(provider?.mock).toBe(true);
  });

  it("is the real adapter once the connection is live and not a sample workspace", () => {
    const provider = marketPricingProvider({
      sampleWorkspace: false,
      channel: "amazon",
      connection: { ...connected, provider: "live" },
    });
    expect(provider?.source).toBe("amazon_pricing");
    expect(provider?.mock).toBe(false);
  });
});
