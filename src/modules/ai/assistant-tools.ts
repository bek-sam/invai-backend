import {
  CHANNEL_RULES,
  CHANNELS,
  type Channel,
  type MarketRecommendation,
  type SignalSourceRef,
} from "@invai/contracts";
import { ORPCError } from "@orpc/server";
import { and, eq, gte, inArray, isNotNull, isNull, lt, ne, sql } from "drizzle-orm";
import { z } from "zod";
import {
  BAND_COPY,
  channelLabel,
  fill,
  MARKET_COPY,
  money,
  monthName,
  R1_PARTIAL,
  RULE_ACTION,
  sourceLine,
  weeks,
} from "../../ai/market-copy";
import type { AssistantTool, ToolOutput } from "../../ai/providers/types";
import type { TenantContext } from "../../api/context";
import { type Tx, withTenant } from "../../db/client";
import {
  adSpend,
  channelConnections,
  companies,
  designs,
  gangSheets,
  listings,
  listingVariants,
  orderItems,
  orders,
  profitLines,
  refundEvents,
  reprints,
} from "../../db/schema";
import { logger } from "../../lib/log";
import { getProfit, localDay } from "../finance/service";
import { listStock } from "../inventory/service";
import * as market from "../market/service";
import { screenMarketTerms } from "./niche";

const log = logger("ai.assistant-tools");

/*
 * The assistant's read-only, company-scoped tools. Each tool opens its own withTenant transaction
 * with the caller's tenant context, so RLS applies exactly as for the user. No raw SQL from the
 * model, no buyer PII in results (orders are counted, never listed with names/addresses).
 */

const usd = (cents: number) =>
  `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (v: number | null) => (v == null ? "n/a" : `${(v * 100).toFixed(1)}%`);
const label = (c: string) => CHANNEL_RULES[c as Channel]?.label ?? c;
const day = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const range = (from: string, to: string) =>
  `${day(from)} – ${day(new Date(new Date(to).getTime() - 1).toISOString())}`;

const Range = z.object({
  from: z.string().describe("Period start, ISO 8601 timestamp"),
  to: z.string().describe("Period end (exclusive), ISO 8601 timestamp"),
});

/* ------------------------- analyst helpers (T-17-2) ------------------------- */

/** Every list a tool returns is capped at this many rows. */
const MAX_ROWS = 20;
/** Rising, falling, low-margin and cross-listing signals need at least this many units. */
const MIN_UNITS = 3;
const LOW_MARGIN = 0.15;
const OPEN_STATUSES = [
  "new",
  "needs_attention",
  "in_production",
  "ready_to_ship",
  "on_hold",
] as const;
/** A channel counts as "connected" for cross-listing unless it is pending or disconnected. */
const ACTIVE_CONNECTION = ["connected", "csv_only", "error"] as const;

type Period = { from: string; to: string };

/** S-33: the longest period any assistant tool will scan. */
export const MAX_RANGE_DAYS = 400;

/**
 * S-33: a bad or oversized period comes back as a normal tool result carrying `error`, so the
 * model can retry with a valid range (and the UI still gets its tool_result), instead of a thrown
 * error that ends the mock run or scans a century of rows.
 */
function rangeProblem(i: Record<string, unknown>): string | null {
  const pairs: [unknown, unknown, string][] = [
    [i.from, i.to, "from/to"],
    [i.previousFrom, i.previousTo, "previousFrom/previousTo"],
  ];
  for (const [a, b, what] of pairs) {
    if (a === undefined && b === undefined) continue;
    const f = new Date(String(a));
    const t = new Date(String(b));
    if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime()))
      return `Invalid ${what}: use ISO 8601 timestamps.`;
    if (f >= t) return `Invalid ${what}: the start must be before the end.`;
    if (t.getTime() - f.getTime() > MAX_RANGE_DAYS * 86_400_000)
      return `Range too long (${what}); max ${MAX_RANGE_DAYS} days. Ask for a shorter period or split it.`;
  }
  return null;
}

function rangeRefusal(tool: string, message: string): ToolOutput {
  return {
    data: { error: "invalid_range", message, maxDays: MAX_RANGE_DAYS },
    summary: `${tool}: ${message}`,
    answer: message,
  };
}

const ratio = (a: number, b: number) => (b > 0 ? a / b : null);
const perUnit = (a: number, b: number) => (b > 0 ? Math.round(a / b) : null);
const changeOf = (cur: number, prev: number) => ({
  abs: cur - prev,
  pct: prev !== 0 ? (cur - prev) / Math.abs(prev) : null,
});
const signedUsd = (c: number) => `${c >= 0 ? "+" : "-"}${usd(Math.abs(c))}`;
const signedPct = (v: number | null) =>
  v == null ? "new" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`;

function toPeriod(from: string, to: string): Period {
  const f = new Date(from);
  const t = new Date(to);
  if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime()) || f >= t)
    throw new Error("`from` must be a valid timestamp before `to`");
  return { from: f.toISOString(), to: t.toISOString() };
}

/** The same-length period immediately before `p`. */
export function previousPeriod(p: Period): Period {
  const len = new Date(p.to).getTime() - new Date(p.from).getTime();
  return { from: new Date(new Date(p.from).getTime() - len).toISOString(), to: p.from };
}

/** Profit per channel for a period (at most 7 channels, so rows are never truncated). */
function channelProfit(tx: Tx, ctx: TenantContext, period: Period, channel?: Channel) {
  return getProfit(tx, ctx, { dimension: "channel", period, channel, limit: 50, sort: "revenue" });
}

async function shopTimezone(tx: Tx, companyId: string): Promise<string> {
  const [c] = await tx
    .select({ tz: companies.timezone })
    .from(companies)
    .where(eq(companies.id, companyId));
  return c?.tz ?? "UTC";
}

/** Ad spend in a period: `ad_spend.day` is a shop-local day, as the profit allocation reads it. */
async function adSpendBy(
  tx: Tx,
  companyId: string,
  tz: string,
  p: Period,
  channel: Channel | undefined,
  byCampaign: boolean,
) {
  // Half-open on shop days too, so back-to-back periods never count a day twice.
  const where = and(
    eq(adSpend.companyId, companyId),
    gte(adSpend.day, localDay(new Date(p.from), tz)),
    lt(adSpend.day, localDay(new Date(p.to), tz)),
    channel ? eq(adSpend.channel, channel) : undefined,
  );
  const spend = sql<number>`coalesce(sum(${adSpend.amountCents}), 0)::int`;
  if (byCampaign)
    return tx
      .select({ channel: adSpend.channel, campaign: adSpend.campaign, spend })
      .from(adSpend)
      .where(where)
      .groupBy(adSpend.channel, adSpend.campaign);
  return tx
    .select({ channel: adSpend.channel, campaign: sql<string | null>`null`, spend })
    .from(adSpend)
    .where(where)
    .groupBy(adSpend.channel);
}

