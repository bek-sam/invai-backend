/** Niche taxonomy (stub; converted from `invai-docs/product/market-niches.md` in the next commit). */
export type Niche = {
  key: string;
  family: string;
  labelEn: string;
  labelEs: string;
  stems: string[];
  queries: string[];
  peakMonths: number[];
};

export const NICHES: readonly Niche[] = [];

export function nicheLabel(key: string, lang: "en" | "es"): string {
  const n = NICHES.find((x) => x.key === key);
  if (!n) return key;
  return lang === "es" ? n.labelEs : n.labelEn;
}
