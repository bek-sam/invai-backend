import type { DigestActionParams, MarketRecommendation } from "@invai/contracts";
import { r1PastPeak } from "../market/rules";
import { fact, shortDateFact } from "./facts";
import type { Candidate } from "./types";

/*
 * Market watch (spec "Market watch block"): wave 18's stored recommendations become digest
 * candidates. `listDigestMarketItems` already applies R1–R5, band ≥ medium, own designs and niches,
 * staleness and the trademark screen; this adds the digest's own mock rule (AC31: in production a
 * mock-sourced item never shows) and marks which items may take a top-3 action slot (R1 tied to
 * a cross-listing gap or a low blank; R3). R2 and R4 stay in the block.
 */

const enc = encodeURIComponent;

function hrefOf(r: MarketRecommendation): string {
  const d = r.target.designId;
  switch (r.rule) {
    case "R1":
      return d ? `/listings/drafts?designId=${enc(d)}&create=true` : "/catalog/designs";
    case "R2":
    case "R3":
      return d ? `/catalog/designs/${enc(d)}` : "/catalog/designs";
    case "R5":
      return "/analytics/ad-spend";
    default:
      return "/catalog/designs";
  }
}

export function isPromotable(r: MarketRecommendation): boolean {
  if (r.rule === "R3") return true;
  if (r.rule !== "R1") return false;
  return (r.params.channels?.length ?? 0) > 0 || r.params.blankBelowReorderPoint === true;
}

/** The newest outside (non-own) source, else the newest source: what the item cites. */
function citedSource(r: MarketRecommendation) {
  const outside = r.sources.filter((s) => s.source !== "own");
  const pool = outside.length ? outside : r.sources;
  return [...pool].sort((a, b) => b.asOf.localeCompare(a.asOf))[0] ?? null;
}

/**
 * `weekEnd` (the digest week's exclusive end, YYYY-MM-DD) drops an R1 item whose act-by date is
 * before it, or whose "peak under way" month is over (wave 20 R1 timing): the digest never says
 * "before September" once September is here.
 */
export function marketCandidates(
  recs: MarketRecommendation[],
  opts: { mockAllowed: boolean; weekEnd?: string },
): Candidate[] {
  const weekEnd = opts.weekEnd;
  return recs
    .filter((r) => !r.stale && (r.band === "high" || r.band === "medium"))
    .filter((r) => opts.mockAllowed || !r.mock)
    .filter((r) => !weekEnd || !r1PastPeak(r, weekEnd))
    .map((r) => {
      const src = citedSource(r);
      const params: DigestActionParams = {
        ...(r.target.designId ? { designId: r.target.designId } : {}),
        ...((r.target.designName ?? r.params.designName)
          ? { designName: r.target.designName ?? r.params.designName ?? "" }
          : {}),
        ...((r.target.channel ?? r.params.channel)
          ? { channel: r.target.channel ?? r.params.channel }
          : r.params.channels?.[0]
            ? { channel: r.params.channels[0] }
            : {}),
        ...(r.params.blankVariantId ? { blankVariantId: r.params.blankVariantId } : {}),
        ...(r.params.blankName ? { blankName: r.params.blankName } : {}),
      };
      return {
        detector: "market" as const,
        section: "market" as const,
        fingerprint: `market:${r.id}`,
        impactCents: null,
        confidence: r.confidence,
        templateKey: "market.item",
        action: { kind: "market" as const, href: hrefOf(r), params },
        facts: [
          fact(`market.${r.id}.band`, "text", r.band),
          fact(`market.${r.id}.source`, "text", src?.source ?? null),
          shortDateFact(`market.${r.id}.asOf`, src ? src.asOf.slice(0, 10) : null),
          fact(`market.${r.id}.sample`, "text", r.mock ? "sample" : null),
        ],
        recommendation: r,
        promotable: isPromotable(r),
      };
    });
}
