import type { DesignPhotoAnalysis, GarmentType, PhotoSceneKind } from "@invai/contracts";
import type { ScenePrompt } from "./types";

/*
 * Scene prompts for the image model (T-27-1 AC5, decision 0022). Built only from fixed vocabulary:
 * nothing the shop or a model wrote (design name, detected text, style, audience, scene
 * descriptions, the blank's catalog name) is copied into the prompt, so no brand word, design
 * text or injected instruction can reach the image model. Free text is only *matched* against
 * fixed word lists to pick a fixed phrase. The rules block is constant and always last.
 */

export const SCENE_PROMPT_VERSION = 1;
export const SCENE_PROMPT_REF = `scene_prompt@${SCENE_PROMPT_VERSION}`;

/** The one sentence every prompt must carry (imaging restores and composites the print area). */
export const PRINT_AREA_RULE =
  "Leave the print area blank: the marked area on the front of the garment stays plain fabric in the garment's own color, with no print, text, pattern or graphic.";

/** Constant rules, appended to every prompt. Negations live only here. */
export const SCENE_RULES = [
  "Rules:",
  `- ${PRINT_AREA_RULE}`,
  "- Keep the garment's shape, position, size, folds and color as given.",
  "- No text, letters, numbers, signs, logos, brand names, trademarks or watermarks anywhere in the image.",
  "- No real or recognizable people, no celebrities or public figures, and no children or teenagers. Any person shown is a fictional adult.",
  "- No other clothing with prints or logos.",
  "- Photorealistic product photo for an online shop listing, natural colors, sharp focus on the garment.",
].join("\n");

type SceneDef = { setting: string; person: boolean };

/** Per kind: the setting, and whether a person (the figure wearing the garment) appears. */
export const SCENES: Record<PhotoSceneKind, SceneDef> = {
  studio: {
    setting: "a clean photo studio with a seamless light gray backdrop and soft, even lighting",
    person: true,
  },
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
): ScenePrompt {
  const scene = SCENES[sceneKind];
  const containsPerson = sceneContainsPerson(analysis, sceneKind);
  const garmentPhrase = `a ${blankColorWords(blankName)} ${GARMENT_WORDS[garment]}`;
  const subject = containsPerson
    ? `The ${GARMENT_WORDS[garment]} is worn by a fictional adult model with a relaxed pose, face turned away or cropped out of frame.`
    : `The ${GARMENT_WORDS[garment]} lies flat and neatly arranged; no people or body parts.`;
  const text = [
    `Product photo of ${garmentPhrase} in ${scene.setting}.`,
    subject,
    `Lighting and mood: ${moodFor(analysis)}.`,
    "Draw only the background, light and props around the garment as given in the image.",
    "",
    SCENE_RULES,
  ].join("\n");
  return { ref: SCENE_PROMPT_REF, sceneKind, containsPerson, text };
}
