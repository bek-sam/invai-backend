import { CHANNEL_RULES, type Channel } from "@invai/contracts";
import type { ChannelFeeTable } from "../../db/schema";

/*
 * Pure profit math (no DB). Every amount is integer cents; splits use largest-remainder
 * allocation so the parts always add up to the whole.
 */

export type Buckets = {
  revenue: number;
  channelFees: number;
  blankCost: number;
  transferCost: number;
  labelCost: number;
  packagingCost: number;
  laborCost: number;
  adsCost: number;
  refunds: number;
  net: number;
  marginPct: number | null;
};

export const BUCKET_KEYS = [
  "revenue",
  "channelFees",
  "blankCost",
  "transferCost",
  "labelCost",
  "packagingCost",
  "laborCost",
  "adsCost",
  "refunds",
] as const;

export function emptyBuckets(): Buckets {
  return {
    revenue: 0,
    channelFees: 0,
    blankCost: 0,
    transferCost: 0,
    labelCost: 0,
    packagingCost: 0,
    laborCost: 0,
    adsCost: 0,
    refunds: 0,
    net: 0,
    marginPct: null,
  };
}

/** net = revenue − every cost − refunds; margin = net / revenue (a ratio, null at 0 revenue). */
export function finalize(b: Omit<Buckets, "net" | "marginPct">): Buckets {
  const net =
    b.revenue -
    b.channelFees -
    b.blankCost -
    b.transferCost -
    b.labelCost -
    b.packagingCost -
    b.laborCost -
    b.adsCost -
    b.refunds;
  return {
    revenue: b.revenue,
    channelFees: b.channelFees,
    blankCost: b.blankCost,
    transferCost: b.transferCost,
    labelCost: b.labelCost,
    packagingCost: b.packagingCost,
    laborCost: b.laborCost,
    adsCost: b.adsCost,
    refunds: b.refunds,
    net,
    marginPct: b.revenue > 0 ? net / b.revenue : null,
  };
}

/** Sum bucket rows and recompute net/margin. */
export function sumBuckets(rows: Omit<Buckets, "net" | "marginPct">[]): Buckets {
  const acc = emptyBuckets();
  for (const r of rows) for (const k of BUCKET_KEYS) acc[k] += r[k];
  return finalize(acc);
}

/**
 * Split `total` over `weights` in proportion, in integer cents, exactly (largest remainder).
 * All-zero weights split evenly.
 */
export function allocate(total: number, weights: number[]): number[] {
  if (!weights.length) return [];
  const w = weights.map((x) => Math.max(0, x));
  const sum = w.reduce((a, b) => a + b, 0);
  const shares = sum > 0 ? w.map((x) => (total * x) / sum) : w.map(() => total / w.length);
  const floors = shares.map((s) => Math.floor(s));
  let rest = total - floors.reduce((a, b) => a + b, 0);
  const order = shares
    .map((s, i) => ({ i, frac: s - Math.floor(s) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (rest <= 0) break;
    floors[i] = (floors[i] ?? 0) + 1;
    rest--;
  }
  return floors;
}

export type FeeTable = Omit<ChannelFeeTable, "channel"> & { channel: string };

/** Channel defaults from contracts CHANNEL_RULES (used when the shop has no saved table). */
export function defaultFeeTable(channel: Channel): FeeTable {
  const f = CHANNEL_RULES[channel].fees;
  return {
    channel,
    transactionPct: f.transactionPct,
    perOrderCents: f.perOrderCents,
    paymentPct: f.paymentPct,
    paymentFixedCents: f.paymentFixedCents,
    listingFeeCents: f.listingFeeCents,
  };
}

export function feeTableFor(tables: FeeTable[], channel: Channel): FeeTable {
  return tables.find((t) => t.channel === channel) ?? defaultFeeTable(channel);
}

/**
 * Fees for one order: transaction % on item + shipping revenue, payment processing % + fixed
 * on the buyer total, a per-order fee and the listing (renewal) fee per unit sold.
 */
export function orderFees(
  table: FeeTable,
  input: { revenueCents: number; buyerTotalCents: number; units: number },
): { total: number; lines: { label: string; amount: number }[] } {
  const lines: { label: string; amount: number }[] = [];
  const add = (label: string, amount: number) => {
    const a = Math.round(amount);
    if (a > 0) lines.push({ label, amount: a });
  };
  if (input.units <= 0) return { total: 0, lines };
  add(`Transaction ${table.transactionPct}%`, (input.revenueCents * table.transactionPct) / 100);
  add(
    `Payment processing ${table.paymentPct}% + ${table.paymentFixedCents}¢`,
    (input.buyerTotalCents * table.paymentPct) / 100 + table.paymentFixedCents,
  );
  add("Per-order fee", table.perOrderCents);
  add(`Listing fee × ${input.units}`, table.listingFeeCents * input.units);
  return { total: lines.reduce((a, l) => a + l.amount, 0), lines };
}

/**
 * Spread ad spend for one channel-day over that day's orders on the channel, by revenue share
 * or evenly per order. Returns cents per order key.
 */
export function allocateAdSpend(
  spendCents: number,
  orders: { key: string; revenueCents: number }[],
  mode: "revenue_share" | "per_order",
): Map<string, number> {
  const parts = allocate(
    spendCents,
    orders.map((o) => (mode === "per_order" ? 1 : o.revenueCents)),
  );
  return new Map(orders.map((o, i) => [o.key, parts[i] ?? 0]));
}

export function printAreaSqIn(widthIn: number | null, heightIn: number | null): number {
  if (!widthIn || !heightIn) return 0;
  return Math.max(0, widthIn * heightIn);
}

/**
 * Transfer cost for one item: the vendor sheet price prorated by this transfer's share of the
 * printed area when the sheet cost is known, else area × the shop's $/sq in.
 */
export function transferCost(input: {
  areaSqIn: number;
  centsPerSqIn: number;
  sheetCostCents?: number | null;
  sheetAreaSqIn?: number | null;
}): { cents: number; estimated: boolean } {
  if (
    input.sheetCostCents &&
    input.sheetAreaSqIn &&
    input.sheetAreaSqIn > 0 &&
    input.areaSqIn > 0
  ) {
    return {
      cents: Math.round((input.sheetCostCents * input.areaSqIn) / input.sheetAreaSqIn),
      estimated: false,
    };
  }
  return { cents: Math.round(input.areaSqIn * input.centsPerSqIn), estimated: true };
}

export function laborCost(minutes: number, ratePerHourCents: number): number {
  return Math.round((minutes * ratePerHourCents) / 60);
}
