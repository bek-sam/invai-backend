import type { DesignPhotoAnalysis, GarmentType, PhotoSceneKind } from "@invai/contracts";
import type { ScenePrompt } from "./types";

/*
 * Scene prompts for the image model (T-27-1 AC5, decision 0022). Built only from fixed vocabulary:
 * nothing the shop or a model wrote (design name, detected text, style, audience, scene
 * descriptions, the blank's catalog name) is copied into the prompt, so no brand word, design
 * text or injected instruction can reach the image model. Free text is only *matched* against
 * fixed word lists to pick a fixed phrase. The rules block is constant and always last.
 *
 * v3 (T-38-2, proposed decision 0037): the prompt adds no person. The base already carries InvAI's
 * own garment (and figure) under a mask, so only the background is drawn. `containsPerson` below
 * is unchanged and still conservative: the disclosure flags do not move this wave (0023 §3).
 *
 * v4 (T-39-2 phase 1b): the studio backdrop tone follows the blank's luma (two fixed phrases, split
 * at 0.85) so the backdrop stays away from the garment's own tone; T-39-1's sweep shows a "light
 * gray" backdrop (drawn near level 200) fails white tees. Other kinds are unchanged.
 *
 * v5 (T-40-3 phase 1): dark blanks (luma below 0.35, needs the blank hex) get their own scene
 * wording; every other blank and every call without a hex keeps the v4 text and ref byte for byte.
 * Wave 39 trial 2 (black tee, T-40-2's table): the cafe's dark backdrop (luma 0.24) removed the
 * garment outline (check 1 0.301, structural); the home frame showed a weaker, haloed edge (66 vs
 * 90) with the hem 0.3 in off; two of three studio frames failed or sat on edge displacement. So the
 * dark wording keeps every setting light and plain behind the garment, keeps props off its outline,
 * and adds one edge sentence (clean sharp edge, no halo, glow or rim light). Fixed phrases only.
 */

export const SCENE_PROMPT_VERSION = 5;
export const SCENE_PROMPT_REF = `scene_prompt@${SCENE_PROMPT_VERSION}`;
/** Version (and ref) of the text light and unknown-color blanks still get. */
export const SCENE_PROMPT_LIGHT_VERSION = 4;
export const SCENE_PROMPT_LIGHT_REF = `scene_prompt@${SCENE_PROMPT_LIGHT_VERSION}`;

/** The one sentence every prompt must carry (imaging restores and composites the print area). */
export const PRINT_AREA_RULE =
  "Leave the print area blank: the marked area on the front of the garment stays plain fabric in the garment's own color, with no print, text, pattern or graphic.";

/** Constant rules, appended to every prompt. Negations live only here. */
export const SCENE_RULES = [
  "Rules:",
  `- ${PRINT_AREA_RULE}`,
  "- Keep the garment exactly as given in the image: same outline, position, size, angle, folds and color. Do not re-pose, resize, move, rotate, re-draw or restyle it.",
  "- No text, letters, numbers, signs, logos, brand names, trademarks or watermarks anywhere in the image.",
  "- No real or recognizable people, no celebrities or public figures, and no children or teenagers. Any person shown is a fictional adult.",
  "- No other clothing with prints or logos.",
  "- Photorealistic product photo for an online shop listing, natural colors, sharp focus on the garment.",
].join("\n");

type SceneDef = { setting: string; person: boolean };

/** Closed list of studio backdrop phrases (T-39-2); `studioBackdrop` picks one from the blank's color. */
const STUDIO_BACKDROP_LIGHT_GRAY = "a seamless light gray backdrop";

function studioSetting(backdrop: string): string {
  return `a clean photo studio with ${backdrop} and soft, even lighting`;
}

/** Blank luma (imaging's scale) at or above which the blank counts as white. */
export const STUDIO_WHITE_LUMA = 0.85;
const FLAT_LIGHT = "flat even light, no gradient, vignette or cast shadow on the backdrop";
const STUDIO_BACKDROP_MID_GRAY = `a plain seamless mid-gray backdrop, neither light nor dark, with ${FLAT_LIGHT}`;
const STUDIO_BACKDROP_PALE = `a plain seamless very pale gray backdrop, almost white, with ${FLAT_LIGHT}`;

