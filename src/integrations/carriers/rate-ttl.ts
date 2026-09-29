import type { CarrierCode } from "./types";

/*
 * How long a rate quote may be bought (B-25). A quote is good for RATE_TTL_MS after rating, and
 * never across a carrier price change: USPS changes prices at 12:01 a.m. Central, so a quote made
 * the evening before must not be bought after midnight (research 10 M-17). Past the expiry the
 * shipping service re-rates before buying and stops if the price moved.
 *
 * Price changes (Central midnight, as UTC instants). Sources, checked 2026-09-29:
 *   USPS 2026 holiday surcharge Oct 4 2026 through Jan 17 2027 (USPS Postal Bulletin / DMM
 *   Notice 123, as recorded in research 10 §8 and add-carrier-or-supplier-adapter step 6);
 *   UPS peak surcharges through Jan 16 2027 (same sources). Add a row when a carrier announces
 *   the next general price change (provider-deprecation-watch).
 */
export const RATE_TTL_MS = 24 * 3600_000;

export const PRICE_CHANGES: { carrier: CarrierCode; at: string }[] = [
  { carrier: "usps", at: "2026-10-04T05:00:00.000Z" },
  { carrier: "usps", at: "2027-01-18T06:00:00.000Z" },
  { carrier: "ups", at: "2027-01-17T06:00:00.000Z" },
];

/** When a quote made at `ratedAt` stops being buyable. */
export function rateExpiresAt(
  carrier: CarrierCode,
  ratedAt: Date,
  changes: { carrier: CarrierCode; at: string }[] = PRICE_CHANGES,
): Date {
  let expires = ratedAt.getTime() + RATE_TTL_MS;
  for (const c of changes) {
    const at = Date.parse(c.at);
    if (c.carrier === carrier && at > ratedAt.getTime() && at < expires) expires = at;
  }
  return new Date(expires);
}
