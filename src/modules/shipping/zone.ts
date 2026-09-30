/*
 * Carrier zone (1-9) from origin and destination ZIP3, for shipping-margin analytics (T-A4,
 * AC-A4). Pure: the caller passes the ZIPs it already holds in memory for the label, and only the
 * zone number is stored (`shipments.dest_zone`); no ZIP, address or name is kept for analytics.
 *
 * USPS zones are distance bands between the origin and destination sectional centers (ZIP3):
 * 1 up to 50 miles, 2 up to 150, 3 up to 300, 4 up to 600, 5 up to 1,000, 6 up to 1,400,
 * 7 up to 1,800, 8 beyond. Zone 9 is the Pacific territories and freely associated states
 * (ZIP3 969). This uses regional ZIP3 centroids, not the full USPS zone chart, so a pair near a
 * band edge can read one zone off; that is fine for grouping margin by zone, never for pricing.
 */

/** [first ZIP3, last ZIP3, latitude, longitude] of each region, ascending. */
const REGIONS: readonly (readonly [number, number, number, number])[] = [
  [5, 5, 40.8, -73.0], // Holtsville NY
  [6, 9, 18.2, -66.5], // Puerto Rico, Virgin Islands
  [10, 13, 42.2, -72.6], // western MA
  [14, 27, 42.3, -71.5], // eastern MA
  [28, 29, 41.7, -71.5], // RI
  [30, 38, 43.2, -71.5], // NH
  [39, 49, 44.5, -69.5], // ME
  [50, 59, 44.2, -72.7], // VT
  [60, 69, 41.6, -72.7], // CT
  [70, 89, 40.3, -74.5], // NJ
  [100, 104, 40.75, -73.95], // New York City
  [105, 109, 41.1, -73.9], // Hudson Valley
  [110, 119, 40.75, -73.5], // Long Island, Queens
  [120, 129, 42.7, -73.8], // Albany
  [130, 139, 43.0, -75.9], // Syracuse, Utica
  [140, 149, 42.9, -78.2], // Buffalo, Rochester
  [150, 165, 40.8, -79.9], // western PA
  [166, 179, 40.6, -77.4], // central PA
  [180, 196, 40.3, -75.6], // eastern PA
  [197, 199, 39.4, -75.6], // DE
  [200, 205, 38.9, -77.0], // DC
  [206, 219, 39.1, -76.8], // MD
  [220, 229, 38.6, -77.6], // northern VA
  [230, 239, 37.3, -76.8], // Richmond, Tidewater
  [240, 246, 37.1, -80.2], // southwestern VA
  [247, 268, 38.6, -80.8], // WV
  [270, 279, 35.8, -79.0], // central and eastern NC
  [280, 289, 35.4, -81.5], // western NC
  [290, 299, 33.9, -80.9], // SC
  [300, 312, 33.8, -84.2], // northern GA, Atlanta
  [313, 319, 31.5, -82.8], // southern GA
  [320, 322, 30.2, -82.5], // Jacksonville
  [323, 324, 30.4, -85.5], // Tallahassee, Panhandle
  [325, 325, 30.6, -87.2], // Pensacola
  [326, 329, 28.7, -81.6], // central FL
  [330, 334, 26.3, -80.3], // southeast FL
  [335, 339, 27.6, -82.3], // Tampa, southwest FL
  [341, 349, 27.5, -81.8], // FL (other)
  [350, 369, 33.0, -86.8], // AL
  [370, 375, 35.8, -86.4], // Nashville, Chattanooga
  [376, 379, 36.1, -83.5], // Knoxville
  [380, 385, 35.4, -89.0], // Memphis, western TN
  [386, 397, 32.7, -89.7], // MS
  [398, 399, 31.6, -84.2], // southwest GA
  [400, 418, 37.8, -85.0], // KY
  [420, 427, 37.0, -87.8], // western KY
  [430, 433, 40.0, -83.0], // Columbus
  [434, 436, 41.5, -83.6], // Toledo
  [437, 438, 39.8, -81.9], // southeast OH
  [439, 449, 41.1, -81.3], // Cleveland, Akron
  [450, 459, 39.5, -84.3], // Cincinnati, Dayton
  [460, 469, 40.3, -86.2], // central and northern IN
  [470, 479, 38.8, -86.3], // southern IN
  [480, 489, 42.6, -83.5], // Detroit, Flint
  [490, 497, 43.3, -85.4], // western MI
  [498, 499, 46.4, -87.4], // Upper Peninsula
  [500, 528, 41.9, -93.4], // IA
  [530, 537, 43.0, -88.5], // Milwaukee, Madison
  [538, 549, 44.5, -89.6], // northern WI
  [550, 554, 45.0, -93.3], // Minneapolis, St Paul
  [555, 567, 45.8, -94.8], // MN (other)
  [568, 569, 38.9, -77.0], // DC (government)
  [570, 577, 44.4, -100.2], // SD
  [578, 588, 47.4, -100.5], // ND
  [589, 599, 46.9, -110.4], // MT
  [600, 609, 41.9, -87.9], // Chicago
  [610, 619, 41.0, -89.3], // northern and central IL
  [620, 629, 38.6, -89.5], // southern IL
  [630, 639, 38.4, -90.8], // St Louis, eastern MO
  [640, 659, 38.3, -93.5], // Kansas City, western MO
  [660, 669, 38.8, -95.5], // eastern KS
  [670, 679, 37.9, -98.5], // Wichita, western KS
  [680, 682, 41.2, -96.1], // Omaha
  [683, 699, 41.2, -99.0], // NE (other)
  [700, 715, 30.8, -91.8], // LA
  [716, 729, 34.9, -92.4], // AR
  [730, 749, 35.6, -97.4], // OK
  [750, 759, 32.8, -96.6], // Dallas, northeast TX
  [760, 769, 32.8, -97.8], // Fort Worth, north TX
  [770, 779, 29.8, -95.4], // Houston
  [780, 789, 29.6, -98.3], // San Antonio, Austin
  [790, 797, 33.0, -101.8], // Lubbock, Amarillo, Midland
  [798, 799, 31.8, -106.4], // El Paso
  [800, 816, 39.4, -105.2], // CO
  [817, 831, 42.9, -107.5], // WY
  [832, 838, 43.8, -115.0], // ID
  [839, 847, 40.4, -111.8], // UT
  [848, 853, 33.5, -112.0], // Phoenix
  [854, 857, 32.3, -110.9], // Tucson
  [858, 865, 35.1, -111.7], // northern AZ
  [866, 884, 34.8, -106.3], // NM
  [885, 885, 31.8, -106.4], // El Paso
  [886, 891, 36.1, -115.1], // Las Vegas
  [892, 899, 39.5, -119.0], // Reno, northern NV
  [900, 918, 34.1, -118.2], // Los Angeles
  [919, 921, 32.8, -117.0], // San Diego
  [922, 925, 33.9, -116.8], // Inland Empire
  [926, 928, 33.7, -117.8], // Orange County
  [929, 935, 35.0, -119.3], // Bakersfield, central coast
  [936, 938, 36.7, -119.8], // Fresno
  [939, 951, 37.5, -122.0], // Bay Area
  [952, 953, 37.8, -121.1], // Stockton, Modesto
  [954, 955, 39.5, -123.3], // north coast CA
  [956, 958, 38.6, -121.3], // Sacramento
  [959, 961, 40.2, -121.7], // northern CA
  [967, 968, 21.3, -157.9], // HI
  [970, 973, 45.3, -122.8], // Portland, Salem
  [974, 979, 43.2, -121.5], // OR (other)
  [980, 986, 47.4, -122.3], // western WA
  [987, 994, 47.3, -119.5], // eastern WA
  [995, 999, 61.2, -149.9], // AK
];

