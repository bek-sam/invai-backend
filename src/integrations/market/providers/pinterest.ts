import { env } from "../../../env";
import { fetchJsonWithPolicy } from "../http";
import type { DemandProvider, DemandSeries, SeriesPoint } from "../types";

/*
 * Pinterest API v5: Trends (research 14 §1.2).
 *   Docs: https://developers.pinterest.com/docs/api/v5/trending_keywords-list/
 *   Endpoint: GET /trends/keywords/{region}/top/{trend_type}, Bearer OAuth (Pinterest API v5
 *             convention). `include_keywords` lets a caller ask about specific keywords instead
 *             of only the top-N list [U: the reference page needs a signed-in session to render,
 *             so this wasn't independently confirmed on 2026-09-27 -- check before ever setting
 *             a real key].
 *   Response fields (confirmed live on GitHub, 2026-09-27, the generated API client's model
 *             docs): `TrendingKeywordsResponse.trends[]`, each a `TrendingKeywordsResponseTrends`
 *             with `keyword`, `pct_growth_wow`/`pct_growth_mom`/`pct_growth_yoy` (int, capped
 *             +/-10000%), and `time_series: { [isoDate: string]: number }` -- "weekly observations
 *             of relative search volume ... over the past year", normalized 0-100.
 * Never reachable in this build: no Pinterest developer app exists (research 14 §1.2, "later":
 * an outbound application the owner decides).
 */

type PinterestTrend = {
  keyword: string;
  time_series?: Record<string, number>;
};
type PinterestTrendingKeywordsResponse = { trends: PinterestTrend[] };

async function fetchOne(
  query: string,
  granularity: "week" | "month",
  years: number,
): Promise<DemandSeries> {
  const res = await fetchJsonWithPolicy<PinterestTrendingKeywordsResponse>({
    source: "pinterest_trends",
    url: `https://api.pinterest.com/v5/trends/keywords/US/top/growing?include_keywords=${encodeURIComponent(query)}`,
    init: { headers: { authorization: `Bearer ${env.PINTEREST_API_KEY}` } },
    // No published per-app quota (research 14 §1.2, "[U]"): one request per 2s until confirmed.
    rateLimit: {
      key: `market:pinterest_trends:${env.PINTEREST_API_KEY}`,
      capacity: 1,
      perMs: 2_000,
    },
  });
  const match = res.trends.find((t) => t.keyword === query) ?? res.trends[0];
  const series = match?.time_series ?? {};
  const points: SeriesPoint[] = Object.entries(series)
    .map(([period, value]) => ({ period, value }))
    .sort((a, b) => (a.period < b.period ? -1 : 1));
  const now = new Date().toISOString();
  return {
    source: "pinterest_trends",
    licence: "official_api",
    query,
    geo: "US",
    granularity,
    scale: "relative_0_100",
    points,
    asOf: points.at(-1)?.period ?? now,
    fetchedAt: now,
    requestKey: `pinterest_trends:${query}:${granularity}:${years}`,
    mock: false,
  };
}

export function pinterestDemandProvider(): DemandProvider {
  return {
    source: "pinterest_trends",
    mock: false,
    async series({ queries, granularity, years }) {
      const out: DemandSeries[] = [];
      for (const query of queries) out.push(await fetchOne(query, granularity, years));
      return out;
    },
  };
}
