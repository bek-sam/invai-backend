import {
  CHANNEL_RULES,
  type Channel,
  type DigestAction,
  type DigestFact,
  type DigestGlanceItem,
  type MarketRecommendation,
} from "@invai/contracts";
import { nicheLabel } from "../market/niches";
import { formatValue, type Lang } from "./facts";

/*
 * Email rendering (spec step 11, AC13, PM P1). Every line is a template key from the table below
 * plus values that are computed facts, names from the shop's own data (shop, channel, design,
 * blank) or links. No free text and no model output: in shadow mode the AI summary is never
 * rendered, so the rendered email is exactly the template (AC18). The subject is written here,
 * never by the model. Keys without a spec row are marked `new:` for the product-designer review.
 */

type Row = { en: string; es: string };
export const TEMPLATES = {
  "today.card": {
    en: "Your week in review is ready",
    es: "Tu resumen de la semana está listo",
  },
  subject: {
    en: "Your week at {{shop}}: net profit {{net}} ({{change}})",
    es: "Tu semana en {{shop}}: ganancia neta {{net}} ({{change}})",
  },
  /** new: first week (no previous week to compare with). */
  "subject.first": {
    en: "Your week at {{shop}}: net profit {{net}}",
    es: "Tu semana en {{shop}}: ganancia neta {{net}}",
  },
  /** new: the week range under the heading. */
  week: { en: "{{from}} to {{to}}", es: "{{from}} al {{to}}" },
  steady: {
    en: "A steady week. Here are your numbers.",
    es: "Una semana estable. Aquí están tus números.",
  },
  incomplete: {
    en: "Numbers are estimated: fees for {{n}} orders aren't final yet.",
    es: "Los números son estimados: las comisiones de {{n}} pedidos aún no son finales.",
  },
  partial: {
    en: "{{channel}} was disconnected, so these numbers may be partial.",
    es: "{{channel}} estuvo desconectado, así que estos números pueden estar incompletos.",
  },
  /** new: glance labels. */
  "glance.revenue": { en: "Revenue", es: "Ingresos" },
  "glance.net": { en: "Net profit", es: "Ganancia neta" },
  "glance.marginPct": { en: "Margin", es: "Margen" },
  "glance.orders": { en: "Orders", es: "Pedidos" },
  "glance.onTimeRate": { en: "Shipped on time", es: "Enviados a tiempo" },
  /** new: one glance row. */
  "glance.row": {
    en: "{{label}}: {{value}} ({{change}} vs last week)",
    es: "{{label}}: {{value}} ({{change}} vs. la semana pasada)",
  },
  "glance.rowFirst": { en: "{{label}}: {{value}}", es: "{{label}}: {{value}}" },
  /** new: section titles. */
  "section.actions": { en: "Your actions this week", es: "Tus acciones de esta semana" },
  "section.win": { en: "Win of the week", es: "El logro de la semana" },
  "D1 action": { en: "Reconnect {{channel}}", es: "Vuelve a conectar {{channel}}" },
  "D2 action": { en: "See what changed", es: "Ver qué cambió" },
  /** new (T-A9, AC-E1f): D2 names the profit bridge's top mover. */
  "D2 action.mover": {
    en: "See what changed: {{mover}} moved your profit the most",
    es: "Ver qué cambió: {{mover}} fue lo que más movió tu ganancia",
  },
  "D3 action": { en: "Review {{costLine}} costs", es: "Revisa los costos de {{costLine}}" },
  "D4 action": { en: "Review ads on {{channel}}", es: "Revisa los anuncios en {{channel}}" },
  "D4 note": {
    en: "Ad results are measured by channel, not by ad.",
    es: "Los resultados de anuncios se miden por canal, no por anuncio.",
  },
  "D5 action.list": {
    en: "List {{design}} on {{channel}}",
    es: "Publica {{design}} en {{channel}}",
  },
  "D5 action.price": { en: "Review the price of {{design}}", es: "Revisa el precio de {{design}}" },
  "D6 action.ship": { en: "Ship {{n}} overdue orders", es: "Envía {{n}} pedidos atrasados" },
  "D6 action.reprints": { en: "See reprints", es: "Ver reimpresiones" },
  "D7 action": { en: "Reorder {{blank}}", es: "Vuelve a pedir {{blank}}" },
  /** new (T-A9, spec business-analytics-v2 Track E): D9..D13. */
  "D9 action": {
    en: "Review shipping prices on {{channel}}",
    es: "Revisa los precios de envío en {{channel}}",
  },
  "D10 action": { en: "Review your losing orders", es: "Revisa tus pedidos con pérdida" },
  "D11 action.dead": {
    en: "Review stock that isn't selling: {{style}} {{color}}",
    es: "Revisa el inventario que no se vende: {{style}} {{color}}",
  },
  "D11 action.gap": {
    en: "Restock {{style}} {{color}} in size {{size}}",
    es: "Vuelve a surtir {{style}} {{color}} en talla {{size}}",
  },
  "D12 action": {
    en: "Review blank cost: {{style}} from {{supplier}} is up {{pct}}",
    es: "Revisa el costo de prendas: {{style}} de {{supplier}} subió {{pct}}",
  },
  "D13 action": {
    en: "Sales are below break-even: see what it takes",
    es: "Las ventas están por debajo del punto de equilibrio: mira qué se necesita",
  },
  /** new: D8 wins. */
  "D8 win.bestNet": {
    en: "Your best net week in {{n}} weeks: {{net}}",
    es: "Tu mejor semana neta en {{n}} semanas: {{net}}",
  },
  "D8 win.onTime": {
    en: "Your best on-time rate yet: {{rate}}",
    es: "Tu mejor tasa de envíos a tiempo: {{rate}}",
  },
  "market.title": { en: "Market watch", es: "Vistazo al mercado" },
  "R1 action": {
    en: "List {{design}} on {{channels}} and stock {{blank}} before {{peak}}.",
    es: "Publica {{design}} en {{channels}} y surte {{blank}} antes de {{peak}}.",
  },
  /** R1 while today is inside the peak month (wave 20; market-signals.md "R1 action (peak
   * under way)"): no act-by date, no "before". */
  "R1 action.underWay": {
    en: "The {{niche}} season is on now. Make sure {{design}} is listed and in stock.",
    es: "La temporada de {{niche}} ya empezó. Asegúrate de que {{design}} esté publicado y con inventario.",
  },
  "R2 action": {
    en: "Test a price of {{price}} on {{channel}} for 2 weeks.",
    es: "Prueba un precio de {{price}} en {{channel}} por 2 semanas.",
  },
  "R3 action": {
    en: "Raise {{design}} to at least {{floor}}, or stop its ads.",
    es: "Sube {{design}} a por lo menos {{floor}}, o detén sus anuncios.",
  },
  "R4 action": {
    en: "Make 1–2 new designs for the {{niche}} niche.",
    es: "Crea 1 o 2 diseños nuevos para el nicho {{niche}}.",
  },
  "R5 action": {
    en: "Pause ads on {{design}} and move it down your list.",
    es: "Pausa los anuncios de {{design}} y bájalo en tu lista.",
  },
  /** Source and date under a market item; the date is `source.weekEnding` (wave 20). */
  "market.source": {
    en: "{{source}}, week ending {{date}}",
    es: "{{source}}, semana al {{date}}",
  },
  /** new: R1's channel-list fallback when neither `params.channels` nor a single target/params
   * channel is set (T-19-3 round 2 fix), matching web's `market.channels.connected`
   * (invai-web/src/components/market/recommendation-copy.ts). */
  "market.channels.connected": {
    en: "your connected channels",
    es: "tus canales conectados",
  },
  "band.high": { en: "High confidence", es: "Confianza alta" },
  "band.medium": { en: "Medium confidence: test it", es: "Confianza media: pruébalo" },
  "badge.sample": { en: "Sample data", es: "Datos de muestra" },
  "rec.sample": {
    en: "Sample data, not your real market: no market source is connected yet.",
    es: "Datos de muestra, no tu mercado real: todavía no hay una fuente del mercado conectada.",
  },
  paused: {
    en: "We paused your digest until orders resume.",
    es: "Pausamos tu resumen hasta que vuelvan los pedidos.",
  },
  "footer.why": {
    en: "You get this because you turned on the weekly review for {{shop}}.",
    es: "Recibes esto porque activaste el resumen semanal de {{shop}}.",
  },
  "footer.manage": { en: "Manage in Settings", es: "Administra en Configuración" },
  /** new: the one-click unsubscribe link text. */
  "footer.unsubscribe": { en: "Unsubscribe", es: "Cancelar suscripción" },
  /** new: placeholder until OI-12 gives InvAI's postal address. */
  "footer.address": {
    en: "InvAI · postal address coming soon",
    es: "InvAI · dirección postal próximamente",
  },
  /** new: cost-line names for D3. */
  "costLine.channelFees": { en: "channel fee", es: "comisiones del canal" },
  "costLine.blankCost": { en: "blank", es: "prendas" },
  "costLine.transferCost": { en: "transfer", es: "transfers" },
  "costLine.labelCost": { en: "shipping label", es: "etiquetas de envío" },
  "costLine.packagingCost": { en: "packaging", es: "empaque" },
  "costLine.laborCost": { en: "labor", es: "mano de obra" },
  "costLine.adsCost": { en: "ad", es: "anuncios" },
  "costLine.refunds": { en: "refund", es: "reembolsos" },
  /** new: names of market sources (proper names stay as they are). */
  "source.own": { en: "Your sales", es: "Tus ventas" },
  "source.census": { en: "US Census", es: "Censo de EE. UU." },
  "source.google_trends": { en: "Google Trends", es: "Google Trends" },
  "source.pinterest_trends": { en: "Pinterest Trends", es: "Pinterest Trends" },
  "source.amazon_pricing": { en: "Amazon prices", es: "Precios de Amazon" },
  "source.amazon_brand_analytics": { en: "Amazon Brand Analytics", es: "Amazon Brand Analytics" },
  "source.walmart_pricing": { en: "Walmart prices", es: "Precios de Walmart" },
  "source.jungle_scout": { en: "Jungle Scout", es: "Jungle Scout" },
} as const satisfies Record<string, Row>;