/** Blank luma below which the blank counts as dark and gets the v5 wording. */
export const DARK_BLANK_LUMA = 0.35;

/** True when `blankHex` is a valid `#rrggbb` with luma below `DARK_BLANK_LUMA`. */
export function isDarkBlank(blankHex: string | undefined): boolean {
  if (blankHex === undefined) return false;
  const luma = hexLuma(blankHex);
  return luma !== null && luma < DARK_BLANK_LUMA;
}

/** Luma 0..1 of `#rrggbb` as imaging computes it on sRGB: (0.2126 R + 0.7152 G + 0.0722 B) / 255. */
export function hexLuma(hex: string): number | null {
  const m = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(hex);
  if (!m) return null;
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => Number.parseInt(h as string, 16)) as [
    number,
    number,
    number,
  ];
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/**
 * The studio backdrop phrase for a blank color (`#rrggbb`), from a closed list: white blanks
 * (luma >= 0.85) get a mid gray, every other blank a very pale gray. A missing or malformed hex
 * keeps the v3 light gray wording.
 */
export function studioBackdrop(blankHex: string): string {
  const luma = hexLuma(blankHex);
  if (luma === null) return STUDIO_BACKDROP_LIGHT_GRAY;
  return luma >= STUDIO_WHITE_LUMA ? STUDIO_BACKDROP_MID_GRAY : STUDIO_BACKDROP_PALE;
}

/** Per kind: the setting, and whether a person (the figure wearing the garment) appears. */
export const SCENES: Record<PhotoSceneKind, SceneDef> = {
  studio: { setting: studioSetting(STUDIO_BACKDROP_LIGHT_GRAY), person: true },
  home: {
    setting: "a bright, tidy living room with a plain sofa, a potted plant and soft window light",
    person: true,
  },
  outdoor: {
    setting: "a sunny park path with green trees and soft natural light, background gently blurred",
    person: true,
  },
  street: {
    setting: "a quiet city sidewalk with plain brick walls and blank shop windows, softly blurred",
    person: true,
  },
  cafe: {
    setting: "a cozy cafe with wooden tables, plain mugs and warm light, background softly blurred",
    person: true,
  },
  workplace: {
    setting: "a modern, bright studio workspace with plain white walls and a wooden desk",
    person: true,
  },
  flat_lay: {
    setting:
      "a flat lay seen from directly above on a light wooden table, with a few simple props: a green leaf, plain sunglasses and a closed blank notebook",
    person: false,
  },
};

/** v5 settings for dark blanks: light and plain behind the garment, props away from its outline. */
const DARK_SETTINGS: Partial<Record<PhotoSceneKind, string>> = {
  studio: studioSetting(STUDIO_BACKDROP_PALE),
  home: "a bright, tidy living room with plain light walls, a pale sofa set well back and soft, even window light",
  cafe: "a bright cafe with pale walls, light wooden tables set well back and soft, even light, background softly blurred",
  outdoor:
    "a sunny park path with a pale sky, light ground and soft, even natural light, background gently blurred",
};

/** v5 sentence for dark blanks: what must hold along the garment's outline. */
export const DARK_EDGE_RULE =
  "The background right around the garment is lighter than the garment and calm, with a clean sharp garment edge: no halo, glow, rim light or shadow along the outline, and no object touching or overlapping it.";

const GARMENT_WORDS: Record<GarmentType, string> = {
  tee: "t-shirt",
  hoodie: "hoodie",
  crewneck: "crewneck sweatshirt",
  tank: "tank top",
};