export function assistantTools(ctx: TenantContext): AssistantTool[] {
  const t = <I extends z.ZodObject>(
    name: string,
    description: string,
    input: I,
    run: (i: z.infer<I>) => Promise<ToolOutput>,
  ): AssistantTool => ({
    name,
    description,
    input,
    run: async (raw) => {
      const i = input.parse(raw);
      const problem = rangeProblem(i as Record<string, unknown>);
      return problem ? rangeRefusal(name, problem) : run(i);
    },
  });

  return [
    t(
      "get_profit",
      "True profit (revenue minus channel fees, blanks, transfers, labels, packaging, labor, ads and refunds) for a period, grouped by order, design, blank, channel or day. Optionally filtered to one channel. Money in cents.",
      Range.extend({
        dimension: z.enum(["order", "design", "blank", "channel", "day"]),
        channel: z.enum(CHANNELS).optional(),
      }),
      async (i) => {
        const s = await withTenant(ctx.companyId, (tx) =>
          getProfit(tx, ctx, {
            dimension: i.dimension,
            period: { from: new Date(i.from).toISOString(), to: new Date(i.to).toISOString() },
            channel: i.channel,
            limit: 10,
            sort: "net",
          }),
        );
        const tot = s.totals;
        const who = i.channel ? label(i.channel) : "All channels";
        const when = range(i.from, i.to);
        const top = s.rows
          .slice(0, 3)
          .map((r) => `${r.label}: ${usd(r.net)} net on ${usd(r.revenue)} (${pct(r.marginPct)})`);
        const answer =
          tot.revenue === 0
            ? `${who} had no profit data for ${when}.`
            : `**${who}, ${when}: ${pct(tot.marginPct)} margin.** Revenue ${usd(tot.revenue)}, net profit ${usd(tot.net)} after channel fees ${usd(tot.channelFees)}, blanks ${usd(tot.blankCost)}, transfers ${usd(tot.transferCost)}, labels ${usd(tot.labelCost)}, ads ${usd(tot.adsCost)} and labor ${usd(tot.laborCost)}.${
                !i.channel && top.length > 1 ? `\n\nBy ${i.dimension}: ${top.join("; ")}.` : ""
              }${s.incomplete ? " Some orders are still missing cost data, so treat this as an estimate." : ""}`;
        return {
          data: {
            period: s.period,
            totals: tot,
            rows: s.rows.slice(0, 10),
            incomplete: s.incomplete,
          },
          summary: `${who} ${when}: revenue ${usd(tot.revenue)}, net ${usd(tot.net)}, margin ${pct(tot.marginPct)}`,
          answer,
        };
      },
    ),
    t(
      "get_orders_summary",
      "Order counts for a period (by status and channel), plus how many open orders are due today, overdue or at risk right now.",
      Range.extend({ channel: z.enum(CHANNELS).optional() }),
      async (i) =>
        withTenant(ctx.companyId, async (tx) => {
          const filters = [
            eq(orders.companyId, ctx.companyId),
            gte(orders.placedAt, new Date(i.from)),
            lt(orders.placedAt, new Date(i.to)),
            i.channel ? eq(orders.channel, i.channel) : undefined,
          ];
          const byStatus = await tx
            .select({ status: orders.status, n: sql<number>`count(*)::int` })
            .from(orders)
            .where(and(...filters))
            .groupBy(orders.status);
          const byChannel = await tx
            .select({ channel: orders.channel, n: sql<number>`count(*)::int` })
            .from(orders)
            .where(and(...filters))
            .groupBy(orders.channel);
          const open = [
            "new",
            "needs_attention",
            "in_production",
            "ready_to_ship",
            "on_hold",
          ] as const;
          const [now] = await tx
            .select({
              overdue: sql<number>`(count(*) filter (where ${orders.shipBy} < now()))::int`,
              dueToday: sql<number>`(count(*) filter (where ${orders.shipBy} >= now() and ${orders.shipBy} < date_trunc('day', now()) + interval '1 day'))::int`,
              atRisk: sql<number>`(count(*) filter (where ${orders.shipBy} >= now() and ${orders.shipBy} < now() + interval '24 hours'))::int`,
            })
            .from(orders)
            .where(
              and(
                eq(orders.companyId, ctx.companyId),
                inArray(orders.status, [...open]),
                i.channel ? eq(orders.channel, i.channel) : undefined,
              ),
            );
          const total = byStatus.reduce((a, r) => a + r.n, 0);
          const when = range(i.from, i.to);
          const channels = byChannel
            .sort((a, b) => b.n - a.n)
            .map((r) => `${label(r.channel)} ${r.n}`)
            .join(", ");
          return {
            data: { total, byStatus, byChannel, open: now },
            summary: `${total} orders ${when}; ${now?.overdue ?? 0} overdue, ${now?.dueToday ?? 0} due today`,
            answer: `**${total} orders** were placed ${when}${channels ? ` (${channels})` : ""}. Right now ${now?.overdue ?? 0} open orders are overdue, ${now?.dueToday ?? 0} are due today and ${now?.atRisk ?? 0} must ship within 24 hours.`,
          };
        }),
    ),
    t(
      "get_stock",
      "Blank stock levels: available, reserved, incoming, days of cover and whether each variant is below its reorder point.",
      z.object({
        belowReorderOnly: z.boolean().default(false),
        search: z.string().optional().describe("Filter by brand, style, color or size"),
      }),
      async (i) => {
        const res = await withTenant(ctx.companyId, (tx) =>
          listStock(tx, ctx, {
            limit: 200,
            search: i.search,
            belowReorderPoint: i.belowReorderOnly ? true : undefined,
            sort: "daysOfCover",
          }),
        );
        const items = res.items.slice(0, 15).map((s) => ({
          sku: `${s.blank.styleCode} ${s.blank.color} ${s.blank.size}`,
          available: s.available,
          reserved: s.reserved,
          incoming: s.incoming,
          reorderPoint: s.reorderPoint,
          daysOfCover: s.daysOfCover,
        }));
        const worst = items
          .slice(0, 5)
          .map(
            (s) =>
              `${s.sku} (${s.available} left${s.daysOfCover != null ? `, ${s.daysOfCover.toFixed(1)} days` : ""})`,
          )
          .join(", ");
        return {
          data: { lowStockCount: res.lowStockCount, items },
          summary: `${res.lowStockCount} variants below reorder point`,
          answer: `**${res.lowStockCount} blank variants are below their reorder point.**${worst ? ` Lowest cover: ${worst}.` : ""} The reorder suggestions page groups these per supplier up to the free-freight line.`,
        };
      },
    ),
    t(
      "get_listing_performance",
      "Best-selling designs for a period: units sold, orders and revenue per design.",
      Range.extend({ limit: z.number().int().min(1).max(20).default(5) }),
      async (i) =>
        withTenant(ctx.companyId, async (tx) => {
          const rows = await tx
            .select({
              designId: orderItems.designId,
              name: designs.name,
              units: sql<number>`count(*)::int`,
              orders: sql<number>`count(distinct ${orderItems.orderId})::int`,
              revenue: sql<number>`coalesce(sum(${orderItems.unitPriceCents}), 0)::int`,
            })
            .from(orderItems)
            .innerJoin(orders, eq(orders.id, orderItems.orderId))
            .innerJoin(designs, eq(designs.id, orderItems.designId))
            .where(
              and(
                eq(orderItems.companyId, ctx.companyId),
                gte(orders.placedAt, new Date(i.from)),
                lt(orders.placedAt, new Date(i.to)),
                sql`${orderItems.state} <> 'cancelled'`,
              ),
            )
            .groupBy(orderItems.designId, designs.name)
            .orderBy(sql`count(*) desc`)
            .limit(i.limit);
          const when = range(i.from, i.to);
          return {
            data: { designs: rows },
            summary: `Top ${rows.length} designs ${when}`,
            answer: rows.length
              ? `**Top designs ${when}:** ${rows.map((r, n) => `${n + 1}. ${r.name} — ${r.units} units, ${usd(r.revenue)}`).join("; ")}.`
              : `No design sales ${when}.`,
          };
        }),
    ),
    t(
      "get_channel_performance",
      "Revenue, net profit and margin per sales channel for a period.",
      Range,
      async (i) => {
        const s = await withTenant(ctx.companyId, (tx) =>
          getProfit(tx, ctx, {
            dimension: "channel",
            period: { from: new Date(i.from).toISOString(), to: new Date(i.to).toISOString() },
            limit: 20,
            sort: "revenue",
          }),
        );
        const when = range(i.from, i.to);
        return {
          data: { rows: s.rows, totals: s.totals },
          summary: `${s.rows.length} channels ${when}`,
          answer: `**Channels ${when}:** ${s.rows
            .map((r) => `${label(r.key)} ${usd(r.revenue)} revenue, ${pct(r.marginPct)} margin`)
            .join("; ")}.`,
        };
      },
    ),
    t(
      "get_production_status",
      "Production floor status right now: items per state and gang sheets per status.",
      z.object({}),
      async () =>
        withTenant(ctx.companyId, async (tx) => {
          const items = await tx
            .select({ state: orderItems.state, n: sql<number>`count(*)::int` })
            .from(orderItems)
            .where(
              and(
                eq(orderItems.companyId, ctx.companyId),
                inArray(orderItems.state, [
                  "needs_mapping",
                  "ready",
                  "needs_artwork",
                  "on_sheet",
                  "transfer_in",
                  "pressed",
                  "packed",
                  "on_hold",
                ]),
              ),
            )
            .groupBy(orderItems.state);
          const sheets = await tx
            .select({ status: gangSheets.status, n: sql<number>`count(*)::int` })
            .from(gangSheets)
            .where(
              and(
                eq(gangSheets.companyId, ctx.companyId),
                inArray(gangSheets.status, ["ready", "sent", "acknowledged", "printed", "shipped"]),
              ),
            )
            .groupBy(gangSheets.status);
          const n = (s: string) => items.find((r) => r.state === s)?.n ?? 0;
          const sh = (s: string) => sheets.find((r) => r.status === s)?.n ?? 0;
          return {
            data: { items, sheets },
            summary: `${n("ready")} ready, ${n("on_sheet")} on sheets, ${n("transfer_in")} to press`,
            answer: `**Floor right now:** ${n("ready")} items ready for a sheet, ${n("on_sheet")} on sheets at the vendor, ${n("transfer_in")} transfers in hand waiting to press, ${n("pressed")} pressed awaiting QC and ${n("packed")} packed. ${n("needs_mapping") + n("needs_artwork")} items are blocked on mapping or artwork. Sheets: ${sh("sent") + sh("acknowledged")} waiting on the vendor, ${sh("printed") + sh("shipped")} printed or in transit.`,
          };
        }),
    ),
    t(
      "compare_periods",
      "Compare two periods: orders, units, revenue, net profit, margin, ads cost and average order value for each, the absolute and % change, and how much each channel contributed to the revenue and net change (contributions add up to the total change). With no previous range, the previous period is the same length immediately before. Use it for 'why' and 'this vs last' questions. Money in cents, ratios 0..1.",
      Range.extend({
        previousFrom: z.string().optional().describe("Previous period start, ISO 8601"),
        previousTo: z.string().optional().describe("Previous period end (exclusive), ISO 8601"),
        channel: z.enum(CHANNELS).optional(),
      }),
      async (i) =>
        withTenant(ctx.companyId, async (tx) => {
          const cur = toPeriod(i.from, i.to);
          const prev =
            i.previousFrom && i.previousTo
              ? toPeriod(i.previousFrom, i.previousTo)
              : previousPeriod(cur);
          const [a, b] = [
            await channelProfit(tx, ctx, cur, i.channel),
            await channelProfit(tx, ctx, prev, i.channel),
          ];
          const metrics = (s: typeof a, p: Period) => {
            const ordersN = s.rows.reduce((n, r) => n + r.orders, 0);
            return {
              from: p.from,
              to: p.to,
              orders: ordersN,
              units: s.rows.reduce((n, r) => n + r.units, 0),
              revenue: s.totals.revenue,
              net: s.totals.net,
              margin: s.totals.marginPct,
              adsCost: s.totals.adsCost,
              avgOrderValue: perUnit(s.totals.revenue, ordersN),
            };
          };
          const current = metrics(a, cur);
          const previous = metrics(b, prev);
          const change = {
            orders: changeOf(current.orders, previous.orders),
            units: changeOf(current.units, previous.units),
            revenue: changeOf(current.revenue, previous.revenue),
            net: changeOf(current.net, previous.net),
            adsCost: changeOf(current.adsCost, previous.adsCost),
            avgOrderValue: changeOf(current.avgOrderValue ?? 0, previous.avgOrderValue ?? 0),
            marginPoints:
              current.margin != null && previous.margin != null
                ? current.margin - previous.margin
                : null,
          };
          const keys = [...new Set([...a.rows, ...b.rows].map((r) => r.key))];
          const byChannel = keys
            .map((k) => {
              const x = a.rows.find((r) => r.key === k);
              const y = b.rows.find((r) => r.key === k);
              return {
                channel: k,
                revenue: x?.revenue ?? 0,
                previousRevenue: y?.revenue ?? 0,
                revenueChange: (x?.revenue ?? 0) - (y?.revenue ?? 0),
                net: x?.net ?? 0,
                previousNet: y?.net ?? 0,
                netChange: (x?.net ?? 0) - (y?.net ?? 0),
                orders: x?.orders ?? 0,
                previousOrders: y?.orders ?? 0,
              };
            })
            .sort((p, q) => Math.abs(q.revenueChange) - Math.abs(p.revenueChange))
            .slice(0, MAX_ROWS);
          const who = i.channel ? label(i.channel) : "All channels";
          const when = `${range(cur.from, cur.to)} vs ${range(prev.from, prev.to)}`;
          const top = byChannel[0];
          const driver =
            !i.channel && top && top.revenueChange !== 0
              ? ` The biggest change came from ${label(top.channel)}: ${signedUsd(top.revenueChange)} revenue and ${signedUsd(top.netChange)} net.`
              : "";
          const incomplete = a.incomplete || b.incomplete;
          return {
            data: { current, previous, change, byChannel, incomplete },
            summary: `${who} ${when}: revenue ${signedPct(change.revenue.pct)}, net ${signedUsd(change.net.abs)}`,
            answer:
              current.revenue === 0 && previous.revenue === 0
                ? `${who} had no sales in either period (${when}).`
                : `**${who}, ${when}: revenue ${usd(current.revenue)} vs ${usd(previous.revenue)} (${signedPct(change.revenue.pct)}).** Net profit ${usd(current.net)} vs ${usd(previous.net)} (${signedUsd(change.net.abs)}), margin ${pct(current.margin)} vs ${pct(previous.margin)}. Orders ${current.orders} vs ${previous.orders}, average order ${current.avgOrderValue == null ? "n/a" : usd(current.avgOrderValue)} vs ${previous.avgOrderValue == null ? "n/a" : usd(previous.avgOrderValue)}, ads ${usd(current.adsCost)} vs ${usd(previous.adsCost)}.${driver}${incomplete ? " Some orders are still missing cost data, so treat net as an estimate." : ""}`,
          };
        }),
    ),
    t(
      "get_ad_performance",
      "Ad efficiency for a period. Per channel: ad spend, channel revenue and orders, ROAS (channel revenue ÷ ad spend), TACoS (ad spend ÷ total shop revenue), ad cost per order, net before and after ads, and flags (spend with negative net; spend up while revenue down vs the previous same-length period). Attribution is channel-level only: there is no click or campaign revenue data. groupBy 'campaign' returns spend and share of spend per campaign only. Money in cents, ratios 0..1.",
      Range.extend({
        channel: z.enum(CHANNELS).optional(),
        groupBy: z.enum(["channel", "campaign"]).default("channel"),
      }),
      async (i) =>
        withTenant(ctx.companyId, async (tx) => {
          const cur = toPeriod(i.from, i.to);
          const prev = previousPeriod(cur);
          const tz = await shopTimezone(tx, ctx.companyId);
          const when = range(cur.from, cur.to);
          const spendNow = await adSpendBy(
            tx,
            ctx.companyId,
            tz,
            cur,
            i.channel,
            i.groupBy === "campaign",
          );
          const totalSpend = spendNow.reduce((n, r) => n + r.spend, 0);

          if (i.groupBy === "campaign") {
            const campaigns = spendNow
              .filter((r) => r.spend !== 0)
              .sort((p, q) => q.spend - p.spend)
              .slice(0, MAX_ROWS)
              .map((r) => ({
                campaign: r.campaign,
                channel: r.channel,
                spend: r.spend,
                shareOfSpend: ratio(r.spend, totalSpend),
              }));
            return {
              data: { attribution: "channel", groupBy: "campaign", totalSpend, campaigns },
              summary: `${campaigns.length} campaigns ${when}: ${usd(totalSpend)} spend`,
              answer: campaigns.length
                ? `**Ad spend ${when}: ${usd(totalSpend)}.** ${campaigns
                    .slice(0, 5)
                    .map(
                      (c) =>
                        `${c.campaign ?? "No campaign"} (${label(c.channel)}) ${usd(c.spend)}, ${pct(c.shareOfSpend)} of spend`,
                    )
                    .join(
                      "; ",
                    )}. Campaign revenue isn't available, so ROAS is only shown per channel.`
                : `No ad spend was recorded ${when}.`,
            };
          }

          const spendPrev = await adSpendBy(tx, ctx.companyId, tz, prev, i.channel, false);
          // Whole-shop profit (no channel filter): TACoS divides by total shop revenue.
          const [pa, pb] = [await channelProfit(tx, ctx, cur), await channelProfit(tx, ctx, prev)];
          const totalRevenue = pa.totals.revenue;
          const keys = [
            ...new Set([...spendNow.map((r) => r.channel), ...pa.rows.map((r) => r.key)]),
          ].filter((k) => !i.channel || k === i.channel);
          const channels = keys
            .map((k) => {
              const spend = spendNow.find((r) => r.channel === k)?.spend ?? 0;
              const previousSpend = spendPrev.find((r) => r.channel === k)?.spend ?? 0;
              const p = pa.rows.find((r) => r.key === k);
              const q = pb.rows.find((r) => r.key === k);
              const revenue = p?.revenue ?? 0;
              const previousRevenue = q?.revenue ?? 0;
              const netBeforeAds = (p?.net ?? 0) + (p?.adsCost ?? 0);
              const netAfterAds = netBeforeAds - spend;
              const flags: string[] = [];
              if (spend > 0 && netAfterAds < 0) flags.push("spend_with_negative_net");
              if (spend > previousSpend && revenue < previousRevenue)
                flags.push("spend_up_revenue_down");
              return {
                channel: k,
                spend,
                revenue,
                orders: p?.orders ?? 0,
                roas: ratio(revenue, spend),
                tacos: ratio(spend, totalRevenue),
                adCostPerOrder: spend > 0 ? perUnit(spend, p?.orders ?? 0) : null,
                netBeforeAds,
                netAfterAds,
                previousSpend,
                previousRevenue,
                flags,
              };
            })
            .filter((r) => r.spend !== 0 || r.revenue !== 0)
            .sort((p, q) => q.spend - p.spend || q.revenue - p.revenue)
            .slice(0, MAX_ROWS);
          const scopeRevenue = i.channel ? (channels[0]?.revenue ?? 0) : totalRevenue;
          const totals = {
            spend: totalSpend,
            revenue: scopeRevenue,
            totalShopRevenue: totalRevenue,
            roas: ratio(scopeRevenue, totalSpend),
            tacos: ratio(totalSpend, totalRevenue),
          };
          const flagged = channels.filter((c) => c.flags.length);
          const flagText = (f: string) =>
            f === "spend_with_negative_net"
              ? "loses money after ads"
              : "spend went up while revenue went down";
          const roasText = (v: number | null) => (v == null ? "n/a" : `${v.toFixed(2)}x`);
          return {
            data: { attribution: "channel", groupBy: "channel", totals, channels },
            summary: `Ads ${when}: ${usd(totalSpend)} spend, ROAS ${roasText(totals.roas)}, TACoS ${pct(totals.tacos)}`,
            answer:
              totalSpend === 0
                ? `No ad spend was recorded ${when}.`
                : `**Ads ${when}: ${usd(totalSpend)} spend, ROAS ${roasText(totals.roas)}, TACoS ${pct(totals.tacos)}.** ${channels
                    .filter((c) => c.spend > 0)
                    .map(
                      (c) =>
                        `${label(c.channel)}: ${usd(c.spend)} spend on ${usd(c.revenue)} revenue (ROAS ${roasText(c.roas)}, TACoS ${pct(c.tacos)}, ${c.adCostPerOrder == null ? "no orders" : `${usd(c.adCostPerOrder)} per order`}, net after ads ${usd(c.netAfterAds)})`,
                    )
                    .join("; ")}.${
                    flagged.length
                      ? ` Watch: ${flagged.map((c) => `${label(c.channel)} ${c.flags.map(flagText).join(" and ")}`).join("; ")}.`
                      : ""
                  } ROAS here counts all of a channel's revenue, not only sales from ads (attribution is per channel).`,
          };
        }),
    ),
    t(
      "get_design_insights",
      "Design trends and opportunities for a period, compared with the previous same-length period: rising and falling designs (units, at least 3), low-margin designs (margin under 15% with at least 3 units), top designs by net profit, and cross-listing gaps (a design with at least 3 units on one channel and no active listing on another connected channel). Money in cents, ratios 0..1.",
      Range.extend({ limit: z.number().int().min(1).max(MAX_ROWS).default(5) }),
      async (i) =>
        withTenant(ctx.companyId, async (tx) => {
          const cur = toPeriod(i.from, i.to);
          const prev = previousPeriod(cur);
          const opts = { dimension: "design", limit: 500, sort: "net" } as const;
          const a = await getProfit(tx, ctx, { ...opts, period: cur });
          const b = await getProfit(tx, ctx, { ...opts, period: prev });
          const prevUnits = new Map(b.rows.map((r) => [r.key, r.units]));
          const rows = a.rows
            .filter((r) => r.key !== "unmapped")
            .map((r) => ({
              designId: r.key,
              name: r.label,
              units: r.units,
              previousUnits: prevUnits.get(r.key) ?? 0,
              revenue: r.revenue,
              net: r.net,
              margin: r.marginPct,
            }));
          const trend = (r: (typeof rows)[number]) => ({
            designId: r.designId,
            name: r.name,
            units: r.units,
            previousUnits: r.previousUnits,
            change: changeOf(r.units, r.previousUnits),
          });
          const rising = rows
            .filter((r) => r.units >= MIN_UNITS && r.units > r.previousUnits)
            .sort((p, q) => q.units - q.previousUnits - (p.units - p.previousUnits))
            .slice(0, i.limit)
            .map(trend);
          // Designs that sold before and fell (including to zero this period).
          const falling = b.rows
            .filter((r) => r.key !== "unmapped" && r.units >= MIN_UNITS)
            .map((r) => {
              const now = rows.find((x) => x.designId === r.key);
              return {
                designId: r.key,
                name: r.label,
                units: now?.units ?? 0,
                previousUnits: r.units,
                revenue: now?.revenue ?? 0,
                net: now?.net ?? 0,
                margin: now?.margin ?? null,
              };
            })
            .filter((r) => r.units < r.previousUnits)
            .sort((p, q) => p.units - p.previousUnits - (q.units - q.previousUnits))
            .slice(0, i.limit)
            .map(trend);
          const lowMargin = rows
            .filter((r) => r.units >= MIN_UNITS && r.margin != null && r.margin < LOW_MARGIN)
            .sort((p, q) => (p.margin ?? 0) - (q.margin ?? 0))
            .slice(0, i.limit)
            .map(({ designId, name, units, revenue, net, margin }) => ({
              designId,
              name,
              units,
              revenue,
              net,
              margin,
            }));
          const topNet = rows
            .filter((r) => r.net > 0)
            .sort((p, q) => q.net - p.net)
            .slice(0, i.limit)
            .map(({ designId, name, units, revenue, net, margin }) => ({
              designId,
              name,
              units,
              revenue,
              net,
              margin,
            }));

          // Cross-listing gaps: units per design and channel (sold, not reprints or refunded).
          const sold = await tx
            .select({
              designId: sql<string>`${profitLines.designId}::text`,
              channel: profitLines.channel,
              units: sql<number>`count(*)::int`,
            })
            .from(profitLines)
            .where(
              and(
                eq(profitLines.companyId, ctx.companyId),
                gte(profitLines.placedAt, new Date(cur.from)),
                lt(profitLines.placedAt, new Date(cur.to)),
                isNotNull(profitLines.designId),
                eq(profitLines.isReprint, false),
                eq(profitLines.refundsCents, 0),
              ),
            )
            .groupBy(profitLines.designId, profitLines.channel)
            .having(sql`count(*) >= ${MIN_UNITS}`);
          const conns = await tx
            .select({ channel: channelConnections.channel, status: channelConnections.status })
            .from(channelConnections)
            .where(
              and(
                eq(channelConnections.companyId, ctx.companyId),
                ne(channelConnections.channel, "csv"),
              ),
            );
          const isActive = (st: string) => (ACTIVE_CONNECTION as readonly string[]).includes(st);
          const connected = [
            ...new Set(conns.filter((c) => isActive(c.status)).map((c) => c.channel)),
          ];
          // A channel whose every connection is pending or disconnected is left out of the gaps.
          const inactive = [
            ...new Set(conns.filter((c) => !connected.includes(c.channel)).map((c) => c.channel)),
          ];
          const gapIds = [...new Set(sold.map((s) => s.designId))];
          const listed = gapIds.length
            ? [
                ...(await tx
                  .selectDistinct({
                    designId: sql<string>`${listings.designId}::text`,
                    channel: listings.channel,
                  })
                  .from(listings)
                  .where(
                    and(
                      eq(listings.companyId, ctx.companyId),
                      eq(listings.state, "active"),
                      inArray(listings.designId, gapIds),
                    ),
                  )),
                ...(await tx
                  .selectDistinct({
                    designId: sql<string>`${listingVariants.designId}::text`,
                    channel: listings.channel,
                  })
                  .from(listingVariants)
                  .innerJoin(listings, eq(listings.id, listingVariants.listingId))
                  .where(
                    and(
                      eq(listingVariants.companyId, ctx.companyId),
                      eq(listings.state, "active"),
                      inArray(listingVariants.designId, gapIds),
                    ),
                  )),
              ]
            : [];
          const names = gapIds.length
            ? await tx
                .select({ id: sql<string>`${designs.id}::text`, name: designs.name })
                .from(designs)
                .where(and(eq(designs.companyId, ctx.companyId), inArray(designs.id, gapIds)))
            : [];
          const crossListingGaps = gapIds
            .map((id) => {
              const soldOn = sold
                .filter((s) => s.designId === id)
                .sort((p, q) => q.units - p.units)
                .map((s) => ({ channel: s.channel, units: s.units }));
              const has = new Set(listed.filter((l) => l.designId === id).map((l) => l.channel));
              const missingOn = connected.filter(
                (c) => !has.has(c) && !soldOn.some((s) => s.channel === c),
              );
              return {
                designId: id,
                name: names.find((n) => n.id === id)?.name ?? null,
                soldOn,
                missingOn,
              };
            })
            .filter((g) => g.missingOn.length > 0)
            .sort((p, q) => (q.soldOn[0]?.units ?? 0) - (p.soldOn[0]?.units ?? 0))
            .slice(0, i.limit);

          const reasons = [
            ...(a.incomplete ? ["missing_cost_data"] : []),
            ...(inactive.length ? [`channel_not_connected:${inactive.join(",")}`] : []),
          ];
          const note = [
            a.incomplete
              ? " Some orders are still missing cost data, so net and margin are estimates."
              : "",
            inactive.length
              ? ` ${inactive.map(label).join(", ")} ${inactive.length > 1 ? "aren't" : "isn't"} connected right now, so cross-listing gaps leave ${inactive.length > 1 ? "them" : "it"} out.`
              : "",
          ].join("");
          const when = range(cur.from, cur.to);
          const list = <T>(xs: T[], f: (x: T) => string) =>
            xs.length ? xs.map(f).join("; ") : "none";
          return {
            data: {
              period: cur,
              previousPeriod: prev,
              minUnits: MIN_UNITS,
              lowMarginBelow: LOW_MARGIN,
              rising,
              falling,
              lowMargin,
              topNet,
              crossListingGaps,
              inactiveChannels: inactive,
              incomplete: reasons.length > 0,
              incompleteReasons: reasons,
            },
            summary: `Designs ${when}: ${rising.length} rising, ${falling.length} falling, ${lowMargin.length} low margin, ${crossListingGaps.length} cross-listing gaps`,
            answer: rows.length
              ? `**Designs ${when} vs the period before.** Rising: ${list(rising, (r) => `${r.name} ${r.previousUnits} → ${r.units} units`)}. Falling: ${list(falling, (r) => `${r.name} ${r.previousUnits} → ${r.units} units`)}. Low margin (under 15%): ${list(lowMargin, (r) => `${r.name} ${pct(r.margin)} on ${r.units} units`)}. Top net profit: ${list(topNet, (r) => `${r.name} ${usd(r.net)}`)}. Cross-listing gaps: ${list(crossListingGaps, (g) => `${g.name} sells on ${label(g.soldOn[0]?.channel ?? "")} (${g.soldOn[0]?.units} units) but has no active listing on ${g.missingOn.map(label).join(", ")}`)}.${note}`
              : `No design sales ${when}.${note}`,
          };
        }),
    ),
    t(
      "get_fulfillment_health",
      "Fulfillment health for a period: on-time ship rate per channel (shipped at or before ship-by, orders shipped in the period), late shipments, median hours from placed to shipped, open orders overdue right now, reprints by reason (rate per item placed in the period and estimated cost) and refunds (count and amount, voided ones excluded) per channel. Money in cents, ratios 0..1.",
      Range.extend({ channel: z.enum(CHANNELS).optional() }),
      async (i) =>
        withTenant(ctx.companyId, async (tx) => {
          const cur = toPeriod(i.from, i.to);
          const from = new Date(cur.from);
          const to = new Date(cur.to);
          const byChannel = i.channel ? eq(orders.channel, i.channel) : undefined;
          const hours = sql`extract(epoch from (${orders.shippedAt} - ${orders.placedAt})) / 3600`;
          const shippedWhere = and(
            eq(orders.companyId, ctx.companyId),
            gte(orders.shippedAt, from),
            lt(orders.shippedAt, to),
            ne(orders.status, "cancelled"),
            byChannel,
          );
          const shipped = await tx
            .select({
              channel: orders.channel,
              shipped: sql<number>`count(*)::int`,
              onTime: sql<number>`(count(*) filter (where ${orders.shippedAt} <= ${orders.shipBy}))::int`,
              medianHours: sql<
                number | null
              >`percentile_cont(0.5) within group (order by ${hours})::float8`,
            })
            .from(orders)
            .where(shippedWhere)
            .groupBy(orders.channel);
          const [all] = await tx
            .select({
              medianHours: sql<
                number | null
              >`percentile_cont(0.5) within group (order by ${hours})::float8`,
            })
            .from(orders)
            .where(shippedWhere);
          const overdue = await tx
            .select({ channel: orders.channel, n: sql<number>`count(*)::int` })
            .from(orders)
            .where(
              and(
                eq(orders.companyId, ctx.companyId),
                inArray(orders.status, [...OPEN_STATUSES]),
                sql`${orders.shipBy} < now()`,
                byChannel,
              ),
            )
            .groupBy(orders.channel);
          const [placed] = await tx
            .select({ items: sql<number>`count(*)::int` })
            .from(orderItems)
            .innerJoin(orders, eq(orders.id, orderItems.orderId))
            .where(
              and(
                eq(orderItems.companyId, ctx.companyId),
                gte(orders.placedAt, from),
                lt(orders.placedAt, to),
                ne(orderItems.state, "cancelled"),
                byChannel,
              ),
            );
          // Estimated reprint cost: one more transfer (the item's transfer cost split over its
          // prints) plus the blank when it was ruined.
          const reprintCost = sql<number>`coalesce(sum(
            case when ${reprints.blankConsumed} then coalesce(${profitLines.blankCostCents}, 0) else 0 end
            + coalesce(${profitLines.transferCostCents}, 0) / (1 + (
              select count(*) from reprints r2
              where r2.order_item_id = ${reprints.orderItemId} and r2.status <> 'cancelled'))
          ), 0)::int`;
          const reprintRows = await tx
            .select({
              reason: reprints.reason,
              count: sql<number>`count(*)::int`,
              costCents: reprintCost,
            })
            .from(reprints)
            .innerJoin(orderItems, eq(orderItems.id, reprints.orderItemId))
            .innerJoin(orders, eq(orders.id, orderItems.orderId))
            .leftJoin(profitLines, eq(profitLines.orderItemId, reprints.orderItemId))
            .where(
              and(
                eq(reprints.companyId, ctx.companyId),
                gte(reprints.requestedAt, from),
                lt(reprints.requestedAt, to),
                ne(reprints.status, "cancelled"),
                byChannel,
              ),
            )
            .groupBy(reprints.reason);
          const refunds = await tx
            .select({
              channel: refundEvents.channel,
              count: sql<number>`count(*)::int`,
              amount: sql<number>`coalesce(sum(${refundEvents.amountCents}), 0)::int`,
            })
            .from(refundEvents)
            .where(
              and(
                eq(refundEvents.companyId, ctx.companyId),
                isNull(refundEvents.voidedAt),
                gte(refundEvents.refundedAt, from),
                lt(refundEvents.refundedAt, to),
                i.channel ? eq(refundEvents.channel, i.channel) : undefined,
              ),
            )
            .groupBy(refundEvents.channel);

          const keys = [...new Set([...shipped, ...overdue].map((r) => r.channel))];
          const channels = keys
            .map((k) => {
              const s = shipped.find((r) => r.channel === k);
              return {
                channel: k,
                shipped: s?.shipped ?? 0,
                onTime: s?.onTime ?? 0,
                late: (s?.shipped ?? 0) - (s?.onTime ?? 0),
                onTimeRate: ratio(s?.onTime ?? 0, s?.shipped ?? 0),
                medianHoursToShip: s?.medianHours ?? null,
                overdueOpenNow: overdue.find((r) => r.channel === k)?.n ?? 0,
              };
            })
            .sort((p, q) => q.shipped - p.shipped)
            .slice(0, MAX_ROWS);
          const shippedN = channels.reduce((n, c) => n + c.shipped, 0);
          const onTimeN = channels.reduce((n, c) => n + c.onTime, 0);
          const items = placed?.items ?? 0;
          const reprintList = reprintRows
            .map((r) => ({ ...r, ratePerItem: ratio(r.count, items) }))
            .sort((p, q) => q.count - p.count)
            .slice(0, MAX_ROWS);
          const reprintN = reprintList.reduce((n, r) => n + r.count, 0);
          const totals = {
            shipped: shippedN,
            onTime: onTimeN,
            late: shippedN - onTimeN,
            onTimeRate: ratio(onTimeN, shippedN),
            medianHoursToShip: all?.medianHours ?? null,
            overdueOpenNow: channels.reduce((n, c) => n + c.overdueOpenNow, 0),
            itemsPlaced: items,
            reprints: reprintN,
            reprintRate: ratio(reprintN, items),
            reprintCostCents: reprintList.reduce((n, r) => n + r.costCents, 0),
            refunds: refunds.reduce((n, r) => n + r.count, 0),
            refundAmount: refunds.reduce((n, r) => n + r.amount, 0),
          };
          const refundRows = refunds.sort((p, q) => q.amount - p.amount).slice(0, MAX_ROWS);
          const who = i.channel ? label(i.channel) : "All channels";
          const when = range(cur.from, cur.to);
          const hrs = (h: number | null) => (h == null ? "n/a" : `${h.toFixed(1)} h`);
          return {
            data: { period: cur, totals, channels, reprints: reprintList, refunds: refundRows },
            summary: `${who} ${when}: ${pct(totals.onTimeRate)} on time, ${totals.overdueOpenNow} overdue now, ${totals.reprints} reprints`,
            answer: `**${who}, ${when}: ${pct(totals.onTimeRate)} shipped on time** (${totals.onTime} of ${totals.shipped}, ${totals.late} late), median ${hrs(totals.medianHoursToShip)} from order to ship. ${totals.overdueOpenNow} open orders are overdue right now.${
              channels.length > 1
                ? ` By channel: ${channels.map((c) => `${label(c.channel)} ${pct(c.onTimeRate)} on time, ${c.overdueOpenNow} overdue`).join("; ")}.`
                : ""
            } Reprints: ${totals.reprints} (${pct(totals.reprintRate)} of ${items} items, about ${usd(totals.reprintCostCents)})${
              reprintList.length
                ? `: ${reprintList.map((r) => `${r.reason.replace(/_/g, " ")} ${r.count}`).join(", ")}`
                : ""
            }. Refunds: ${totals.refunds} for ${usd(totals.refundAmount)}${
              refundRows.length
                ? ` (${refundRows.map((r) => `${label(r.channel)} ${r.count} for ${usd(r.amount)}`).join("; ")})`
                : ""
            }.`,
          };
        }),
    ),
    // Wave 18 market tools (T-18-4).
    ...marketTools(ctx),
  ];
}

