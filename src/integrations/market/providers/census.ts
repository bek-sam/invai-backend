import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { env } from "../../../env";
import { logger } from "../../../lib/log";
import { fetchJsonWithPolicy } from "../http";
import type { DemandSeries, SeriesPoint } from "../types";

/*
 * US Census Bureau Monthly Retail Trade (MARTS), Economic Indicator Time Series (EITS) API
 * (research 14 §1.2, "now": free, public, no scraping, own-signal-adjacent macro context).
 *   Docs:    https://www.census.gov/retail/  and the EITS API guide,
 *            https://www2.census.gov/data/api-documentation/EITS_API_User_Guide_Dec2020.pdf
 *   Variables (confirmed live, keyless, 2026-09-27):
 *            GET https://api.census.gov/data/timeseries/eits/marts/variables.json
 *   Endpoint (AC2, keyless GET attempted 2026-09-27 against the live data endpoint; it answered
 *            "Missing Key" -- a key is required even to read this public dataset, so the real
 *            call below is untested against a live key. This card never buys or uses one):
 *            GET https://api.census.gov/data/timeseries/eits/marts
 *                ?get=cell_value,data_type_code,category_code,seasonally_adj,error_data,time
 *                &for=us:*&category_code=448&data_type_code=SM&seasonally_adj=no
 *                &time=from+YYYY&key=<CENSUS_API_KEY>
 *   Response shape (every Census data/timeseries endpoint, confirmed live for other Census
 *            datasets): a JSON array of arrays -- a header row of column names, then one row per
 *            (time, geography) observation, all values as strings.
 *   category_code "448" = NAICS 448 (clothing and clothing accessories stores); data_type_code
 *            "SM" = sales, monthly [U: the variables list confirms the field exists and is
 *            required, but its code list wasn't readable without a key -- verify "SM" against a
 *            live key before this ever runs for real, per `provider-deprecation-watch`].
 * NSA (`seasonally_adj=no`): the module wants the raw seasonal shape, not one Census already
 * removed.
 */

const log = logger("market.census");
const BASE = "https://api.census.gov/data/timeseries/eits/marts";
const CATEGORY_CODE = "448";
const DATA_TYPE_CODE = "SM";

type CensusRow = [
  cellValue: string,
  dataTypeCode: string,
  categoryCode: string,
  seasonallyAdj: string,
  errorData: string,
  time: string,
  us: string,
];
type CensusResponse = [header: string[], ...rows: CensusRow[]];

/**
 * The fixture recorded for AC2: a keyless GET against the live endpoint on 2026-09-27 answered
 * "Missing Key" (Census requires a key even for this public dataset), so this fixture is built
 * from the documented response shape above, not copied from a real answer -- flagged here and in
 * the card report rather than presented as real Census numbers.
 */
const FIXTURE_PATH = fileURLToPath(
  new URL("../fixtures/census-marts-448-monthly.json", import.meta.url),
);

function rowsToPoints(rows: CensusRow[]): SeriesPoint[] {
  return rows
    .map((r) => ({ period: r[5], value: Number(r[0]) }))
    .sort((a, b) => (a.period < b.period ? -1 : a.period > b.period ? 1 : 0));
}

function readFixture(): CensusResponse {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as CensusResponse;
}

/** Real call, only reached when `CENSUS_API_KEY` is set (never in this card's tests). */
async function fetchLive(years: number): Promise<CensusRow[]> {
  const fromYear = new Date().getUTCFullYear() - years;
  const url =
    `${BASE}?get=cell_value,data_type_code,category_code,seasonally_adj,error_data,time` +
    `&for=us:*&category_code=${CATEGORY_CODE}&data_type_code=${DATA_TYPE_CODE}&seasonally_adj=no` +
    `&time=from+${fromYear}&key=${env.CENSUS_API_KEY}`;
  const [, ...rows] = await fetchJsonWithPolicy<CensusResponse>({
    source: "census",
    url,
    rateLimit: { key: "market:census", capacity: 5, perMs: 60_000 },
  });
  return rows;
}

/**
 * NAICS 448 (clothing and clothing accessories stores) monthly retail sales, not seasonally
 * adjusted, for the last `years` years (AC2). Real Census client when `CENSUS_API_KEY` is set;
 * otherwise the recorded/documented fixture, both `mock` flagged correctly.
 */
export async function censusRetailSeries({ years }: { years: number }): Promise<DemandSeries> {
  const mock = env.mocks.census;
  const rows = mock ? (readFixture().slice(1) as CensusRow[]) : await fetchLive(years);
  const allPoints = rowsToPoints(rows);
  const wantedMonths = years * 12;
  const points = allPoints.slice(-wantedMonths);
  const now = new Date().toISOString();
  if (mock) log.debug("census series from fixture (no CENSUS_API_KEY)", { points: points.length });
  return {
    source: "census",
    licence: "public_dataset",
    query: "naics_448_clothing_retail",
    geo: "US",
    granularity: "month",
    scale: "absolute",
    points,
    asOf: points.at(-1)?.period ?? now,
    fetchedAt: now,
    requestKey: `census:naics448:${years}`,
    mock,
  };
}

/** One `DemandProvider` wrapping `censusRetailSeries` (source is fixed, so `queries` is ignored). */
export function censusDemandProvider() {
  return {
    source: "census" as const,
    mock: env.mocks.census,
    async series({ years }: { queries: string[]; granularity: "week" | "month"; years: number }) {
      return [await censusRetailSeries({ years })];
    },
  };
}