export type TemplateKey = keyof typeof TEMPLATES;

/** One rendered line: a template key and the values substituted into it. */
export type Part = { key: TemplateKey; vars: Record<string, string>; href?: string };

export function expand(p: Part, lang: Lang): string {
  return TEMPLATES[p.key][lang].replace(/\{\{(\w+)\}\}/g, (_, k: string) => p.vars[k] ?? "");
}

export type RenderInsight = {
  id: string;
  detector: string;
  action: DigestAction;
  facts: DigestFact[];
  recommendation?: MarketRecommendation | null;
};

export type RenderModel = {
  shopName: string;
  weekStart: string;
  weekEnd: string;
  glance: DigestGlanceItem[];
  net: DigestFact | null;
  netChange: DigestFact | null;
  steady: boolean;
  incompleteOrders: number;
  partialChannels: Channel[];
  actions: RenderInsight[];
  win: RenderInsight | null;
  marketWatch: RenderInsight[];
  /** Signed click link for an insight's action (email); the in-app href when absent. */
  linkFor?: (insightId: string) => string;
  unsubscribeUrl: string;
  manageUrl: string;
};

const channelName = (c: string | undefined) => (c ? (CHANNEL_RULES[c as Channel]?.label ?? c) : "");
const factOf = (i: RenderInsight, suffix: string) => i.facts.find((f) => f.id.endsWith(suffix));

