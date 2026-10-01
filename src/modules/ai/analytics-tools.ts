import {
  CHANNEL_RULES,
  CHANNELS,
  type Channel,
  type LateDriverRow,
  SHIPPING_MARGIN_GROUPS,
} from "@invai/contracts";
import { z } from "zod";
import type { AssistantTool, ToolOutput } from "../../ai/providers/types";
import type { TenantContext } from "../../api/context";
import { withTenant } from "../../db/client";
import { profitBridge, shippingMargin, unitEconomics } from "../analytics/finance-service";
import { inventoryHealth } from "../analytics/inventory-service";
import { getOperations } from "../analytics/operations-service";

/*
 * Assistant tools v6 (T-A8, spec business-analytics-v2 Track E). Thin read-only wrappers over the
 * `analytics.*` services, so the assistant states the same number as the screens (AC-G1). Each
 * opens its own `withTenant` with the caller's context, returns at most V6_MAX_ROWS rows per list,
 * names the metric its numbers come from, and never carries buyer data (orders appear only as the
 * shop's own order numbers in `get_unit_economics` by order). Registered only for callers with
 * `finance.read`, the permission every `analytics.*` procedure requires.
 */

export const V6_TOOLS = [
  "get_unit_economics",
  "explain_profit_change",
  "get_operations_health",
  "get_inventory_health",
  "get_shipping_insights",
] as const;
export const V6_MAX_ROWS = 20;

type Lang = "en" | "es";
type Wrap = <I extends z.ZodObject>(
  name: string,
  description: string,
  input: I,
  run: (i: z.infer<I>) => Promise<ToolOutput>,
) => AssistantTool;

const LangIn = z
  .enum(["en", "es"])
  .default("en")
  .describe('"es" when the user writes Spanish, else "en". Labels in the answer follow it.');
const Range = z.object({
  from: z.string().describe("Period start, ISO 8601 timestamp"),
  to: z.string().describe("Period end (exclusive), ISO 8601 timestamp"),
});
const iso = (s: string) => new Date(s).toISOString();