/* ------------------------------ market tools (T-18-4) ------------------------------ */

/*
 * Wave 18 (spec market-signals "Assistant tools"). Read-only: each tool reads stored signals and
 * recommendations through the market service (T-18-3) inside the caller's `withTenant`; nothing
 * here calls a provider or writes a row (the one write, "shown", is `recordRecommendationsShown`,
 * called once per turn by `ask`). Data is whitelisted field by field, so nothing beyond the
 * contract's aggregate fields (no seller names, no listing titles) can reach the model. Money is
 * cents in `data`, formatted in `answer`; `answer` is the fixed, code-written text in the user's
 * language, which the gateway's answer check falls back to.
 */

/** Recommendations one market tool may show (contract `tool_result.recommendations` max 3). */
export const MARKET_REC_MAX = 3;
/** Designs a shop-wide market answer looks at when no design or niche is named. */
const MARKET_TOP_DESIGNS = 8;
/** Candidate prices `simulate_price` accepts (spec). */
export const SIMULATE_MAX_PRICES = 8;

const Lang = z
  .enum(["en", "es"])
  .optional()
  .describe('"es" when the user writes Spanish, else "en"');
const Subject = {
  designId: z
    .uuid()
    .optional()
    .describe("One of the shop's design ids, from an earlier tool result"),
  niche: z
    .string()
    .max(80)
    .optional()
    .describe("A niche key or name (teacher, dog-mom, halloween) when the user names a niche"),
};

