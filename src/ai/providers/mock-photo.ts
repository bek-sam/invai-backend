import { PHOTO_CHANNELS } from "@invai/contracts";
import type { PhotoAnalysisOutput, PhotoAnalysisVars } from "../prompts";
import { fallbackAltText, luminance, rankBlanks } from "../validators/photo-analysis";

/*
 * Deterministic photo analysis for the mock provider (T-26-3 AC2): the same palette, name and tags
 * always give the same answer. Blanks come from the contrast ranking in code, so a mostly white
 * design never gets a white shirt. No words from the design name reach the output (it is
 * untrusted text and may hold a brand name); the style comes from a fixed word list matched
 * against the tags.
 */

const STYLE_BY_TAG: [RegExp, string, string][] = [
  [/retro|vintage|70s|80s|90s/i, "retro distressed graphic", "fans of vintage style"],
  [
    /floral|flower|botanical|plant|cactus|desert/i,
    "botanical illustration",
    "plant and nature lovers",
  ],
  [/funny|humor|pun|joke|sarcas/i, "bold humor typography", "people who like a funny shirt"],
  [/mom|dad|family|grandma|grandpa/i, "family typography", "family gift shoppers"],
  [/dog|cat|pet|paw/i, "pet illustration", "pet lovers"],
  [/teacher|nurse|work|job/i, "occupation typography", "people proud of their work"],
  [/halloween|christmas|holiday|easter/i, "seasonal holiday graphic", "holiday gift shoppers"],
  [/sport|team|game|ball/i, "sporty graphic", "sports fans"],
];

function styleFor(tags: string[]): { style: string; audience: string } {
  const joined = tags.join(" ");
  for (const [re, style, audience] of STYLE_BY_TAG) if (re.test(joined)) return { style, audience };
  return { style: "graphic print", audience: "casual t-shirt buyers" };
}

function describeColors(v: PhotoAnalysisVars): string {
  const { lightShare, darkShare, transparentShare } = v.palette;
  const tone =
    lightShare >= 0.6
      ? "mostly light"
      : darkShare >= 0.6
        ? "mostly dark"
        : "a mix of light and dark";
  const main = [...v.palette.colors]
    .sort((a, b) => b.share - a.share || a.hex.localeCompare(b.hex))
    .slice(0, 3)
    .map((c) => (luminance(c.hex) > 0.5 ? "light" : luminance(c.hex) > 0.15 ? "mid-tone" : "dark"));
  const bg = transparentShare >= 0.3 ? " on a transparent background" : "";
  return `Sample analysis: the art is ${tone}, with ${main.length ? main.join(", ") : "no measured"} main colors${bg}.`;
}

export function mockPhotoAnalysis(v: PhotoAnalysisVars): PhotoAnalysisOutput {
  const { style, audience } = styleFor(v.tags);
  const blanks = rankBlanks(v.palette).slice(0, 4);
  const main = blanks[0]?.name ?? "White";
  return {
    style,
    audience,
    detectedText: null,
    colorDescription: describeColors(v),
    recommendedColors: blanks.map((b) => ({
      name: b.name,
      hex: b.hex,
      reason: `Sample pick: about ${Math.round(b.ratio * 10) / 10}:1 average contrast with the art.`,
    })),
    sceneSuggestions: [
      {
        kind: "studio",
        description: "Plain light studio backdrop, shirt laid flat.",
        containsPerson: false,
      },
      {
        kind: "flat_lay",
        description: "Flat lay on a wooden table with a few simple props.",
        containsPerson: false,
      },
      {
        kind: "home",
        description: "Shirt folded on a bed in a bright room.",
        containsPerson: false,
      },
    ],
    altText: PHOTO_CHANNELS.map((channel) => ({ channel, text: fallbackAltText(style, main) })),
    imageOrder: PHOTO_CHANNELS.map((channel) => ({
      channel,
      views:
        channel === "etsy" || channel === "tiktok"
          ? ["on_model_white", "front_flat", "folded"]
          : ["front_flat", "on_model_white", "folded"],
    })),
  };
}
