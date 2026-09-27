import { env } from "../../../env";
import { fetchJsonWithPolicy } from "../http";
import { seriesAsOf } from "../period";
import type { DemandProvider, DemandSeries, SeriesPoint } from "../types";

/*
 * Google Trends API (alpha) (research 14 §1.2). Docs: https://developers.google.com/search/apis/trends
 * (announced https://developers.google.com/search/blog/2025/07/trends-api). The doc page
 * confirms: a rolling window of the last 5 years, daily/weekly/monthly/yearly aggregation,
 * region and sub-region comparison, and values on a "consistently scaled" (not 0-100) axis so
 * pulls can be joined over time. It does NOT publish the REST base URL, path, auth header or
 * response JSON shape (checked live 2026-09-27: the page is a signup form, not a reference) --
 * access is application-gated and those details arrive only on approval [U]. This skeleton is
 * therefore never reachable: `GOOGLE_TRENDS_API_KEY` has no real value anywhere, and applying
 * for alpha access is an outbound submission the owner decides (research 14 §5.2). Confirm the
 * real endpoint and field names against the alpha docs before ever setting the key.
 */

const PLACEHOLDER_BASE = "https://trends.googleapis.com/v1alpha1";

type GoogleTrendsPoint = { time: string; value: number };
type GoogleTrendsResponse = { query: string; points: GoogleTrendsPoint[] };

async function fetchOne(
  query: string,
  granularity: "week" | "month",
  years: number,
): Promise<DemandSeries> {
  const res = await fetchJsonWithPolicy<GoogleTrendsResponse>({
    source: "google_trends",
    url: `${PLACEHOLDER_BASE}/query?terms=${encodeURIComponent(query)}&years=${years}&granularity=${granularity}&key=${env.GOOGLE_TRENDS_API_KEY}`,
    // No published quota (research 14 §4.2, "[U]"): one request every 5s until confirmed.
    // Reviewer finding 2: the bucket is a constant, never the key itself -- a key must not end up
    // in a Redis key, a BullMQ failedReason or a log line (`market:census`/`market:jungle_scout`
    // already did this; this fixes the two that didn't).
    rateLimit: { key: "market:google_trends", capacity: 1, perMs: 5_000 },
  });
  const points: SeriesPoint[] = res.points.map((p) => ({ period: p.time, value: p.value }));
  const now = new Date().toISOString();
  return {
    source: "google_trends",
    licence: "official_api",
    query,
    geo: "US",
    granularity,
    scale: "consistent_scaled",
    points,
    asOf: seriesAsOf(points, granularity, now),
    fetchedAt: now,
    requestKey: `google_trends:${query}:${granularity}:${years}`,
    mock: false,
  };
}

export function googleTrendsDemandProvider(): DemandProvider {
  return {
    source: "google_trends",
    mock: false,
    async series({ queries, granularity, years }) {
      const out: DemandSeries[] = [];
      for (const query of queries) out.push(await fetchOne(query, granularity, years));
      return out;
    },
  };
}
