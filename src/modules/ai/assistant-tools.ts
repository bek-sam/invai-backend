import { CHANNEL_RULES, CHANNELS, type Channel } from "@invai/contracts";
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { z } from "zod";
import type { AssistantTool, ToolOutput } from "../../ai/providers/types";
import type { TenantContext } from "../../api/context";
import { withTenant } from "../../db/client";
import { designs, gangSheets, orderItems, orders } from "../../db/schema";
import { getProfit } from "../finance/service";
import { listStock } from "../inventory/service";

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
    run: (raw) => run(input.parse(raw)),
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
  ];
}
