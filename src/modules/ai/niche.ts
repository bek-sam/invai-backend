/*
 * Market niche helpers for the market module (T-18-3). Stub: the agreed signatures from
 * waves/18/wave.md "Agreed interfaces"; the bodies land with T-18-4.
 */

export type NicheOption = { key: string; labelEn: string };

export type ClassifyNicheInput = {
  designId: string;
  name: string;
  tags: string[];
  niches: NicheOption[];
};

export type ClassifyNicheResult = { niche: string | null; confidence: number };

/**
 * Suggests one taxonomy niche for a design (Haiku route through the gateway). Returns `null`
 * when AI credits are out; never throws for that. Callers accept the suggestion only at
 * `confidence >= 0.7`.
 */
export async function classifyDesignNiche(
  _companyId: string,
  _input: ClassifyNicheInput,
): Promise<ClassifyNicheResult | null> {
  return null;
}

/**
 * Drops market terms at or above the trademark risk threshold (wraps `checkTrademarks`) and
 * logs a drop counter. Dropped terms are never returned.
 */
export async function screenMarketTerms(
  _companyId: string,
  terms: string[],
): Promise<{ allowed: string[]; droppedCount: number }> {
  return { allowed: [...terms], droppedCount: 0 };
}
