import { MARKET_CONFIG } from "./config";
import { NICHES, type Niche } from "./niches";

/*
 * Design → niche mapping (spec step 2.2): stems first (≤ 2 niches, most matched stems), then one
 * small-model classification accepted at confidence ≥ 0.7, else unclassified. A shop correction
 * always wins and is handled by the caller (it never reaches the mapper). Pure except for the
 * injected classifier.
 */

/** Lowercase, strip accents ("maestría" → "maestria"), keep ASCII letters and digits. */
export function normalizeTerm(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();
}

/**
 * Tokens of the design's tags and name: each word, plus each tag's words joined ("dog mom" →
 * "dogmom") so compound stems like `dogmom` and `mothersday` match.
 */
export function designTokens(name: string, tags: string[]): Set<string> {
  const out = new Set<string>();
  for (const text of [name, ...tags]) {
    const words = normalizeTerm(text)
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
    for (const w of words) out.add(w);
    if (words.length > 1) out.add(words.join(""));
  }
  return out;
}

/** A stem of 3 characters or fewer matches the whole token only; longer stems match a prefix. */
export function stemMatches(stem: string, token: string): boolean {
  return stem.length <= 3 ? token === stem : token.startsWith(stem);
}

export function matchedStems(niche: Niche, tokens: Set<string>): number {
  let n = 0;
  for (const stem of niche.stems) {
    for (const t of tokens) {
      if (stemMatches(stem, t)) {
        n++;
        break;
      }
    }
  }
  return n;
}

/** Up to 2 niches with the most matched stems (ties keep taxonomy order). */
export function stemNiches(
  name: string,
  tags: string[],
  niches: readonly Niche[] = NICHES,
): string[] {
  const tokens = designTokens(name, tags);
  const scored = niches
    .map((n, i) => ({ key: n.key, i, score: matchedStems(n, tokens) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.slice(0, 2).map((x) => x.key);
}

export type Mapping = {
  niches: string[];
  source: "stems" | "model" | "unclassified";
  confidence: number | null;
};

export type Classifier = (input: {
  designId: string;
  name: string;
  tags: string[];
  niches: { key: string; labelEn: string }[];
}) => Promise<{ niche: string | null; confidence: number } | null>;

/**
 * Maps one design. The classifier returns `null` when AI credits are out: the design then stays
 * unclassified (own-data signals still compute).
 */
export async function mapDesign(
  design: { id: string; name: string; tags: string[] },
  classify: Classifier | null,
  allowed: readonly Niche[] = NICHES,
): Promise<Mapping> {
  const stems = stemNiches(design.name, design.tags, allowed);
  if (stems.length) return { niches: stems, source: "stems", confidence: null };
  if (classify) {
    const res = await classify({
      designId: design.id,
      name: design.name,
      tags: design.tags,
      niches: allowed.map((n) => ({ key: n.key, labelEn: n.labelEn })),
    });
    if (
      res?.niche &&
      res.confidence >= MARKET_CONFIG.confidence.mapperMin &&
      allowed.some((n) => n.key === res.niche)
    ) {
      return { niches: [res.niche], source: "model", confidence: res.confidence };
    }
  }
  return { niches: [], source: "unclassified", confidence: null };
}
