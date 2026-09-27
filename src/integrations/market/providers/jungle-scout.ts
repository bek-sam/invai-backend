import { env } from "../../../env";
import { fetchJsonWithPolicy } from "../http";
import type { DemandProvider, DemandSeries, SeriesPoint } from "../types";

/*
 * Jungle Scout API (research 14 §1.3, "later": its terms need a written data-resale licence
 * before InvAI can show its data to tenants, so this never runs live without the owner and
 * counsel).
 *   Docs: https://developer.junglescout.com/api (confirmed live, 2026-09-27):
 *   Base URL: https://developer.junglescout.com
 *   Auth headers: `Authorization: <key name>:<api key>`, `X-API-Type: junglescout`,
 *     `Accept: application/vnd.junglescout.v1+json`
 *   Query: `marketplace` (required, e.g. "us")
 *   Response shape: JSON:API -- `{ data: { type, id, attributes }, meta, links }`
 *   Rate limit: 300 requests/minute or 15 requests/second per account (confirmed live).
 *   Historical-search-volume-by-keyword resource path wasn't independently confirmed (the doc
 *   fetch on 2026-09-27 surfaced `POST /api/product_database_query` for product search, not the
 *   keyword-history endpoint); read the full Postman collection (postman.junglescout.com) and
 *   confirm the exact resource name before this is ever pointed at a real, licensed key [U].
 */

const BASE = "https://developer.junglescout.com";

type JungleScoutAttributes = {
  keyword: string;
  monthly_search_volume_history?: Record<string, number>;
};
type JungleScoutResponse = { data: { attributes: JungleScoutAttributes }[] };

async function fetchOne(
  query: string,
  granularity: "week" | "month",
  years: number,
): Promise<DemandSeries> {
  const res = await fetchJsonWithPolicy<JungleScoutResponse>({
    source: "jungle_scout",
    url: `${BASE}/api/keywords_by_keyword_query?marketplace=us&keyword=${encodeURIComponent(query)}`,
    init: {
      headers: {
        authorization: env.JUNGLE_SCOUT_API_KEY ?? "",
        "x-api-type": "junglescout",
        accept: "application/vnd.junglescout.v1+json",
      },
    },
    rateLimit: { key: "market:jungle_scout", capacity: 15, perMs: 1_000 },
  });
  const history = res.data[0]?.attributes.monthly_search_volume_history ?? {};
  const points: SeriesPoint[] = Object.entries(history)
    .map(([period, value]) => ({ period, value }))
    .sort((a, b) => (a.period < b.period ? -1 : 1));
  const now = new Date().toISOString();
  return {
    source: "jungle_scout",
    licence: "licensed",
    query,
    geo: "US",
    granularity,
    scale: "absolute",
    points,
    asOf: points.at(-1)?.period ?? now,
    fetchedAt: now,
    requestKey: `jungle_scout:${query}:${granularity}:${years}`,
    mock: false,
  };
}

export function jungleScoutDemandProvider(): DemandProvider {
  return {
    source: "jungle_scout",
    mock: false,
    async series({ queries, granularity, years }) {
      const out: DemandSeries[] = [];
      for (const query of queries) out.push(await fetchOne(query, granularity, years));
      return out;
    },
  };
}
