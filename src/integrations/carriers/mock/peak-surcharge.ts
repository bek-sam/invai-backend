/*
 * USPS temporary peak-season surcharge, applied by the MOCK carrier only. Real EasyPost rates
 * already include carrier surcharges and we store the bought rate, so the live adapter never
 * imports this file.
 *
 * Status: pending Postal Regulatory Commission (PRC) review. The figures are third party
 * (dclcorp.com, commercial zones 1-4, one column for Priority and Ground Advantage); they are
 * applied to every mock zone 1-8 and by whole pounds only. If the PRC rejects or changes the
 * increase, set `enabled` to false; nothing else changes. After the window the table is inert.
 *
 * The window is Central midnights, the same instants as the usps rows of `rate-ttl.ts`
 * PRICE_CHANGES, so a quote and its expiry switch at the same moment (spec
 * specs/usps-peak-surcharge.md).
 */
export const USPS_PEAK_SURCHARGE = {
  /** The PRC switch. Mutable on purpose: `mockRates` reads it on every call. */
  enabled: true,
  status: "pending PRC review",
  sources: [
    "https://www.supplychaindive.com/news/usps-announces-6-rate-increase-for-2026-peak-season/828763/",
    "https://dclcorp.com/blog/shipping/2026-usps-holiday-peak-surcharge/",
  ],
  /** First surcharged instant: 2026-10-04 00:00 US Central. */
  startsAt: "2026-10-04T05:00:00.000Z",
  /** First instant that is base price again: 2027-01-18 00:00 US Central. */
  endsBefore: "2027-01-18T06:00:00.000Z",
  /** Cents added per label by whole pounds (round up). Over the last tier: no figure, no add. */
  tiers: [
    { maxLb: 3, addCents: 40 },
    { maxLb: 10, addCents: 65 },
    { maxLb: 25, addCents: 105 },
  ],
};

/** Cents the peak surcharge adds to a quote of this carrier, weight and clock (0 when none). */
export function peakSurchargeCents(carrier: "usps" | "ups", weightOz: number, now: Date): number {
  const s = USPS_PEAK_SURCHARGE;
  if (!s.enabled || carrier !== "usps") return 0;
  const t = now.getTime();
  if (t < Date.parse(s.startsAt) || t >= Date.parse(s.endsBefore)) return 0;
  const lb = Math.max(1, Math.ceil(weightOz / 16));
  return s.tiers.find((tier) => lb <= tier.maxLb)?.addCents ?? 0;
}