/** Color words a blank's catalog name may contribute; everything else (brands, codes) is dropped. */
const COLOR_WORDS = new Set([
  "black",
  "white",
  "gray",
  "grey",
  "heather",
  "charcoal",
  "ash",
  "silver",
  "navy",
  "blue",
  "royal",
  "sky",
  "teal",
  "aqua",
  "turquoise",
  "red",
  "cardinal",
  "maroon",
  "burgundy",
  "wine",
  "green",
  "forest",
  "kelly",
  "olive",
  "sage",
  "mint",
  "military",
  "yellow",
  "gold",
  "mustard",
  "orange",
  "coral",
  "pink",
  "purple",
  "lavender",
  "lilac",
  "brown",
  "chocolate",
  "tan",
  "sand",
  "khaki",
  "cream",
  "natural",
  "ivory",
  "oatmeal",
  "light",
  "dark",
  "pale",
  "deep",
]);

/** Up to three color words from the blank's name, in order; "solid-color" when none. */
export function blankColorWords(blankName: string): string {
  const words = blankName
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => COLOR_WORDS.has(w));
  const unique = [...new Set(words)].slice(0, 3);
  return unique.length ? unique.join(" ") : "solid-color";
}

/** Fixed mood phrases chosen by matching the analysis's style text (never copied). */
const MOODS: [RegExp, string][] = [
  [/retro|vintage|distress/i, "warm, slightly faded film-like color grading"],
  [/botanic|floral|nature|plant|desert/i, "fresh, natural daylight with green accents"],
  [/humor|funny|playful/i, "cheerful, bright and casual mood"],
  [/holiday|seasonal/i, "cozy, festive but plain decor with no symbols or text"],
  [/sport/i, "energetic, crisp daylight"],
  [/minimal|typograph/i, "calm, minimal and uncluttered mood"],
];

function moodFor(analysis: DesignPhotoAnalysis | null): string {
  if (!analysis) return "calm, natural mood";
  for (const [re, phrase] of MOODS) if (re.test(analysis.style)) return phrase;
  if (analysis.lightShare >= 0.6) return "bright, airy mood";
  if (analysis.darkShare >= 0.6) return "warm, slightly moody light";
  return "calm, natural mood";
}

/**
 * Conservative: a person is assumed whenever the kind shows one or the analysis suggested one
 * for this kind. The answer decides the synthetic-performer disclosure (ADR 0023 §3).
 */
export function sceneContainsPerson(
  analysis: DesignPhotoAnalysis | null,
  sceneKind: PhotoSceneKind,
): boolean {
  const suggested = analysis?.sceneSuggestions.some(
    (s) => s.kind === sceneKind && s.containsPerson,
  );
  return SCENES[sceneKind].person || suggested === true;
}

export function buildScenePrompt(
  analysis: DesignPhotoAnalysis | null,
  sceneKind: PhotoSceneKind,
  garment: GarmentType,
  blankName: string,
  /** The blank's `#rrggbb`; optional, and a missing one keeps the v3 wording. */
  colorHex?: string,
): ScenePrompt {
  const scene = SCENES[sceneKind];
  const dark = isDarkBlank(colorHex);
  const setting = dark
    ? (DARK_SETTINGS[sceneKind] ?? scene.setting)
    : sceneKind === "studio" && colorHex !== undefined
      ? studioSetting(studioBackdrop(colorHex))
      : scene.setting;
  const containsPerson = sceneContainsPerson(analysis, sceneKind);
  const garmentPhrase = `a ${blankColorWords(blankName)} ${GARMENT_WORDS[garment]}`;
  const text = [
    `Edit the given image of ${garmentPhrase}: the ${GARMENT_WORDS[garment]} and any figure wearing it are fixed objects and stay exactly where they are, with the same outline, size, angle and color.`,
    `Replace only the background around them with ${setting}.`,
    ...(dark ? [DARK_EDGE_RULE] : []),
    "Do not add any person, body part or second figure to the image.",
    `Lighting and mood: ${moodFor(analysis)}.`,
    "",
    SCENE_RULES,
  ].join("\n");
  return { ref: dark ? SCENE_PROMPT_REF : SCENE_PROMPT_LIGHT_REF, sceneKind, containsPerson, text };
}
