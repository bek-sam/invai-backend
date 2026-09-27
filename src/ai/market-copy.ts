import { CHANNEL_RULES, type Channel, type SignalSource } from "@invai/contracts";

/*
 * Fixed market wording (spec market-signals "Copy", en/es). Assistant market tools build their
 * `answer` and recommendation lines from here, so the actions, the "Sample data" sentence and the
 * trademark refusal are code-written, never model-invented. The answer validator also reads it:
 * numbers in this copy ("2 weeks", "1–2 designs") are allowed in an answer.
 */

export type Lang = "en" | "es";

/** Heuristic for the user's language when no tool told us (the mock and the fallback answer). */
export function detectLang(text: string): Lang {
  return /[¿¡ñ]|\b(qu[eé]|cu[aá]les?|cu[aá]ndo|c[oó]mo|mis|mi|precio|tendencia|temporada|dise[ñn]os?|est[aá]n?|debo|fiestas|nicho|ventas|hola)\b/i.test(
    text,
  )
    ? "es"
    : "en";
}

type Copy = Record<Lang, string>;

export const MARKET_COPY = {
  sample: {
    en: "Sample data, not your real market: no market source is connected yet.",
    es: "Datos de muestra, no tu mercado real: todavía no hay una fuente del mercado conectada.",
  },
  sampleBadge: { en: "Sample data", es: "Datos de muestra" },
  tmDropped: {
    en: "I can't look up that niche because it may use a protected name. Ask about one of your designs instead.",
    es: "No puedo buscar ese nicho porque puede usar un nombre protegido. Pregunta por uno de tus diseños.",
  },
  staleNote: {
    en: "This data is older than usual, so treat it with care.",
    es: "Estos datos son más viejos de lo normal; tómalos con cuidado.",
  },
  disagreeNote: {
    en: "Your own sales and outside interest point different ways. This happens; watch it for a few weeks.",
    es: "Tus ventas y el interés de afuera van en direcciones distintas. Pasa a veces; obsérvalo unas semanas.",
  },
  seasonCensus: {
    en: "All US clothing stores, not specific to your niche",
    es: "Todas las tiendas de ropa de EE. UU., no solo tu nicho",
  },
  notEnough: { en: "Not enough data", es: "No hay suficientes datos" },
  unknownNiche: {
    en: "That isn't one of the niches I track. Ask about one of your designs, or a niche like teacher, dog mom or Halloween.",
    es: "Ese no es uno de los nichos que sigo. Pregunta por uno de tus diseños, o por un nicho como maestra, mamá de perro o Halloween.",
  },
  volumeUnknown: { en: "volume effect unknown", es: "efecto en el volumen desconocido" },
  estimate: { en: "Estimate", es: "Estimación" },
} satisfies Record<string, Copy>;

export const BAND_COPY: Record<"high" | "medium" | "low", Copy> = {
  high: { en: "High confidence", es: "Confianza alta" },
  medium: { en: "Medium confidence: test it", es: "Confianza media: pruébalo" },
  low: { en: "Not enough data", es: "No hay suficientes datos" },
};

export const SOURCE_LABEL: Record<SignalSource, string> = {
  own: "Your sales",
  census: "US Census retail trade",
  google_trends: "Google Trends",
  pinterest_trends: "Pinterest Trends",
  amazon_pricing: "Amazon pricing",
  amazon_brand_analytics: "Amazon Brand Analytics",
  walmart_pricing: "Walmart pricing",
  jungle_scout: "Jungle Scout",
};
const SOURCE_LABEL_ES: Partial<Record<SignalSource, string>> = {
  own: "Tus ventas",
  census: "Comercio minorista del Censo de EE. UU.",
  amazon_pricing: "Precios de Amazon",
  walmart_pricing: "Precios de Walmart",
};
export const sourceLabel = (s: SignalSource, lang: Lang) =>
  (lang === "es" ? SOURCE_LABEL_ES[s] : undefined) ?? SOURCE_LABEL[s];

const MONTHS: Record<Lang, string[]> = {
  en: [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ],
  es: [
    "enero",
    "febrero",
    "marzo",
    "abril",
    "mayo",
    "junio",
    "julio",
    "agosto",
    "septiembre",
    "octubre",
    "noviembre",
    "diciembre",
  ],
};
export const monthName = (m: number, lang: Lang) => MONTHS[lang][m - 1] ?? String(m);

export const channelLabel = (c: string) => CHANNEL_RULES[c as Channel]?.label ?? c;

export const money = (cents: number) =>
  `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Source and date, e.g. "Google Trends, week ending 2026-09-20" (spec guardrail 2). */
export function sourceLine(s: { source: SignalSource; asOf: string; mock: boolean }, lang: Lang) {
  const date = s.asOf.slice(0, 10);
  const label = sourceLabel(s.source, lang);
  const sample = s.mock ? ` (${MARKET_COPY.sampleBadge[lang]})` : "";
  return lang === "es" ? `${label}, al ${date}${sample}` : `${label}, as of ${date}${sample}`;
}

/**
 * R1 when nothing is missing on one side: the design is already on every connected channel (stock
 * only), or its blank isn't known (list only). Same action, the empty half left out.
 */
export const R1_PARTIAL: Record<"stockOnly" | "listOnly" | "prepOnly", Copy> = {
  stockOnly: {
    en: "Stock {{blank}} for {{design}} before {{peak}}.",
    es: "Surte {{blank}} para {{design}} antes de {{peak}}.",
  },
  listOnly: {
    en: "List {{design}} on {{channels}} before {{peak}}.",
    es: "Publica {{design}} en {{channels}} antes de {{peak}}.",
  },
  prepOnly: {
    en: "Get {{design}} ready before {{peak}}.",
    es: "Prepara {{design}} antes de {{peak}}.",
  },
};

/** "1 week" / "3 weeks", "1 semana" / "3 semanas". */
export const weeks = (n: number, lang: Lang) =>
  `${n} ${lang === "es" ? (n === 1 ? "semana" : "semanas") : n === 1 ? "week" : "weeks"}`;

/** The fixed action per rule (spec copy R1..R5). Placeholders are filled by code. */
export const RULE_ACTION: Record<"R1" | "R2" | "R3" | "R4" | "R5", Copy> = {
  R1: {
    en: "List {{design}} on {{channels}} and stock {{blank}} before {{peak}}.",
    es: "Publica {{design}} en {{channels}} y surte {{blank}} antes de {{peak}}.",
  },
  R2: {
    en: "Test a price of {{price}} on {{channel}} for 2 weeks.",
    es: "Prueba un precio de {{price}} en {{channel}} por 2 semanas.",
  },
  R3: {
    en: "Raise {{design}} to at least {{floor}}, or stop its ads.",
    es: "Sube {{design}} a por lo menos {{floor}}, o detén sus anuncios.",
  },
  R4: {
    en: "Make 1–2 new designs for the {{niche}} niche.",
    es: "Crea 1 o 2 diseños nuevos para el nicho {{niche}}.",
  },
  R5: {
    en: "Pause ads on {{design}} and move it down your list.",
    es: "Pausa los anuncios de {{design}} y bájalo en tu lista.",
  },
};

export function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? "");
}

/** Every fixed string above, for the validator's allowed numbers. */
export function allCopyText(): string {
  const parts: string[] = [];
  for (const c of [
    ...Object.values(MARKET_COPY),
    ...Object.values(BAND_COPY),
    ...Object.values(RULE_ACTION),
    ...Object.values(R1_PARTIAL),
  ])
    parts.push(c.en, c.es);
  return parts.join("\n");
}
