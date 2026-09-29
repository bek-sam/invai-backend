import { CHANNEL_RULES, type Channel } from "@invai/contracts";
import type { FeeTable } from "./profit";

/*
 * T-7-2: marketplace referral fees and what a refund gives back. Pure, integer cents.
 *
 * Verified 2026-09-25 against the channels' own fee pages:
 * - Amazon  https://sell.amazon.com/pricing -- Clothing & Accessories 5% (total sales price
 *   <= $15), 10% (> $15 and <= $20), 17% (> $20); Backpacks, Handbags & Luggage 15%; Everything
 *   else 15%; $0.30 minimum per item. On a refund Amazon returns the referral fee less a refund
 *   administration fee of the lesser of $5.00 or 20% of that fee.
 * - Walmart https://marketplace.walmart.com/referral-fees/ -- Apparel & Accessories 5% (<= $15),
 *   10% ($15-$20), 15% (> $20); Shoes, Handbags, Backpacks & Sunglasses 15%; Everything else
 *   15%; no minimum listed. The fee page names no refund administration fee, so a refund is
 *   modelled as returning the referral fee on the refunded amount in full.
 * - TikTok Shop US https://seller-us.tiktok.com/university/essay?knowledge_id=5988482086864682
 *   (updated 2026-05-14) -- 6% referral for menswear, womenswear and kids' fashion (the fee
 *   covers every TikTok Shop fee but shipping and tax). Refunds return the referral fee less a
 *   20% refund administration fee, capped at $5 per SKU from 2025-05-15
 *   (knowledge_id=5982454398175018). The contracts default is 6% since 0.8.0 (B-164); saved
 *   cost settings still at the old 8% were moved to 6 by migration (T-22-5).
 *
 * The tiered schedule applies while the shop's saved `transactionPct` for the channel is still
 * the contracts default; once the shop types its own rate, that flat rate wins.
 */

export type FeeCategory = "apparel" | "bags" | "other";

/** A blank's style name to the marketplace fee category. A DTF shop sells garments by default. */
export function feeCategoryOf(style: string | null | undefined): FeeCategory {
  if (style && /\b(tote|bag|backpack|luggage|handbag)s?\b/i.test(style)) return "bags";
  return "apparel";
}

type Tier = { upTo: number | null; pct: number };
type Schedule = { tiers: Record<FeeCategory, Tier[]>; minCents: number };

const flat = (pct: number): Tier[] => [{ upTo: null, pct }];

export const REFERRAL_SCHEDULES: Partial<Record<Channel, Schedule>> = {
  amazon: {
    tiers: {
      apparel: [
        { upTo: 1500, pct: 5 },
        { upTo: 2000, pct: 10 },
        { upTo: null, pct: 17 },
      ],
      bags: flat(15),
      other: flat(15),
    },
    minCents: 30,
  },
  walmart: {
    tiers: {
      apparel: [
        { upTo: 1500, pct: 5 },
        { upTo: 2000, pct: 10 },
        { upTo: null, pct: 15 },
      ],
      bags: flat(15),
      other: flat(15),
    },
    minCents: 0,
  },
  tiktok: {
    tiers: { apparel: flat(6), bags: flat(6), other: flat(6) },
    minCents: 0,
  },
};

/** Refund administration fee kept by the channel: pct of the returned referral fee, capped. */
const REFUND_ADMIN: Partial<Record<Channel, { pct: number; capCents: number }>> = {
  amazon: { pct: 20, capCents: 500 },
  tiktok: { pct: 20, capCents: 500 },
};

/** The tiered schedule is in force for this channel and table (the shop hasn't overridden it). */
export function usesSchedule(table: FeeTable): boolean {
  const channel = table.channel as Channel;
  const schedule = REFERRAL_SCHEDULES[channel];
  if (!schedule) return false;
  return table.transactionPct === CHANNEL_RULES[channel]?.fees.transactionPct;
}

/** The rate (plain percent) for one item's total sales price (item + its shipping share). */
export function referralPct(channel: Channel, category: FeeCategory, saleCents: number): number {
  const tiers = REFERRAL_SCHEDULES[channel]?.tiers[category] ?? [];
  for (const t of tiers) if (t.upTo === null || saleCents <= t.upTo) return t.pct;
  return 0;
}

/** Referral fee for one sold unit, in cents (rounded half up, then the channel minimum). */
export function referralFeeCents(
  channel: Channel,
  category: FeeCategory,
  saleCents: number,
): number {
  const schedule = REFERRAL_SCHEDULES[channel];
  if (!schedule || saleCents <= 0) return 0;
  const fee = Math.round((saleCents * referralPct(channel, category, saleCents)) / 100);
  return Math.max(fee, schedule.minCents);
}

/**
 * The part of the transaction/referral fee a refund gives back, in cents.
 * - `chargedFeeCents`: the referral (transaction) fee charged on the refunded unit(s).
 * - `saleCents`: what those unit(s) sold for; `refundCents`: how much of that was refunded.
 * The fee comes back in proportion to the refunded share, less the channel's refund
 * administration fee. Payment processing and per-order fees never come back.
 */
export function feeRecoveredCents(
  channel: Channel,
  input: { chargedFeeCents: number; saleCents: number; refundCents: number },
): number {
  const { chargedFeeCents, saleCents } = input;
  if (chargedFeeCents <= 0 || input.refundCents <= 0) return 0;
  if (channel === "shopify" || channel === "csv") return 0;
  const refund = saleCents > 0 ? Math.min(input.refundCents, saleCents) : 0;
  const share = saleCents > 0 ? Math.round((chargedFeeCents * refund) / saleCents) : 0;
  const admin = REFUND_ADMIN[channel];
  const kept = admin ? Math.min(Math.round((share * admin.pct) / 100), admin.capCents) : 0;
  return Math.max(0, share - kept);
}