function monthName(lang: Lang, month: number) {
  return new Intl.DateTimeFormat(lang === "es" ? "es-US" : "en-US", {
    month: "long",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(2026, month - 1, 1)));
}
function money(lang: Lang, cents: number | undefined) {
  if (cents === undefined) return "";
  return new Intl.NumberFormat(lang === "es" ? "es-US" : "en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}
function dateLabel(lang: Lang, ymd: string) {
  return new Intl.DateTimeFormat(lang === "es" ? "es-US" : "en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${ymd}T00:00:00Z`));
}
function lastDay(ymd: string) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** The action line of a non-market insight. */
export function actionPart(i: RenderInsight, lang: Lang): Part {
  const p = i.action.params;
  const k = i.action.kind;
  switch (k) {
    case "reconnect_channel":
      return { key: "D1 action", vars: { channel: channelName(p.channel) } };
    case "see_what_changed": {
      const mover = factOf(i, "d2.topMover")?.formatted[lang] ?? p.designName;
      return mover ? { key: "D2 action.mover", vars: { mover } } : { key: "D2 action", vars: {} };
    }
    case "review_costs": {
      const key = `costLine.${p.costLine}` as TemplateKey;
      return {
        key: "D3 action",
        vars: { costLine: key in TEMPLATES ? TEMPLATES[key][lang] : "" },
      };
    }
    case "review_ads":
      return { key: "D4 action", vars: { channel: channelName(p.channel) } };
    case "list_design":
      return {
        key: "D5 action.list",
        vars: { design: p.designName ?? "", channel: channelName(p.channel) },
      };
    case "review_price":
      return { key: "D5 action.price", vars: { design: p.designName ?? "" } };
    case "ship_overdue":
      return {
        key: "D6 action.ship",
        vars: { n: factOf(i, "overdueNow")?.formatted[lang] ?? String(p.n ?? 0) },
      };
    case "see_reprints":
      return { key: "D6 action.reprints", vars: {} };
    case "reorder_blank":
      return { key: "D7 action", vars: { blank: p.blankName ?? "" } };
    case "review_shipping_prices":
      return { key: "D9 action", vars: { channel: channelName(p.channel) } };
    case "review_losing_orders":
      return { key: "D10 action", vars: {} };
    case "review_dead_stock":
      return { key: "D11 action.dead", vars: { style: p.style ?? "", color: p.color ?? "" } };
    case "restock_size_gap":
      return {
        key: "D11 action.gap",
        vars: { style: p.style ?? "", color: p.color ?? "", size: p.size ?? "" },
      };
    case "review_blank_cost":
      return {
        key: "D12 action",
        vars: {
          style: p.style ?? "",
          supplier: p.supplierName ?? "",
          pct: p.points === undefined ? "" : formatValue("pct", p.points, lang),
        },
      };
    case "see_break_even":
      return { key: "D13 action", vars: {} };
    case "market":
      return marketPart(i, lang);
    default: {
      const best = factOf(i, "d8.net");
      if (best)
        return {
          key: "D8 win.bestNet",
          vars: { n: factOf(i, "d8.weeks")?.formatted[lang] ?? "", net: best.formatted[lang] },
        };
      return {
        key: "D8 win.onTime",
        vars: { rate: factOf(i, "d8.onTimeRate")?.formatted[lang] ?? "" },
      };
    }
  }
}

function marketPart(i: RenderInsight, lang: Lang): Part {
  const r = i.recommendation;
  const p = r?.params ?? {};
  const design = r?.target.designName ?? p.designName ?? i.action.params.designName ?? "";
  const channel = channelName(r?.target.channel ?? p.channel ?? undefined);
  const channels = (p.channels ?? []).map((c) => channelName(c)).join(", ");
  const peak = p.peakMonth ? monthName(lang, p.peakMonth) : "";
  switch (r?.rule) {
    case "R1":
      // A peak under way carries its peak month but no act-by date (wave 20 R1 timing).
      if (p.peakMonth && !p.actByDate)
        return {
          key: "R1 action.underWay",
          vars: { niche: p.niche ? nicheLabel(p.niche, lang) : peak, design },
        };
      return {
        key: "R1 action",
        vars: {
          design,
          // Bug fix (T-19-3 round 2): `channel` is "" when neither `target.channel` nor
          // `params.channel` is set, so falling back to it left the listing clause empty
          // ("List X on  and stock ..."). Fall back to the same wording web uses
          // (recommendation-copy.ts's `market.channels.connected`) instead.
          channels: channels || TEMPLATES["market.channels.connected"][lang],
          blank: p.blankName ?? "",
          peak,
        },
      };
    case "R2":
      return {
        key: "R2 action",
        vars: { price: money(lang, p.testPriceMinCents ?? p.currentPriceCents), channel },
      };
    case "R3":
      return { key: "R3 action", vars: { design, floor: money(lang, p.floorPriceCents) } };
    case "R4":
      return { key: "R4 action", vars: { niche: r?.target.niche ?? "" } };
    default:
      return { key: "R5 action", vars: { design } };
  }
}

/** The lines of a digest email, in order (the P1 test walks these). */
export function renderParts(m: RenderModel, lang: Lang, opts: { footer?: boolean } = {}): Part[] {
  const parts: Part[] = [{ key: "today.card", vars: {} }];
  parts.push({
    key: "week",
    vars: { from: dateLabel(lang, m.weekStart), to: dateLabel(lang, lastDay(m.weekEnd)) },
  });
  for (const c of m.partialChannels)
    parts.push({ key: "partial", vars: { channel: channelName(c) } });
  if (m.incompleteOrders > 0)
    parts.push({
      key: "incomplete",
      vars: {
        n: new Intl.NumberFormat(lang === "es" ? "es-US" : "en-US").format(m.incompleteOrders),
      },
    });
  if (m.steady) parts.push({ key: "steady", vars: {} });
  for (const g of m.glance) {
    const label = TEMPLATES[`glance.${g.metric}` as TemplateKey][lang];
    parts.push(
      g.change
        ? {
            key: "glance.row",
            vars: { label, value: g.current.formatted[lang], change: g.change.formatted[lang] },
          }
        : { key: "glance.rowFirst", vars: { label, value: g.current.formatted[lang] } },
    );
  }
  const link = (i: RenderInsight) => (m.linkFor ? m.linkFor(i.id) : i.action.href);
  if (m.actions.length) {
    parts.push({ key: "section.actions", vars: {} });
    for (const a of m.actions) {
      parts.push({ ...actionPart(a, lang), href: link(a) });
      if (a.detector === "D4") parts.push({ key: "D4 note", vars: {} });
    }
  }
  if (m.win) {
    parts.push({ key: "section.win", vars: {} });
    parts.push(actionPart(m.win, lang));
  }
  if (m.marketWatch.length) {
    parts.push({ key: "market.title", vars: {} });
    for (const i of m.marketWatch) {
      parts.push({ ...marketPart(i, lang), href: link(i) });
      const src = i.facts.find((f) => f.id.endsWith(".source"));
      const asOf = i.facts.find((f) => f.id.endsWith(".asOf"));
      if (src?.value && asOf?.value) {
        const sk = `source.${src.value}` as TemplateKey;
        parts.push({
          key: "market.source",
          vars: {
            source: sk in TEMPLATES ? TEMPLATES[sk][lang] : String(src.value),
            date: asOf.formatted[lang],
          },
        });
      }
      const band = i.recommendation?.band;
      if (band === "high" || band === "medium") parts.push({ key: `band.${band}`, vars: {} });
      if (i.recommendation?.mock) {
        parts.push({ key: "badge.sample", vars: {} });
        parts.push({ key: "rec.sample", vars: {} });
      }
    }
  }
  if (opts.footer === false) return parts;
  parts.push({ key: "footer.why", vars: { shop: m.shopName } });
  parts.push({ key: "footer.manage", vars: {}, href: m.manageUrl });
  parts.push({ key: "footer.unsubscribe", vars: {}, href: m.unsubscribeUrl });
  parts.push({ key: "footer.address", vars: {} });
  return parts;
}

export function renderSubject(m: Pick<RenderModel, "shopName" | "net" | "netChange">, lang: Lang) {
  const net = m.net?.formatted[lang] ?? money(lang, 0);
  return m.netChange
    ? expand(
        { key: "subject", vars: { shop: m.shopName, net, change: m.netChange.formatted[lang] } },
        lang,
      )
    : expand({ key: "subject.first", vars: { shop: m.shopName, net } }, lang);
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const HEADINGS: ReadonlySet<TemplateKey> = new Set([
  "today.card",
  "section.actions",
  "section.win",
  "market.title",
]);

/**
 * Subject, text and HTML. With `footer` (T-19-4's shared `emailFooter`: why, one-click
 * unsubscribe, settings, postal address) the renderer's own footer lines are left out.
 */
export function renderEmail(m: RenderModel, lang: Lang, footer?: { text: string; html: string }) {
  const parts = renderParts(m, lang, { footer: !footer });
  const text = [
    ...parts.map((p) => (p.href ? `${expand(p, lang)}: ${p.href}` : expand(p, lang))),
    ...(footer ? ["", footer.text] : []),
  ].join("\n");
  const html = [
    `<!doctype html><html lang="${lang}"><body style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:16px;color:#1f2937">`,
    ...parts.map((p) => {
      const body = esc(expand(p, lang));
      if (HEADINGS.has(p.key)) return `<h2 style="font-size:18px;margin:20px 0 8px">${body}</h2>`;
      if (p.href) return `<p><a href="${esc(p.href)}" style="color:#1d4ed8">${body}</a></p>`;
      return `<p style="margin:4px 0">${body}</p>`;
    }),
    ...(footer ? [footer.html] : []),
    "</body></html>",
  ].join("\n");
  return { subject: renderSubject(m, lang), text, html, parts };
}
