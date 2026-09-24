import { CHANNEL_RULES, type Channel } from "@invai/contracts";
import { z } from "zod";
import type { AiRoute } from "../models";

/*
 * Versioned prompt registry. Each prompt has a stable `system` prefix (cached with cache_control:
 * channel rules, style guide) and a `user` renderer for the varying part, which always goes last.
 * Bump `version` whenever the text changes; ai_jobs records `promptId@version` for traces/evals.
 */

export type PromptDef<V, O> = {
  id: string;
  version: number;
  route: AiRoute;
  system: string;
  user: (vars: V) => string;
  schema: z.ZodType<O>;
};

function rulesTable(): string {
  const channels: Channel[] = ["etsy", "amazon", "shopify", "tiktok", "walmart", "ebay"];
  return channels
    .map((c) => {
      const r = CHANNEL_RULES[c].listing;
      return `- ${CHANNEL_RULES[c].label}: title <= ${r.titleMax} chars; description <= ${r.descriptionMax} chars; ${
        r.tagsMax
          ? `up to ${r.tagsMax} tags, each <= ${r.tagMaxLen} chars`
          : "no tags (return an empty list)"
      }; ${r.bulletsMax ? `up to ${r.bulletsMax} bullet points, each <= ${r.bulletMaxLen} chars` : "no bullet points (return an empty list)"}`;
    })
    .join("\n");
}

/* ------------------------------- listing copy ------------------------------- */

export const ListingCopy = z.object({
  title: z.string(),
  description: z.string(),
  tags: z.array(z.string()),
  bullets: z.array(z.string()),
  attributes: z.array(z.object({ key: z.string(), value: z.string() })),
});
export type ListingCopy = z.infer<typeof ListingCopy>;

export type ListingVars = {
  channel: Channel;
  designName: string;
  designTags: string[];
  designText: string | null;
  blank: { brand: string; style: string; styleName: string | null; colors: string[] } | null;
  brief: string | null;
  /** Validation errors from the previous attempt (the one retry). */
  fixErrors: string | null;
};

export const listingCopyPrompt: PromptDef<ListingVars, ListingCopy> = {
  id: "listing_copy",
  version: 3,
  route: "listing_copy",
  system: `You write marketplace listing copy for a small print-on-demand t-shirt shop that presses DTF transfers onto blank apparel.

Style guide:
- Lead the title with what the buyer searches for (the design's theme + "Shirt"/"Tee"), then the style and gift angle. Title case, no ALL CAPS, no emoji, no keyword stuffing.
- Descriptions: a short hook, then fabric/fit facts of the blank, then care instructions. Plain text, short paragraphs.
- Tags are buyer search phrases (2-3 words), all different, no brand names.
- Never mention or imitate brands, sports teams, celebrities, characters or other trademarks, even if the design name contains one.
- Never invent certifications, materials or sizes that are not given.
- Do not write disclosures; the platform adds the AI-use and production-partner disclosure automatically.

Hard limits per channel (they are validated; exceeding any of them fails the draft):
${rulesTable()}

Return only the JSON object in the requested schema. attributes are channel attributes such as material, occasion, style.`,
  user: (v) =>
    [
      `Channel: ${CHANNEL_RULES[v.channel].label}`,
      `Design name: ${v.designName}`,
      v.designTags.length ? `Design tags: ${v.designTags.join(", ")}` : null,
      v.designText ? `Text printed on the design: ${v.designText}` : null,
      v.blank
        ? `Blank: ${v.blank.brand} ${v.blank.style}${v.blank.styleName ? ` (${v.blank.styleName})` : ""}; colors: ${v.blank.colors.join(", ") || "various"}`
        : null,
      v.brief ? `Shop guidance: ${v.brief}` : null,
      v.fixErrors
        ? `Your previous draft broke these channel rules. Fix every one and keep the rest:\n${v.fixErrors}`
        : null,
    ]
      .filter(Boolean)
      .join("\n"),
  schema: ListingCopy,
};

/* ------------------------------ trademark judge ------------------------------ */

export const TrademarkJudgement = z.object({
  judgements: z.array(
    z.object({
      mark: z.string(),
      judgement: z.enum(["conflict", "possible", "unrelated"]),
      reason: z.string(),
    }),
  ),
});
export type TrademarkJudgement = z.infer<typeof TrademarkJudgement>;

export type TrademarkJudgeVars = {
  text: string;
  candidates: { mark: string; owner: string | null; kind: string; matchedText: string }[];
};

export const trademarkJudgePrompt: PromptDef<TrademarkJudgeVars, TrademarkJudgement> = {
  id: "trademark_judge",
  version: 1,
  route: "trademark_judge",
  system: `You screen apparel listing text for trademark conflicts with registered class-25 (clothing) marks. For each candidate mark decide:
- "conflict": the text uses the mark (or a close variant) as a brand, slogan or character on apparel.
- "possible": the mark appears but could plausibly be descriptive or generic use; a human should look.
- "unrelated": the similarity is a coincidence (a common word used in its ordinary meaning, a person's first name, etc.).
You are not giving legal advice; be conservative with "unrelated".`,
  user: (v) =>
    `Listing text:\n${v.text}\n\nCandidate marks:\n${v.candidates
      .map(
        (c) => `- ${c.mark} (${c.kind}${c.owner ? `, ${c.owner}` : ""}) matched "${c.matchedText}"`,
      )
      .join("\n")}`,
  schema: TrademarkJudgement,
};

/* --------------------------------- assistant --------------------------------- */

export const ASSISTANT_PROMPT = {
  id: "assistant",
  version: 2,
  system: `You are the InvAI business assistant for a DTF t-shirt shop. Answer questions about the shop's profit, orders, stock, listings and production using only the tools provided; every tool is read-only and scoped to this shop.
- Call tools for any number you state. Never guess numbers.
- Money comes back in cents; present it as dollars with two decimals. Margins as percentages with one decimal.
- Be brief: a direct answer first, then two or three supporting facts, then one suggestion if it is useful.
- You cannot change anything in the shop; say so if asked to.
- Buyer personal data is not available to you.`,
};

export const PROMPTS = {
  listing_copy: listingCopyPrompt,
  trademark_judge: trademarkJudgePrompt,
} as const;

export function promptRef(p: { id: string; version: number }) {
  return `${p.id}@${p.version}`;
}