type DesignRef = { id: string; name: string };
type Target = { label: string; input: market.Subject; design: DesignRef | null };
type NicheResolution =
  | { kind: "key"; key: string; label: string }
  | { kind: "dropped"; term: string }
  | { kind: "unknown" };

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Taxonomy key, or the trademark screen's verdict for a term that isn't one. */
async function resolveNiche(companyId: string, raw: string, lang: Lang2): Promise<NicheResolution> {
  // "Teacher", "teachers" and "Dog moms" all name a niche whose label is plural.
  const one = (x: string) => x.replace(/(?<=\w\w)s\b/g, "");
  const f = one(
    fold(raw)
      .replace(/\bniche\b|\bnicho\b/g, "")
      .trim(),
  );
  const hit = market.NICHES.find((n) =>
    [n.key, n.labelEn, n.labelEs].some((x) => one(fold(x)) === f),
  );
  if (hit) return { kind: "key", key: hit.key, label: lang === "es" ? hit.labelEs : hit.labelEn };
  const { droppedCount } = await screenMarketTerms(companyId, [raw]);
  return droppedCount > 0 ? { kind: "dropped", term: raw } : { kind: "unknown" };
}
type Lang2 = "en" | "es";

/** The shop's best-selling designs over 90 days (own catalog rows only), with their top channel. */
async function topDesigns(tx: Tx, companyId: string, limit: number, channel?: Channel) {
  const since = new Date(Date.now() - 90 * 86_400_000);
  const sold = await tx
    .select({
      designId: sql<string>`${profitLines.designId}::text`,
      channel: profitLines.channel,
      units: sql<number>`count(*)::int`,
    })
    .from(profitLines)
    .where(
      and(
        eq(profitLines.companyId, companyId),
        gte(profitLines.placedAt, since),
        isNotNull(profitLines.designId),
        eq(profitLines.isReprint, false),
        channel ? eq(profitLines.channel, channel) : undefined,
      ),
    )
    .groupBy(profitLines.designId, profitLines.channel);
  const byDesign = new Map<string, { units: number; channel: Channel; best: number }>();
  for (const r of sold) {
    const cur = byDesign.get(r.designId) ?? { units: 0, channel: r.channel as Channel, best: 0 };
    cur.units += r.units;
    if (r.units > cur.best) Object.assign(cur, { channel: r.channel, best: r.units });
    byDesign.set(r.designId, cur);
  }
  const ranked = [...byDesign.entries()].sort((a, b) => b[1].units - a[1].units).slice(0, limit);
  const ids = ranked.map(([id]) => id);
  const rows = ids.length
    ? await tx
        .select({ id: sql<string>`${designs.id}::text`, name: designs.name })
        .from(designs)
        .where(and(eq(designs.companyId, companyId), inArray(designs.id, ids)))
    : await tx
        .select({ id: sql<string>`${designs.id}::text`, name: designs.name })
        .from(designs)
        .where(and(eq(designs.companyId, companyId), eq(designs.status, "active")))
        .orderBy(sql`${designs.createdAt} desc`)
        .limit(limit);
  const order = (id: string) => (ids.includes(id) ? ids.indexOf(id) : ids.length);
  return rows
    .sort((a, b) => order(a.id) - order(b.id))
    .map((d) => ({ ...d, channel: byDesign.get(d.id)?.channel ?? null }));
}