/** Pacific territories and freely associated states: always zone 9 (unless both ends are there). */
const PACIFIC_TERRITORY = 969;

/** Military (APO/FPO: AE 090-098, AA 340, AP 962-966) has no distance zone. */
const isMilitary = (z: number) => (z >= 90 && z <= 98) || z === 340 || (z >= 962 && z <= 966);

const BANDS_MILES = [50, 150, 300, 600, 1000, 1400, 1800] as const;

/** First three digits of a US ZIP ("85003" or "85003-1234"); null for anything else. */
export function zip3Of(zip: string | null | undefined): string | null {
  const m = /^(\d{3})\d{2}(-\d{4})?$/.exec((zip ?? "").trim());
  return m?.[1] ?? null;
}

function region(zip3: number) {
  for (const [lo, hi, lat, lon] of REGIONS) {
    if (zip3 < lo) return null;
    if (zip3 <= hi) return { lat, lon };
  }
  return null;
}

function miles(a: { lat: number; lon: number }, b: { lat: number; lon: number }) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 3958.8 * Math.asin(Math.sqrt(h));
}

/** Zone 1-9 between two ZIP3s ("850", "100"); null when either is unknown or military. */
export function zoneForZip3(origin: string, dest: string): number | null {
  if (!/^\d{3}$/.test(origin) || !/^\d{3}$/.test(dest)) return null;
  const o = Number(origin);
  const d = Number(dest);
  if (isMilitary(o) || isMilitary(d)) return null;
  if (o === d) return 1;
  if (o === PACIFIC_TERRITORY || d === PACIFIC_TERRITORY) return 9;
  const a = region(o);
  const b = region(d);
  if (!a || !b) return null;
  const dist = miles(a, b);
  const band = BANDS_MILES.findIndex((max) => dist <= max);
  return band === -1 ? 8 : band + 1;
}

/** Zone from two full ZIPs (only their first three digits are used); null if either is invalid. */
export function zoneForZips(
  originZip: string | null | undefined,
  destZip: string | null | undefined,
): number | null {
  const o = zip3Of(originZip);
  const d = zip3Of(destZip);
  return o && d ? zoneForZip3(o, d) : null;
}
