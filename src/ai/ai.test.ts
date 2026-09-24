import { type ListingContent, ValidationResult } from "@invai/contracts";
import { describe, expect, it } from "vitest";
import { tokensToCredits } from "./models";
import { resolvePeriod } from "./periods";
import { stripPii } from "./pii";
import { ListingCopy, listingCopyPrompt } from "./prompts";
import { mockListingCopy, mockProvider, planAssistantCalls } from "./providers/mock";
import { normalizeListing, validateListing, withDisclosures } from "./validators/listing";

const base: ListingContent = {
  title: "Desert Sunset Cactus Shirt",
  description: "A cactus tee.",
  tags: ["cactus shirt"],
  bullets: [],
  attributes: {},
  price: 2800,
  disclosures: ["AI disclosure"],
};

describe("channel validators", () => {
  it("enforces Etsy title, tag count, tag length and characters", () => {
    const r = validateListing("etsy", {
      ...base,
      title: "x".repeat(141),
      tags: [
        ...Array.from({ length: 13 }, (_, i) => `tag ${i}`),
        "one too many",
        "this tag is far too long",
        "bad$tag",
      ],
    });
    expect(ValidationResult.parse(r)).toBeTruthy();
    const rules = r.errors.map((e) => e.rule);
    expect(rules).toContain("title_max_140");
    expect(rules).toContain("tags_max_13");
    expect(rules).toContain("tag_max_len_20");
    expect(rules).toContain("tag_invalid_chars");
    expect(r.ok).toBe(false);
    expect(r.errors.find((e) => e.rule === "tag_max_len_20")?.index).toBe(14);
  });

  it("requires disclosures on Etsy and flags unused tags as a warning", () => {
    const r = validateListing("etsy", { ...base, disclosures: [] });
    expect(r.errors.map((e) => e.rule)).toEqual(["disclosure_required"]);
    expect(r.warnings.map((w) => w.rule)).toContain("tags_unused");
    expect(validateListing("etsy", base).ok).toBe(true);
  });

  it("checks Amazon bullets and ignores tags", () => {
    const r = validateListing("amazon", {
      ...base,
      bullets: ["a", "b", "c", "d", "e", "f"],
    });
    expect(r.errors.map((e) => e.rule)).toEqual(["bullets_max_5"]);
    expect(r.warnings.map((w) => w.rule)).toContain("tags_unsupported");
  });

  it("normalizes and appends both disclosures", () => {
    const n = withDisclosures(
      normalizeListing("etsy", {
        ...base,
        title: "  a   b ",
        tags: ["Cactus", "cactus", " "],
        disclosures: [],
      }),
    );
    expect(n.title).toBe("a b");
    expect(n.tags).toEqual(["Cactus"]);
    expect(n.disclosures).toHaveLength(2);
  });
});

describe("mock provider", () => {
  const vars = {
    channel: "etsy" as const,
    designName: "Desert Sunset Cactus",
    designTags: ["cactus", "desert", "sunset", "boho"],
    designText: null,
    blank: {
      brand: "Comfort Colors",
      style: "CC1717",
      styleName: "Heavyweight",
      colors: ["Pepper", "Ivory"],
    },
    brief: null,
    fixErrors: null,
  };

  it("is deterministic and schema-valid", async () => {
    const a = await mockProvider.structured(listingCopyPrompt, vars);
    const b = await mockProvider.structured(listingCopyPrompt, vars);
    expect(a.output).toEqual(b.output);
    expect(ListingCopy.parse(a.output)).toBeTruthy();
    expect(a.usage.tokensIn).toBeGreaterThan(0);
  });

  it("produces copy that passes every channel's rules", () => {
    for (const channel of ["etsy", "amazon", "shopify", "tiktok", "walmart", "ebay"] as const) {
      const copy = mockListingCopy({ ...vars, channel });
      const content = withDisclosures(
        normalizeListing(channel, {
          title: copy.title,
          description: copy.description,
          tags: copy.tags,
          bullets: copy.bullets,
          attributes: {},
          price: 2800,
          disclosures: [],
        }),
      );
      const r = validateListing(channel, content);
      expect(r.errors, `${channel}: ${JSON.stringify(r.errors)}`).toEqual([]);
    }
    const etsy = mockListingCopy(vars);
    expect(etsy.tags).toHaveLength(13);
    expect(etsy.title.length).toBeLessThanOrEqual(140);
    expect(`${etsy.title} ${etsy.description}`).not.toMatch(/comfort colors/i);
  });

  it("plans tool calls for assistant questions", () => {
    const now = new Date("2026-09-24T15:00:00Z");
    const calls = planAssistantCalls("what was my TikTok margin this week?", now);
    expect(calls).toEqual([
      {
        tool: "get_profit",
        input: {
          dimension: "channel",
          channel: "tiktok",
          from: "2026-09-21T00:00:00.000Z",
          to: "2026-09-25T00:00:00.000Z",
        },
      },
    ]);
    expect(planAssistantCalls("which blanks should I reorder?", now)[0]?.tool).toBe("get_stock");
  });
});

describe("gateway helpers", () => {
  it("converts tokens to credits", () => {
    expect(tokensToCredits({ tokensIn: 10, tokensOut: 10, cacheReadTokens: 0 })).toBe(1);
    expect(tokensToCredits({ tokensIn: 2500, tokensOut: 800, cacheReadTokens: 10_000 })).toBe(5);
  });

  it("strips buyer PII", () => {
    const out = stripPii("Ship to Jane at 2140 E Camelback Rd, jane@x.com, (602) 555-0142");
    expect(out).not.toMatch(/jane@x\.com|555-0142|Camelback/);
  });

  it("resolves relative periods", () => {
    const p = resolvePeriod("last 7 days", new Date("2026-09-24T12:00:00Z"));
    expect(p.from.toISOString()).toBe("2026-09-18T00:00:00.000Z");
  });
});
