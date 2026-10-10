import { afterEach, describe, expect, it } from "vitest";
import type { MarketDeps } from "./deps";
import { setMarketDeps } from "./deps";
import { refreshDemand } from "./jobs";

/* B-353/B-354: a failed market source is reported as a fixed sentence, never the provider's text. */

afterEach(() => setMarketDeps({}));

describe("market refresh errors", () => {
  it("a failing demand source returns a fixed sentence with a code, not its message", async () => {
    const boom = {
      source: "probe_source",
      series: async () => {
        throw new Error("403 from upstream for maria.perez@example.com, 4410 Mesquite Lane");
      },
    };
    setMarketDeps({
      marketDemandProviders: (() => [boom]) as unknown as MarketDeps["marketDemandProviders"],
    });
    const out = await refreshDemand(new Date("2027-03-01T00:00:00Z"));
    const failed = out.sources.find((o) => o.source === "probe_source");
    expect(failed?.failed).toBe("A market data source did not answer (source_failed)");
    expect(JSON.stringify(out)).not.toContain("Mesquite");
  });
});