const usd = (cents: number) =>
  `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const signed = (c: number) => `${c >= 0 ? "+" : "-"}${usd(Math.abs(c))}`;
const pctOf = (v: number | null, lang: Lang) =>
  v == null ? (lang === "es" ? "sin datos suficientes" : "not enough data") : `${v.toFixed(1)}%`;
const chan = (c: string) => CHANNEL_RULES[c as Channel]?.label ?? c;
const day = (isoTs: string, lang: Lang) =>
  new Date(isoTs).toLocaleDateString(lang === "es" ? "es-MX" : "en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
const span = (p: { from: string; to: string }, lang: Lang) =>
  `${day(p.from, lang)} – ${day(new Date(Date.parse(p.to) - 1).toISOString(), lang)}`;
const cap = <T>(xs: readonly T[], n = 10): T[] => xs.slice(0, Math.min(n, V6_MAX_ROWS));

const COST_LINE: Record<string, Record<Lang, string>> = {
  channelFees: { en: "Channel fees", es: "Comisiones del canal" },
  blankCost: { en: "Blanks", es: "Prendas lisas" },
  transferCost: { en: "Transfers", es: "Transfers" },
  labelCost: { en: "Shipping labels", es: "Etiquetas de envío" },
  packagingCost: { en: "Packaging", es: "Empaque" },
  laborCost: { en: "Labor", es: "Mano de obra" },
  adsCost: { en: "Ads", es: "Anuncios" },
  refunds: { en: "Refunds", es: "Reembolsos" },
};
const STATE: Record<string, Record<Lang, string>> = {
  imported: { en: "Imported", es: "Importado" },
  needs_mapping: { en: "Needs SKU mapping", es: "Falta asignar SKU" },
  ready: { en: "Ready to print", es: "Listo para imprimir" },
  needs_artwork: { en: "Needs artwork", es: "Falta el diseño" },
  on_sheet: { en: "On a gang sheet", es: "En la hoja" },
  transfer_in: { en: "Transfer received", es: "Transfer recibido" },
  pressed: { en: "Pressed", es: "Planchado" },
  packed: { en: "Packed", es: "Empacado" },
  shipped: { en: "Shipped", es: "Enviado" },
  delivered: { en: "Delivered", es: "Entregado" },
  on_hold: { en: "On hold", es: "En pausa" },
  cancelled: { en: "Cancelled", es: "Cancelado" },
};
const REASON: Record<string, Record<Lang, string>> = {
  misprint: { en: "Misprint", es: "Mala impresión" },
  peel: { en: "Peeling", es: "Se despega" },
  ghosting: { en: "Ghosting", es: "Imagen doble" },
  color_off: { en: "Color off", es: "Color incorrecto" },
  wrong_placement: { en: "Wrong placement", es: "Posición incorrecta" },
  transfer_damaged: { en: "Transfer damaged", es: "Transfer dañado" },
  blank_damaged: { en: "Blank damaged", es: "Prenda dañada" },
  wrong_blank: { en: "Wrong blank", es: "Prenda equivocada" },
  press_error: { en: "Press error", es: "Error de planchado" },
  customer_request: { en: "Customer request", es: "Pedido del cliente" },
  lost: { en: "Lost", es: "Perdido" },
  other: { en: "Other", es: "Otro" },
  under_cure: { en: "Under-cured", es: "Mal curado" },
  cracking: { en: "Cracking", es: "Agrietado" },
};
const tr = (m: Record<string, Record<Lang, string>>, k: string, lang: Lang, fallback = k) =>
  m[k]?.[lang] ?? fallback;

function driverLabel(r: LateDriverRow, lang: Lang): string {
  if (r.driver === "channel") return chan(r.value);
  const yes = r.value === "yes";
  const L: Record<string, Record<Lang, [string, string]>> = {
    personalized: {
      en: ["Personalized", "Not personalized"],
      es: ["Personalizados", "Sin personalizar"],
    },
    rush: { en: ["Rush", "Not rush"], es: ["Urgentes", "No urgentes"] },
    multiUnit: { en: ["Multi-unit", "Single unit"], es: ["Varias unidades", "Una unidad"] },
    blockedOver24h: {
      en: ["Blocked over 24 h", "Never blocked 24 h"],
      es: ["Bloqueados más de 24 h", "Nunca bloqueados 24 h"],
    },
  };
  const pair = L[r.driver]?.[lang];
  return pair ? pair[yes ? 0 : 1] : r.label;
}

function unmappedLabel(key: string, label: string, lang: Lang) {
  if (key !== "unmapped") return label;
  return lang === "es" ? "Sin diseño asignado" : "Unmapped design";
}

export function analyticsTools(ctx: TenantContext, t: Wrap): AssistantTool[] {
  if (!ctx.permissions.has("finance.read")) return [];
  const tenant = { companyId: ctx.companyId };

  return [
    t(
      "get_unit_economics",
      "Contribution margin ladder (metric: contribution_margin) for a period: revenue, CM1 after product costs, CM2 after fulfilment and refunds, CM3 after ads (CM3 = net profit, the Profit page's Net). Grouped by order, design, blank, sku or channel; optionally one channel. Money in cents; *Pct are percents.",
      Range.extend({
        dimension: z.enum(["order", "design", "blank", "sku", "channel"]).default("order"),
        channel: z.enum(CHANNELS).optional(),
        lang: LangIn,
      }),
      async (i) => {
        const period = { from: iso(i.from), to: iso(i.to) };
        const u = await withTenant(ctx.companyId, (tx) =>
          unitEconomics(tx, tenant, {
            period,
            dimension: i.dimension,
            channel: i.channel,
            limit: V6_MAX_ROWS,
          }),
        );
        const es = i.lang === "es";
        const tot = u.totals;
        const who = i.channel ? chan(i.channel) : es ? "Todos los canales" : "All channels";
        const when = span(period, i.lang);
        const rows = cap(u.rows, V6_MAX_ROWS).map((r) => ({
          ...r,
          label: i.dimension === "design" ? unmappedLabel(r.key, r.label, i.lang) : r.label,
        }));
        const top = rows.slice(0, 3).map((r) => `${r.label} ${usd(r.cm3)}`);
        const parts: string[] = [];
        if (tot.revenue === 0)
          parts.push(
            es
              ? `Margen de contribución (CM3): ${who} no tuvo ventas del ${when}.`
              : `Contribution margin (CM3): ${who} had no sales for ${when}.`,
          );
        else {
          parts.push(
            es
              ? `Margen de contribución (CM3, ganancia neta), ${who}, ${when}: ${usd(tot.cm3)} sobre ingresos de ${usd(tot.revenue)} (${pctOf(tot.cm3Pct, i.lang)}). CM1 después de prendas, transfers y comisiones: ${usd(tot.cm1)}; CM2 después de envío, empaque, mano de obra y reembolsos: ${usd(tot.cm2)}; CM3 después de anuncios: ${usd(tot.cm3)}. ${tot.orders} pedidos, ${tot.units} unidades.`
              : `Contribution margin (CM3, net profit), ${who}, ${when}: ${usd(tot.cm3)} on revenue ${usd(tot.revenue)} (${pctOf(tot.cm3Pct, i.lang)}). CM1 after blanks, transfers and channel fees: ${usd(tot.cm1)}; CM2 after labels, packaging, labor and refunds: ${usd(tot.cm2)}; CM3 after ads: ${usd(tot.cm3)}. ${tot.orders} orders, ${tot.units} units.`,
          );
          if (i.dimension !== "order" && top.length > 1)
            parts.push(es ? `Mayor CM3: ${top.join("; ")}.` : `Highest CM3: ${top.join("; ")}.`);
          if (tot.estimatedShare > 0)
            parts.push(
              es
                ? `${(tot.estimatedShare * 100).toFixed(1)}% de las unidades usan costos estimados.`
                : `${(tot.estimatedShare * 100).toFixed(1)}% of units use estimated costs.`,
            );
        }
        if (u.ordersWithoutProfitLine > 0)
          parts.push(
            es
              ? `${u.ordersWithoutProfitLine} pedidos todavía no tienen costos calculados, así que el total está incompleto.`
              : `${u.ordersWithoutProfitLine} orders don't have costs calculated yet, so the total is incomplete.`,
          );
        return {
          data: {
            metric: "contribution_margin",
            period: u.period,
            dimension: u.dimension,
            channel: i.channel ?? null,
            totals: tot,
            rows,
            ordersWithoutProfitLine: u.ordersWithoutProfitLine,
          },
          summary: `${who} ${when}: CM3 ${usd(tot.cm3)} on ${usd(tot.revenue)}`,
          answer: parts.join(" "),
        };
      },
    ),
    t(
      "explain_profit_change",
      "Explains why net profit (CM3) changed between two periods (metric: profit_bridge). Splits the change exactly into volume (sold more or fewer units) and per-unit (each sale earned more or less), with the top movers by design, channel or cost line. Call this FIRST for any 'why did profit change' question. previousFrom/previousTo default to the same-length period right before.",
      Range.extend({
        previousFrom: z.string().optional().describe("Base period start, ISO 8601"),
        previousTo: z.string().optional().describe("Base period end (exclusive), ISO 8601"),
        by: z.enum(["design", "channel", "costLine"]).default("design"),
        channel: z.enum(CHANNELS).optional(),
        lang: LangIn,
      }),
      async (i) => {
        const period = { from: iso(i.from), to: iso(i.to) };
        const basePeriod =
          i.previousFrom && i.previousTo
            ? { from: iso(i.previousFrom), to: iso(i.previousTo) }
            : undefined;
        const b = await withTenant(ctx.companyId, (tx) =>
          profitBridge(tx, tenant, { period, basePeriod, by: i.by, channel: i.channel }),
        );
        const es = i.lang === "es";
        const name = (key: string, label: string) =>
          i.by === "costLine"
            ? tr(COST_LINE, key, i.lang, label)
            : i.by === "channel"
              ? chan(key)
              : unmappedLabel(key, label, i.lang);
        const movers = cap(b.topMovers).map((m) => ({ ...m, label: name(m.key, m.label) }));
        const when = `${span(b.period, i.lang)} ${es ? "contra" : "vs"} ${span(b.basePeriod, i.lang)}`;
        const lines: string[] = [];
        if (b.baseCm3 === 0 && b.currentCm3 === 0 && b.currentOrders === 0 && b.baseOrders === 0)
          lines.push(
            es
              ? `No hubo ventas en ninguno de los dos periodos (${when}), así que no hay cambio que explicar.`
              : `There were no sales in either period (${when}), so there is no change to explain.`,
          );
        else {
          lines.push(
            es
              ? `Puente de ganancia (margen de contribución CM3), ${when}: la ganancia neta cambió ${signed(b.totalChange)} (de ${usd(b.baseCm3)} a ${usd(b.currentCm3)}).`
              : `Profit bridge (contribution margin CM3), ${when}: net profit changed ${signed(b.totalChange)} (from ${usd(b.baseCm3)} to ${usd(b.currentCm3)}).`,
            es
              ? `- Volumen (vendiste más o menos unidades): ${signed(b.volumePart)}\n- Por unidad (cada venta dejó más o menos): ${signed(b.ratePart)}\n- Volumen + por unidad = ${signed(b.volumePart + b.ratePart)}.`
              : `- Volume (sold more or fewer units): ${signed(b.volumePart)}\n- Per unit (each sale earned more or less): ${signed(b.ratePart)}\n- Volume + per unit = ${signed(b.volumePart + b.ratePart)}.`,
          );
          const [top, ...rest] = movers;
          if (top)
            lines.push(
              es
                ? `Mayor cambio: ${top.label}, ${signed(top.change)} (volumen ${signed(top.volumePart)}, por unidad ${signed(top.ratePart)}; unidades ${top.baseUnits} → ${top.currentUnits}).`
                : `Biggest mover: ${top.label}, ${signed(top.change)} (volume ${signed(top.volumePart)}, per unit ${signed(top.ratePart)}; units ${top.baseUnits} → ${top.currentUnits}).`,
            );
          if (rest.length)
            lines.push(
              `${es ? "Otros" : "Others"}: ${rest
                .slice(0, 3)
                .map((m) => `${m.label} ${signed(m.change)}`)
                .join("; ")}.`,
            );
          if (b.refundsChange !== 0)
            lines.push(
              es
                ? `Los reembolsos con fecha en el periodo cambiaron ${signed(b.refundsChange)}; esa línea va aparte del puente.`
                : `Refunds dated in the period changed ${signed(b.refundsChange)}; that line sits outside the bridge.`,
            );
          if (!b.hasEnoughOrders)
            lines.push(
              es
                ? `Solo hubo ${b.currentOrders} y ${b.baseOrders} pedidos (menos de 20 en algún periodo), así que toma la división como aproximada.`
                : `Only ${b.currentOrders} and ${b.baseOrders} orders (under 20 in a period), so treat the split as rough.`,
            );
        }
        return {
          data: {
            metric: "profit_bridge",
            period: b.period,
            basePeriod: b.basePeriod,
            by: b.by,
            baseCm3: b.baseCm3,
            currentCm3: b.currentCm3,
            totalChange: b.totalChange,
            volumePart: b.volumePart,
            ratePart: b.ratePart,
            refundsChange: b.refundsChange,
            baseOrders: b.baseOrders,
            currentOrders: b.currentOrders,
            hasEnoughOrders: b.hasEnoughOrders,
            topMovers: movers,
          },
          summary: `CM3 ${signed(b.totalChange)}: volume ${signed(b.volumePart)}, per unit ${signed(b.ratePart)}${movers[0] ? `; top ${movers[0].label}` : ""}`,
          answer: lines.join("\n"),
        };
      },
    ),
    t(
      "get_operations_health",
      "Production health for a period: reprint cost and rate by reason and station (metric: reprint_cost), film waste (film_waste_cost), hours items wait in each step and the bottleneck (stage_wait_hours), press minutes per unit per station (press_minutes_per_unit), and late rate with the order types that were more often late (late_rate; associations, not causes). Per station, never per person.",
      Range.extend({ channel: z.enum(CHANNELS).optional(), lang: LangIn }),
      async (i) => {
        const period = { from: iso(i.from), to: iso(i.to) };
        const o = await withTenant(ctx.companyId, (tx) =>
          getOperations(tx, tenant, { period, channel: i.channel }),
        );
        const L = i.lang;
        const es = L === "es";
        const rc = o.reprintCost;
        const byReason = cap(rc.byReason, 5).map((r) => ({
          ...r,
          label: tr(REASON, r.key, L, r.label),
        }));
        const waits = cap(o.waits, 12).map((w) => ({ ...w, label: tr(STATE, w.state, L) }));
        const late = o.lateDrivers;
        const drivers = cap(late.rows, 12).map((r) => ({ ...r, label: driverLabel(r, L) }));
        const worstDriver = drivers
          .filter((r) => r.latePct != null && r.value !== "no")
          .sort((a, b) => (b.latePct ?? 0) - (a.latePct ?? 0))[0];
        const press = cap(o.pressMinutesPerUnit, 5);
        const bottleneck = o.bottleneckStep
          ? waits.find((w) => w.state === o.bottleneckStep)
          : null;
        const when = span(period, L);
        const s: string[] = [];
        s.push(
          es
            ? `Operaciones, ${when}. Costo de reimpresiones (reprint_cost): ${usd(rc.total)} en ${rc.reprints} reimpresiones, tasa ${pctOf(rc.ratePct, L)} de ${rc.itemsPressed} piezas planchadas.${byReason[0] ? ` Motivo principal: ${byReason[0].label}, ${usd(byReason[0].cost)}.` : ""}`
            : `Operations, ${when}. Reprint cost (reprint_cost): ${usd(rc.total)} on ${rc.reprints} reprints, rate ${pctOf(rc.ratePct, L)} of ${rc.itemsPressed} items pressed.${byReason[0] ? ` Top reason: ${byReason[0].label}, ${usd(byReason[0].cost)}.` : ""}`,
          es
            ? `Desperdicio de film (film_waste_cost): ${usd(o.filmWaste.wasteCost)} en ${o.filmWaste.sheets} hojas, uso del film ${pctOf(o.filmWaste.filmUsePct, L)}.`
            : `Film waste (film_waste_cost): ${usd(o.filmWaste.wasteCost)} on ${o.filmWaste.sheets} sheets, film use ${pctOf(o.filmWaste.filmUsePct, L)}.`,
        );
        if (bottleneck)
          s.push(
            es
              ? `Paso más lento (stage_wait_hours): ${bottleneck.label}, mediana ${bottleneck.medianHours} h (p90 ${bottleneck.p90Hours} h).`
              : `Slowest step (stage_wait_hours): ${bottleneck.label}, median ${bottleneck.medianHours} h (p90 ${bottleneck.p90Hours} h).`,
          );
        s.push(
          es
            ? `Tasa de retraso (late_rate): ${pctOf(late.latePct, L)} (${late.lateOrders} de ${late.shippedOrders} pedidos enviados).${worstDriver ? ` Se retrasaron más seguido: ${worstDriver.label}, ${pctOf(worstDriver.latePct, L)}.` : ""}`
            : `Late rate (late_rate): ${pctOf(late.latePct, L)} (${late.lateOrders} of ${late.shippedOrders} shipped orders).${worstDriver ? ` More often late: ${worstDriver.label}, ${pctOf(worstDriver.latePct, L)}.` : ""}`,
        );
        const timed = press.find((p) => p.medianMinutes != null);
        if (timed)
          s.push(
            es
              ? `Planchado (press_minutes_per_unit): ${timed.stationName}, ${timed.medianMinutes} min por unidad.`
              : `Pressing (press_minutes_per_unit): ${timed.stationName}, ${timed.medianMinutes} min per unit.`,
          );
        if (!o.hasEnoughHistory)
          s.push(
            es
              ? "Todavía hay poco historial, así que varias cifras dicen «sin datos suficientes»."
              : "There is little history yet, so several figures say not enough data.",
          );
        return {
          data: {
            metrics: [
              "reprint_cost",
              "film_waste_cost",
              "stage_wait_hours",
              "press_minutes_per_unit",
              "late_rate",
            ],
            period: o.period,
            hasEnoughHistory: o.hasEnoughHistory,
            reprintCost: {
              total: rc.total,
              reprints: rc.reprints,
              itemsPressed: rc.itemsPressed,
              ratePct: rc.ratePct,
              byReason,
              byStation: cap(rc.byStation, 5),
              byVendor: cap(rc.byVendor, 5),
            },
            filmWaste: { ...o.filmWaste, byVendor: cap(o.filmWaste.byVendor, 5) },
            waits,
            bottleneckStep: o.bottleneckStep,
            pressMinutesPerUnit: press,
            lateDrivers: { ...late, rows: drivers },
          },
          summary: `reprints ${usd(rc.total)}, film waste ${usd(o.filmWaste.wasteCost)}, late ${pctOf(late.latePct, "en")}`,
          answer: s.join(" "),
        };
      },
    ),
    t(
      "get_inventory_health",
      "Blank stock health as of now over a trailing window of days: stock value and turns, dead stock (metric: blank_stock_health), size-mix gaps between sales and stock (size_mix_gap), and sold units waiting on missing blanks with revenue at risk (stockout_exposure).",
      z.object({
        days: z.number().int().min(7).max(365).default(90).describe("Trailing window in days"),
        lang: LangIn,
      }),
      async (i) => {
        const h = await withTenant(ctx.companyId, (tx) =>
          inventoryHealth(tx, tenant, { days: i.days }),
        );
        const es = i.lang === "es";
        const dead = cap(h.deadStock.rows);
        const gaps = cap(
          h.sizeMixGaps.filter((g) => g.hasEnoughUnits),
          5,
        ).map((g) => ({ ...g, sizes: cap(g.sizes, 12) }));
        const worstGap = gaps
          .flatMap((g) => g.sizes.map((sz) => ({ g, sz })))
          .filter((x) => x.sz.gapPts != null && x.sz.gapPts < 0)
          .sort((a, b) => (a.sz.gapPts ?? 0) - (b.sz.gapPts ?? 0))[0];
        const out = h.stockoutExposure;
        const s: string[] = [
          es
            ? `Salud del inventario de prendas (blank_stock_health), últimos ${h.days} días: ${usd(h.onHandValue)} en ${h.onHandUnits} unidades; rotación ${h.turns ?? "sin datos suficientes"}${h.turns != null ? " veces al año" : ""}.`
            : `Blank stock health (blank_stock_health), last ${h.days} days: ${usd(h.onHandValue)} on hand in ${h.onHandUnits} units; turns ${h.turns ?? "not enough data"}${h.turns != null ? "x a year" : ""}.`,
          es
            ? `Inventario sin movimiento: ${h.deadStock.variants} variantes por ${usd(h.deadStock.value)} (${pctOf(h.deadStock.pctOfStockValue, i.lang)} del valor)${dead[0] ? `, la mayor ${dead[0].label} ${usd(dead[0].value)}` : ""}.`
            : `Dead stock: ${h.deadStock.variants} variants worth ${usd(h.deadStock.value)} (${pctOf(h.deadStock.pctOfStockValue, i.lang)} of stock value)${dead[0] ? `, largest ${dead[0].label} ${usd(dead[0].value)}` : ""}.`,
          es
            ? `Riesgo de faltantes (stockout_exposure): ${out.units} unidades vendidas esperan ${out.blanks} prendas, ${usd(out.revenueAtRisk)} de ingresos en riesgo${out.earliestShipBy ? `, primera fecha de envío ${out.earliestShipBy.slice(0, 10)}` : ""}.`
            : `Stockout exposure (stockout_exposure): ${out.units} sold units wait on ${out.blanks} blanks, ${usd(out.revenueAtRisk)} revenue at risk${out.earliestShipBy ? `, earliest ship-by ${out.earliestShipBy.slice(0, 10)}` : ""}.`,
        ];
        if (worstGap)
          s.push(
            es
              ? `Brecha de tallas (size_mix_gap): ${worstGap.g.label} talla ${worstGap.sz.size} tiene ${Math.abs(worstGap.sz.gapPts ?? 0).toFixed(1)} puntos menos de inventario que de ventas.`
              : `Size mix gap (size_mix_gap): ${worstGap.g.label} size ${worstGap.sz.size} is ${Math.abs(worstGap.sz.gapPts ?? 0).toFixed(1)} points under-stocked against sales.`,
          );
        if (!h.hasEnoughHistory)
          s.push(
            es
              ? "Hay menos de 90 días de historial, así que la rotación y el inventario sin movimiento son preliminares."
              : "There are under 90 days of history, so turns and dead stock are early reads.",
          );
        return {
          data: {
            metrics: ["blank_stock_health", "size_mix_gap", "stockout_exposure"],
            days: h.days,
            asOf: h.asOf,
            hasEnoughHistory: h.hasEnoughHistory,
            onHandUnits: h.onHandUnits,
            onHandValue: h.onHandValue,
            consumedCost: h.consumedCost,
            turns: h.turns,
            deadStock: { ...h.deadStock, rows: dead },
            sizeMixGaps: gaps,
            stockoutExposure: { ...out, rows: cap(out.rows) },
          },
          summary: `stock ${usd(h.onHandValue)}, dead ${usd(h.deadStock.value)}, at risk ${usd(out.revenueAtRisk)}`,
          answer: s.join(" "),
        };
      },
    ),
    t(
      "get_shipping_insights",
      "Shipping margin for a period (metric: shipping_margin): shipping charged to buyers minus postage and label fees, per labeled order, grouped by channel, service, weight band or zone; plus free-shipping orders.",
      Range.extend({
        groupBy: z.enum(SHIPPING_MARGIN_GROUPS).default("channel"),
        channel: z.enum(CHANNELS).optional(),
        lang: LangIn,
      }),
      async (i) => {
        const period = { from: iso(i.from), to: iso(i.to) };
        const m = await withTenant(ctx.companyId, (tx) =>
          shippingMargin(tx, tenant, { period, groupBy: i.groupBy, channel: i.channel }),
        );
        const es = i.lang === "es";
        const rows = cap(m.rows, V6_MAX_ROWS).map((r) => ({
          ...r,
          label: i.groupBy === "channel" ? chan(r.key) : r.label,
        }));
        const tot = m.totals;
        const when = span(period, i.lang);
        const worst = [...rows].sort((a, b) => a.margin - b.margin)[0];
        const s: string[] = [];
        if (tot.labeledOrders === 0)
          s.push(
            es
              ? `Margen de envío (shipping_margin): no hubo pedidos con etiqueta del ${when}.`
              : `Shipping margin (shipping_margin): no orders were labeled for ${when}.`,
          );
        else {
          const per =
            tot.marginPerOrder == null
              ? ""
              : ` (${usd(tot.marginPerOrder)} ${es ? "por pedido" : "per order"})`;
          s.push(
            es
              ? `Margen de envío (shipping_margin), ${when}: ${usd(tot.margin)}${per} en ${tot.labeledOrders} pedidos con etiqueta: cobrado ${usd(tot.charged)}, costo de etiquetas ${usd(tot.labelCost)}. ${tot.freeShippingOrders} pedidos con envío gratis.`
              : `Shipping margin (shipping_margin), ${when}: ${usd(tot.margin)}${per} on ${tot.labeledOrders} labeled orders: charged ${usd(tot.charged)}, label cost ${usd(tot.labelCost)}. ${tot.freeShippingOrders} free-shipping orders.`,
          );
          if (worst && rows.length > 1)
            s.push(
              es
                ? `Menor margen: ${worst.label}, ${usd(worst.margin)} en ${worst.labeledOrders} pedidos.`
                : `Lowest margin: ${worst.label}, ${usd(worst.margin)} on ${worst.labeledOrders} orders.`,
            );
        }
        return {
          data: {
            metric: "shipping_margin",
            period: m.period,
            groupBy: m.groupBy,
            totals: tot,
            rows,
            shipmentsWithoutZone: m.shipmentsWithoutZone,
          },
          summary: `shipping margin ${usd(tot.margin)} on ${tot.labeledOrders} labeled orders`,
          answer: s.join(" "),
        };
      },
    ),
  ];
}