async function designById(tx: Tx, companyId: string, id: string): Promise<DesignRef | null> {
  const [d] = await tx
    .select({ id: sql<string>`${designs.id}::text`, name: designs.name })
    .from(designs)
    .where(and(eq(designs.companyId, companyId), eq(designs.id, id)));
  return d ?? null;
}

const sourceRef = (p: { source: SignalSourceRef["source"]; asOf: string; mock: boolean }) => ({
  source: p.source,
  asOf: p.asOf,
  mock: p.mock,
});

function uniqueSources(list: SignalSourceRef[]): SignalSourceRef[] {
  const seen = new Set<string>();
  return list
    .filter((s) => {
      const k = `${s.source}|${s.asOf}|${s.mock}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, MAX_ROWS);
}

const signedRatio = (v: number | null) =>
  v == null ? null : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`;

const TREND_WORD: Record<string, Record<Lang2, string>> = {
  rising: { en: "rising", es: "subiendo" },
  falling: { en: "falling", es: "bajando" },
  flat: { en: "flat", es: "estable" },
  insufficient: { en: "not enough data", es: "no hay suficientes datos" },
};
const INSUFFICIENT: Record<string, Record<Lang2, string>> = {
  too_few_points: {
    en: "fewer than 13 weekly points",
    es: "menos de 13 semanas de datos",
  },
  mostly_zero: { en: "no sales in most weeks", es: "sin ventas en la mayoría de las semanas" },
  no_source: { en: "no data source yet", es: "todavía no hay fuente de datos" },
};
const UNAVAILABLE: Record<string, Record<Lang2, string>> = {
  no_compliant_source: {
    en: "There's no approved price source for {{channel}} yet.",
    es: "Todavía no hay una fuente de precios aprobada para {{channel}}.",
  },
  not_connected: {
    en: "{{channel}} isn't connected, so I can't compare prices there.",
    es: "{{channel}} no está conectado, así que no puedo comparar precios ahí.",
  },
  too_few_comparables: {
    en: "I need at least 8 comparable listings on {{channel}} to place your price, and there are fewer.",
    es: "Necesito por lo menos 8 publicaciones comparables en {{channel}} para ubicar tu precio, y hay menos.",
  },
};

/** One recommendation as the model and the fallback see it: the fixed action text, band, sample note. */
function recLine(r: MarketRecommendation, lang: Lang2) {
  const p = r.params;
  const niche = p.niche ?? r.target.niche;
  const nicheLabelText = niche ? market.nicheLabel(niche, lang) : "";
  const hasChannels = (p.channels ?? []).length > 0;
  const template =
    r.rule === "R1" && !(hasChannels && p.blankName)
      ? R1_PARTIAL[hasChannels ? "listOnly" : p.blankName ? "stockOnly" : "prepOnly"][lang]
      : RULE_ACTION[r.rule][lang];
  const action = fill(template, {
    design: p.designName ?? r.target.designName ?? "",
    channels: (p.channels ?? []).map(channelLabel).join(", "),
    blank: p.blankName ?? (lang === "es" ? "la prenda" : "the blank"),
    peak: p.peakMonth ? monthName(p.peakMonth, lang) : "",
    price: money(p.testPriceMinCents ?? p.testPriceMaxCents ?? p.currentPriceCents ?? 0),
    channel: channelLabel(p.channel ?? r.target.channel ?? ""),
    floor: money(p.floorPriceCents ?? 0),
    niche: nicheLabelText,
  });
  const evidence = r.sources.slice(0, 3).map((s) => sourceLine(s, lang));
  return {
    id: r.id,
    rule: r.rule,
    band: r.band,
    bandLabel: BAND_COPY[r.band][lang],
    mock: r.mock,
    stale: r.stale,
    action,
    evidence,
    sampleNote: r.mock ? MARKET_COPY.sample[lang] : null,
    text: `${action} ${evidence.length ? `(${evidence.join("; ")}) ` : ""}${BAND_COPY[r.band][lang]}.${r.mock ? ` ${MARKET_COPY.sample[lang]}` : ""}`,
  };
}

/** Recommendations for this tool: its rules, its subject, medium band or better, at most 3. */
async function recsFor(
  tx: Tx,
  ctx: TenantContext,
  rules: MarketRecommendation["rule"][],
  subject: { designIds?: string[]; niche?: string },
) {
  // Read enough to filter from (the service caps the list at 200); at most 3 are shown.
  const all = await market.listRecommendations(tx, ctx, { minBand: "medium", limit: 100 });
  const niches = new Map<string, string[]>();
  /** A design's niches (mapper or shop correction); R1..R3 and R5 are per design, not per niche. */
  const nichesOf = async (designId: string) => {
    if (!niches.has(designId))
      niches.set(
        designId,
        await market
          .getDesignNiches(tx, ctx, { designId })
          .then((d) => d.niches)
          .catch(() => []),
      );
    return niches.get(designId) ?? [];
  };
  const out: MarketRecommendation[] = [];
  for (const r of all) {
    if (out.length >= MARKET_REC_MAX) break;
    if (!rules.includes(r.rule) || r.band === "low") continue;
    const designId = r.target.designId;
    const fits = subject.niche
      ? (r.params.niche ?? r.target.niche) === subject.niche ||
        (designId != null && (await nichesOf(designId)).includes(subject.niche))
      : subject.designIds
        ? designId != null && subject.designIds.includes(designId)
        : true;
    if (fits) out.push(r);
  }
  return out;
}

function marketOutput(
  base: { data: Record<string, unknown>; summary: string; answer: string },
  rows: { mock: boolean; sources: SignalSourceRef[] }[],
  recs: MarketRecommendation[],
  lang: Lang2,
): ToolOutput {
  const lines = recs.map((r) => recLine(r, lang));
  const mock = rows.some((r) => r.mock) || recs.some((r) => r.mock);
  const recText = lines.length
    ? `\n\n${lang === "es" ? "Recomendaciones" : "Recommendations"}:\n${lines.map((l, i) => `${i + 1}. ${l.text}`).join("\n")}`
    : "";
  return {
    data: { ...base.data, recommendations: lines.map(({ text: _t, ...l }) => l) },
    summary: base.summary,
    answer: `${base.answer}${recText}`,
    meta: {
      mock,
      sources: uniqueSources(rows.flatMap((r) => r.sources)),
      recommendations: recs.map((r) => ({ id: r.id, rule: r.rule, band: r.band, mock: r.mock })),
    },
  };
}

function marketFailure(tool: string, err: unknown, lang: Lang2): ToolOutput {
  const notFound = err instanceof ORPCError && err.code === "NOT_FOUND";
  if (!notFound) log.warn("market tool failed", { tool, error: (err as Error).message });
  const answer = notFound
    ? lang === "es"
      ? "No encontré ese diseño en tu tienda."
      : "I couldn't find that design in your shop."
    : lang === "es"
      ? "Los datos del mercado no están disponibles ahora. Intenta de nuevo en un rato."
      : "Market data isn't available right now. Try again in a little while.";
  return {
    data: { error: notFound ? "not_found" : "unavailable" },
    summary: `${tool}: ${notFound ? "not found" : "unavailable"}`,
    answer,
    meta: { mock: false, sources: [], recommendations: [] },
  };
}

function nicheRefusal(tool: string, r: NicheResolution, lang: Lang2): ToolOutput {
  const dropped = r.kind === "dropped";
  return {
    data: {
      available: false,
      reason: dropped ? "trademark_screen" : "unknown_niche",
      rows: [],
    },
    summary: `${tool}: ${dropped ? "niche not available" : "unknown niche"}`,
    answer: dropped ? MARKET_COPY.tmDropped[lang] : MARKET_COPY.unknownNiche[lang],
    meta: { mock: false, sources: [], recommendations: [] },
    forbiddenTerms: dropped ? [r.term] : undefined,
  };
}

function marketTools(ctx: TenantContext): AssistantTool[] {
  const tool = <I extends z.ZodObject>(
    name: string,
    description: string,
    input: I,
    run: (i: z.infer<I>, lang: Lang2) => Promise<ToolOutput>,
  ): AssistantTool => ({
    name,
    description,
    input,
    run: async (raw) => {
      const i = input.parse(raw);
      const lang: Lang2 = (i as { lang?: Lang2 }).lang ?? "en";
      try {
        return await run(i, lang);
      } catch (err) {
        return marketFailure(name, err, lang);
      }
    },
  });

  /** designId → that design; niche → the niche; neither → the shop's top designs. */
  async function subjects(
    tx: Tx,
    i: { designId?: string; niche?: string },
    lang: Lang2,
  ): Promise<
    | { kind: "designs"; designs: (DesignRef & { channel: Channel | null })[] }
    | { kind: "niche"; key: string; label: string }
    | { kind: "refused"; out: NicheResolution }
  > {
    if (i.designId) {
      const d = await designById(tx, ctx.companyId, i.designId);
      if (!d) throw new ORPCError("NOT_FOUND", { message: "design not found" });
      const [top] = await topDesigns(tx, ctx.companyId, 50).then((all) =>
        all.filter((x) => x.id === d.id),
      );
      return { kind: "designs", designs: [{ ...d, channel: top?.channel ?? null }] };
    }
    if (i.niche) {
      const r = await resolveNiche(ctx.companyId, i.niche, lang);
      return r.kind === "key"
        ? { kind: "niche", key: r.key, label: r.label }
        : { kind: "refused", out: r };
    }
    return { kind: "designs", designs: await topDesigns(tx, ctx.companyId, MARKET_TOP_DESIGNS) };
  }

  return [
    tool(
      "get_market_trend",
      "Market trend for one of the shop's designs, a niche, or (with neither) the shop's top designs: trend class (rising, falling, flat, insufficient), 4-week growth and year-over-year as ratios per source with source, date and a mock flag, confidence band, a disagreement flag when own sales and outside interest differ, stale flag, and up to 3 recommendations with fixed actions. Reads stored signals only.",
      z.object({ ...Subject, lang: Lang }),
      (i, lang) =>
        withTenant(ctx.companyId, async (tx) => {
          const subj = await subjects(tx, i, lang);
          if (subj.kind === "refused") return nicheRefusal("get_market_trend", subj.out, lang);
          const targets: Target[] =
            subj.kind === "niche"
              ? [{ label: subj.label, input: { niche: subj.key }, design: null }]
              : subj.designs.map((d) => ({ label: d.name, input: { designId: d.id }, design: d }));
          const rows = await inOrder(targets.slice(0, MAX_ROWS), async (t) => {
            const s = await market.getTrendSignal(tx, ctx, t.input);
            return {
              design: t.design ? { id: t.design.id, name: t.design.name } : null,
              niche: subj.kind === "niche" ? subj.key : (s.subject.niche ?? null),
              label: t.label,
              trend: s.trend,
              growth4w: s.growth4w,
              yoy: s.yoy,
              windowWeeks: s.windowWeeks,
              disagreement: s.disagreement,
              insufficientReason: s.insufficientReason,
              confidence: s.confidence,
              band: s.band,
              stale: s.stale,
              mock: s.mock,
              readings: s.readings.slice(0, 6).map((r) => ({
                source: r.provenance.source,
                asOf: r.provenance.asOf,
                mock: r.provenance.mock,
                trend: r.trend,
                growth4w: r.growth4w,
                yoy: r.yoy,
                n: r.n,
                insufficientReason: r.insufficientReason,
              })),
              sources: s.sources.map(sourceRef),
            };
          });
          const recs = await recsFor(tx, ctx, ["R4", "R5"], {
            niche: subj.kind === "niche" ? subj.key : undefined,
            designIds: subj.kind === "designs" ? subj.designs.map((d) => d.id) : undefined,
          });
          const line = (r: (typeof rows)[number]) => {
            if (r.trend === "insufficient")
              return `**${r.label}**: ${MARKET_COPY.notEnough[lang]} (${INSUFFICIENT[r.insufficientReason ?? "no_source"]?.[lang] ?? ""}).`;
            const g = signedRatio(r.growth4w);
            const y = signedRatio(r.yoy);
            const head = `**${r.label}**: ${TREND_WORD[r.trend]?.[lang]}${g ? `, ${g} ${lang === "es" ? "en 4 semanas" : "over 4 weeks"}` : ""}${y ? `, ${y} ${lang === "es" ? "contra el año pasado" : "year over year"}` : ""} (${BAND_COPY[r.band][lang]}).`;
            const readings = r.readings
              .map(
                (x) =>
                  `${sourceLine(x, lang)}: ${TREND_WORD[x.trend]?.[lang]}${x.growth4w != null ? ` ${signedRatio(x.growth4w)}` : ""}`,
              )
              .join("; ");
            return [
              head,
              readings ? `${readings}.` : "",
              r.disagreement ? MARKET_COPY.disagreeNote[lang] : "",
              r.stale ? MARKET_COPY.staleNote[lang] : "",
            ]
              .filter(Boolean)
              .join(" ");
          };
          const counts = ["rising", "falling", "flat", "insufficient"].map(
            (c) => rows.filter((r) => r.trend === c).length,
          );
          return marketOutput(
            {
              data: { rows, lang },
              summary: `Market trend: ${counts[0]} rising, ${counts[1]} falling, ${counts[2]} flat, ${counts[3]} not enough data`,
              answer: rows.length
                ? rows.map(line).join("\n")
                : lang === "es"
                  ? "Todavía no tienes diseños con ventas para medir."
                  : "You don't have designs with sales to measure yet.",
            },
            rows,
            recs,
            lang,
          );
        }),
    ),
    tool(
      "get_seasonality",
      "Seasonality for one of the shop's designs, a niche, or (with neither) the shop's top designs: monthly index (1.0 = average month), peak and off months, the act-by date from the shop's lead time, which series the index came from (own, outside, or the Census prior for all US clothing stores), source and date, stale and mock flags, and up to 3 seasonal-prep recommendations. Reads stored signals only.",
      z.object({ ...Subject, lang: Lang }),
      (i, lang) =>
        withTenant(ctx.companyId, async (tx) => {
          const subj = await subjects(tx, i, lang);
          if (subj.kind === "refused") return nicheRefusal("get_seasonality", subj.out, lang);
          const targets: Target[] =
            subj.kind === "niche"
              ? [{ label: subj.label, input: { niche: subj.key }, design: null }]
              : subj.designs.map((d) => ({ label: d.name, input: { designId: d.id }, design: d }));
          const rows = await inOrder(targets.slice(0, MAX_ROWS), async (t) => {
            const s = await market.getSeasonalitySignal(tx, ctx, t.input);
            return {
              design: t.design ? { id: t.design.id, name: t.design.name } : null,
              niche: subj.kind === "niche" ? subj.key : (s.subject.niche ?? null),
              label: t.label,
              index: s.index.map((m) => ({ month: m.month, index: m.index })),
              peakMonths: s.peakMonths,
              offMonths: s.offMonths,
              indexSource: s.indexSource,
              actBy: s.actBy,
              yearsUsed: s.yearsUsed,
              confidence: s.confidence,
              band: s.band,
              stale: s.stale,
              mock: s.mock,
              sources: s.sources.map(sourceRef),
            };
          });
          const recs = await recsFor(tx, ctx, ["R1"], {
            niche: subj.kind === "niche" ? subj.key : undefined,
            designIds: subj.kind === "designs" ? subj.designs.map((d) => d.id) : undefined,
          });
          const months = (ms: number[]) => ms.map((m) => monthName(m, lang)).join(", ");
          const line = (r: (typeof rows)[number]) => {
            if (!r.indexSource || !r.index.length)
              return `**${r.label}**: ${MARKET_COPY.notEnough[lang]}.`;
            const from =
              r.indexSource === "census_prior"
                ? MARKET_COPY.seasonCensus[lang]
                : r.indexSource === "own"
                  ? lang === "es"
                    ? "tus propias ventas"
                    : "your own sales"
                  : lang === "es"
                    ? "interés de afuera"
                    : "outside interest";
            const src = r.sources.map((x) => sourceLine(x, lang)).join("; ");
            const peak = r.peakMonths.length
              ? `${lang === "es" ? "temporada alta en" : "peaks in"} ${months(r.peakMonths)}`
              : lang === "es"
                ? "sin un mes pico claro"
                : "no clear peak month";
            const off = r.offMonths.length
              ? `; ${lang === "es" ? "meses bajos" : "off months"}: ${months(r.offMonths)}`
              : "";
            const act = r.actBy
              ? ` ${lang === "es" ? "Actúa antes del" : "Act by"} ${r.actBy.date}: ${weeks(Math.round(r.actBy.weeksToPeak), lang)} ${lang === "es" ? "al pico, tu tiempo de producción es de" : "to the peak, your lead time is"} ${weeks(Math.round(r.actBy.leadTimeWeeks), lang)}.${r.actBy.actNow ? (lang === "es" ? " Hazlo ya." : " Act now.") : ""}`
              : "";
            return [
              `**${r.label}**: ${peak}${off} (${from}; ${src}; ${BAND_COPY[r.band][lang]}).${act}`,
              r.stale ? MARKET_COPY.staleNote[lang] : "",
            ]
              .filter(Boolean)
              .join(" ");
          };
          return marketOutput(
            {
              data: { rows, lang },
              summary: `Seasonality: ${rows.filter((r) => r.peakMonths.length).length} of ${rows.length} with a peak, ${rows.filter((r) => r.actBy?.actNow).length} to act on now`,
              answer: rows.length
                ? rows.map(line).join("\n")
                : lang === "es"
                  ? "Todavía no tienes diseños para revisar."
                  : "You don't have designs to check yet.",
            },
            rows,
            recs,
            lang,
          );
        }),
    ),
    tool(
      "get_price_position",
      "Where one design's price sits among comparable listings on a channel: percentile (0..1), band (low, market, premium), Q1, median and Q3 in cents, the number of comparables, source and date, mock flag. Without a designId it uses the shop's best-selling design on that channel; without a channel, that design's main channel. `available: false` with a reason when no approved price source exists (Etsy, TikTok, Shopify), the channel isn't connected, or there are fewer than 8 comparables.",
      z.object({
        designId: Subject.designId,
        channel: z.enum(CHANNELS).optional(),
        lang: Lang,
      }),
      (i, lang) =>
        withTenant(ctx.companyId, async (tx) => {
          const d = await pickDesign(tx, i.designId, i.channel);
          if (!d) return noDesigns("get_price_position", lang);
          const p = await market.getPricePosition(tx, ctx, { designId: d.id, channel: d.channel });
          const ch = channelLabel(d.channel);
          const base = {
            design: { id: d.id, name: d.name },
            channel: d.channel,
            available: p.available,
            currentPriceCents: p.currentPriceCents,
            n: p.n,
            confidence: p.confidence,
            band: p.band,
            stale: p.stale,
            mock: p.mock,
            sources: p.sources.map(sourceRef),
          };
          const recs = p.available ? await recsFor(tx, ctx, ["R2"], { designIds: [d.id] }) : [];
          const src = base.sources.map((x) => sourceLine(x, lang)).join("; ");
          if (!p.available)
            return marketOutput(
              {
                data: { ...base, reason: p.reason },
                summary: `${d.name} on ${ch}: no price position (${p.reason.replace(/_/g, " ")})`,
                answer: `**${d.name}, ${ch}**: ${fill(UNAVAILABLE[p.reason]?.[lang] ?? "", { channel: ch })}`,
              },
              [base],
              recs,
              lang,
            );
          const bandWord = {
            low: { en: "low", es: "bajo" },
            market: { en: "market", es: "de mercado" },
            premium: { en: "premium", es: "alto" },
          }[p.priceBand][lang];
          return marketOutput(
            {
              data: {
                ...base,
                percentile: p.percentile,
                priceBand: p.priceBand,
                q1Cents: p.q1Cents,
                medianCents: p.medianCents,
                q3Cents: p.q3Cents,
                featuredPriceCents: p.featuredPriceCents,
                density: p.density,
              },
              summary: `${d.name} on ${ch}: ${p.priceBand} price band, ${p.n} comparables`,
              answer:
                lang === "es"
                  ? `**${d.name}, ${ch}**: tu precio ${p.currentPriceCents != null ? money(p.currentPriceCents) : ""} está en el percentil ${Math.round(p.percentile * 100)} de ${p.n} publicaciones comparables (rango ${bandWord}). Q1 ${money(p.q1Cents)}, mediana ${money(p.medianCents)}, Q3 ${money(p.q3Cents)}. ${src}. ${BAND_COPY[p.band][lang]}.${p.stale ? ` ${MARKET_COPY.staleNote[lang]}` : ""}`
                  : `**${d.name}, ${ch}**: your price ${p.currentPriceCents != null ? money(p.currentPriceCents) : ""} sits at the ${Math.round(p.percentile * 100)}th percentile of ${p.n} comparable listings (${bandWord} band). Q1 ${money(p.q1Cents)}, median ${money(p.medianCents)}, Q3 ${money(p.q3Cents)}. ${src}. ${BAND_COPY[p.band][lang]}.${p.stale ? ` ${MARKET_COPY.staleNote[lang]}` : ""}`,
            },
            [base],
            recs,
            lang,
          );
        }),
    ),
    tool(
      "simulate_price",
      "Margin at candidate prices for one design on a channel, from the shop's own trailing 90-day costs: per price the net per unit (cents) and margin %, break-even price, floor price (lowest price with at least 15% margin), and a price-response estimate or null (volume effect unknown). Optional `prices` in cents, at most 8. Without a designId it uses the shop's best-selling design; without a channel, that design's main channel. `incomplete` lists missing cost lines.",
      z.object({
        designId: Subject.designId,
        channel: z.enum(CHANNELS).optional(),
        prices: z
          .array(z.number().int().positive().max(1_000_000))
          .max(SIMULATE_MAX_PRICES)
          .optional()
          .describe("Candidate prices in cents, at most 8"),
        lang: Lang,
      }),
      (i, lang) =>
        withTenant(ctx.companyId, async (tx) => {
          const d = await pickDesign(tx, i.designId, i.channel);
          if (!d) return noDesigns("simulate_price", lang);
          const s = await market.simulatePrice(tx, ctx, {
            designId: d.id,
            channel: d.channel,
            prices: i.prices,
          });
          const ch = channelLabel(d.channel);
          const rows = s.candidates.slice(0, MAX_ROWS).map((c) => ({
            priceCents: c.priceCents,
            origin: c.origin,
            netPerUnitCents: c.netPerUnitCents,
            marginPct: c.marginPct,
            estimatedWeeklyUnits: c.estimatedWeeklyUnits,
            estimatedWeeklyNetCents: c.estimatedWeeklyNetCents,
          }));
          const base = {
            design: { id: d.id, name: d.name },
            channel: d.channel,
            currentPriceCents: s.currentPriceCents,
            breakEvenCents: s.breakEvenCents,
            floorPriceCents: s.floorPriceCents,
            floorMarginPct: s.floorMarginPct,
            priceResponse: s.priceResponse,
            incomplete: s.incomplete,
            missing: s.missing,
            costBasis: s.costBasis,
            rows,
            confidence: s.confidence,
            band: s.band,
            stale: s.stale,
            mock: s.mock,
            sources: s.sources.map(sourceRef),
          };
          const recs = await recsFor(tx, ctx, ["R3"], { designIds: [d.id] });
          const table = rows
            .map(
              (r) =>
                `${money(r.priceCents)}: ${lang === "es" ? "neto" : "net"} ${money(r.netPerUnitCents)} ${lang === "es" ? "por unidad" : "per unit"}, ${r.marginPct.toFixed(1)}% ${lang === "es" ? "de margen" : "margin"}`,
            )
            .join("; ");
          const floor =
            s.floorPriceCents != null
              ? ` ${lang === "es" ? "Precio mínimo" : "Floor price"} (${s.floorMarginPct.toFixed(1)}% ${lang === "es" ? "de margen" : "margin"}): ${money(s.floorPriceCents)}.`
              : "";
          const breakEven =
            s.breakEvenCents != null
              ? ` ${lang === "es" ? "Punto de equilibrio" : "Break-even"}: ${money(s.breakEvenCents)}.`
              : "";
          const volume = s.priceResponse
            ? ` ${MARKET_COPY.estimate[lang]}: ${lang === "es" ? "elasticidad" : "elasticity"} ${s.priceResponse.elasticity.toFixed(2)}.`
            : ` (${MARKET_COPY.volumeUnknown[lang]})`;
          const missing = s.incomplete
            ? ` ${lang === "es" ? "Faltan costos" : "Some costs are missing"} (${s.missing.join(", ").replace(/_/g, " ")}), ${lang === "es" ? "así que son estimaciones" : "so these are estimates"}.`
            : "";
          return marketOutput(
            {
              data: { ...base, lang },
              summary: `${d.name} on ${ch}: ${rows.length} prices simulated${s.floorPriceCents != null ? `, floor ${money(s.floorPriceCents)}` : ""}`,
              answer: `**${d.name}, ${ch}** (${lang === "es" ? "tus costos de 90 días" : "your 90-day costs"}): ${table}.${breakEven}${floor}${volume}${missing}`,
            },
            [base],
            recs,
            lang,
          );
        }),
    ),
  ];

  /** The named design (with its main channel), or the shop's best seller on `channel`. */
  async function pickDesign(tx: Tx, designId?: string, channel?: Channel) {
    if (designId) {
      const d = await designById(tx, ctx.companyId, designId);
      if (!d) throw new ORPCError("NOT_FOUND", { message: "design not found" });
      const main = (await topDesigns(tx, ctx.companyId, 50)).find((x) => x.id === d.id);
      return { ...d, channel: channel ?? main?.channel ?? ("etsy" as Channel) };
    }
    const [top] = await topDesigns(tx, ctx.companyId, 1, channel);
    if (!top) return null;
    return { id: top.id, name: top.name, channel: channel ?? top.channel ?? ("etsy" as Channel) };
  }
}

/** Runs `f` over `xs` one at a time (they share one transaction). */
async function inOrder<T, R>(xs: T[], f: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (const x of xs) out.push(await f(x));
  return out;
}

function noDesigns(tool: string, lang: "en" | "es"): ToolOutput {
  return {
    data: { available: false, reason: "no_designs", rows: [] },
    summary: `${tool}: no designs with sales`,
    answer:
      lang === "es"
        ? "Todavía no tienes diseños con ventas en ese canal."
        : "You don't have designs with sales on that channel yet.",
    meta: { mock: false, sources: [], recommendations: [] },
  };
}
