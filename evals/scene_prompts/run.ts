import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DesignPhotoAnalysis, GarmentType, PhotoSceneKind } from "@invai/contracts";
import {
  buildScenePrompt,
  mockImageProvider,
  PRINT_AREA_RULE,
  SCENE_RULES,
} from "../../src/ai/images";
import { decodePng, encodePng } from "../../src/ai/images/png";
import type { EvalTenant } from "../lib/fixtures";
import { loadCases } from "../lib/jsonl";
import type { CaseResult, RouteReport } from "../lib/types";

const dir = path.dirname(fileURLToPath(import.meta.url));

/*
 * scene_prompts (T-27-1 AC5, decision 0022). Deterministic: no model is called. Each case is a
 * design analysis (often holding brand words, design text, celebrities, children, injections or
 * PII in the fields a model or shop wrote), a scene kind, a garment and the blank's catalog name.
 * The built prompt must:
 *  - contain none of the case's `forbid` words (design text, brands, names, injected words);
 *  - keep the variable part (everything before the constant rules) free of person and brand
 *    words (child, kid, teen, celebrity, famous, logo, brand, trademark, real person);
 *  - carry the print-area rule and end with the constant rules block;
 *  - set containsPerson as expected (conservative).
 * Then the mock provider draws the scene from a small blank base: PNG at a provider size, the
 * same containsPerson, deterministic bytes. Quality equals plumbing here: the rules are the bar.
 */

type Vars = {
  analysis: Partial<DesignPhotoAnalysis> | null;
  sceneKind: PhotoSceneKind;
  garment: GarmentType;
  blankName: string;
};
type Expect = { forbid: string[]; containsPerson: boolean };

const PERSON_OR_BRAND =
  /\b(child|children|kid|kids|baby|babies|teen|teens|teenager|minor|celebrit\w*|famous|logo|logos|brand|brands|trademark\w*|real person)\b/i;

function fullAnalysis(a: Partial<DesignPhotoAnalysis> | null): DesignPhotoAnalysis | null {
  if (!a) return null;
  return {
    designId: "00000000-0000-4000-8000-000000000001",
    source: "model",
    model: null,
    palette: [],
    lightShare: 0.3,
    darkShare: 0.3,
    transparentShare: 0.3,
    style: "",
    audience: "",
    detectedText: null,
    colorDescription: "",
    recommendedColors: [],
    contrastWarnings: [],
    sceneSuggestions: [],
    altText: {},
    imageOrder: {},
    creditsUsed: 0,
    analyzedAt: new Date(0).toISOString(),
    ...a,
  };
}

/** A small blank garment base and mask (print area opaque), like imaging's scene-base. */
function smallBase() {
  const n = 256;
  const data = new Uint8Array(n * n * 4);
  const mdata = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = (y * n + x) * 4;
      const garment = x >= 70 && x < 186 && y >= 60 && y < 220;
      data.set(garment ? [40, 40, 40, 255] : [255, 255, 255, 255], i);
      const prot = x >= 100 && x < 156 && y >= 90 && y < 150;
      mdata.set([0, 0, 0, prot ? 255 : 0], i);
    }
  }
  return {
    base: encodePng({ width: n, height: n, data }),
    mask: encodePng({ width: n, height: n, data: mdata }, { alpha: true }),
  };
}

export async function runScenePrompts(_tenant: EvalTenant): Promise<RouteReport> {
  const cases = loadCases<Vars, Expect>(path.join(dir, "cases.jsonl"));
  const { base, mask } = smallBase();
  const results: CaseResult[] = [];
  for (const c of cases) {
    const fails: string[] = [];
    const started = Date.now();
    let model = "none";
    try {
      const p = buildScenePrompt(
        fullAnalysis(c.vars.analysis),
        c.vars.sceneKind,
        c.vars.garment,
        c.vars.blankName,
      );
      const lower = p.text.toLowerCase();
      for (const w of c.expect.forbid) if (lower.includes(w.toLowerCase())) fails.push(`forbid:${w}`);
      const variable = p.text.slice(0, p.text.lastIndexOf(SCENE_RULES));
      const hit = PERSON_OR_BRAND.exec(variable);
      if (hit) fails.push(`variable:${hit[0]}`);
      if (!p.text.includes(PRINT_AREA_RULE)) fails.push("print-area-rule");
      if (!p.text.endsWith(SCENE_RULES)) fails.push("rules-last");
      if (p.containsPerson !== c.expect.containsPerson) fails.push("containsPerson");
      const input = { baseImage: base, mask, prompt: p, sizePx: 1024 };
      const a = await mockImageProvider.generateScene(input);
      const b = await mockImageProvider.generateScene(input);
      model = a.model;
      const img = decodePng(a.image);
      if (`${img.width}x${img.height}` !== "1024x1024") fails.push("size");
      if (!a.image.equals(b.image)) fails.push("not-deterministic");
      if (a.containsPerson !== p.containsPerson) fails.push("mock-person");
      if (a.costCents !== 0) fails.push("mock-cost");
    } catch (err) {
      fails.push(`error:${(err as Error).message}`);
    }
    const pass = fails.length === 0;
    results.push({
      id: c.id,
      tags: c.tags,
      plumbingPass: pass,
      qualityPass: pass,
      note: pass ? "ok" : `failed: ${fails.join(",")}`,
      costCents: 0,
      latencyMs: Date.now() - started,
      tokensIn: 0,
      tokensOut: 0,
      cacheReadTokens: 0,
      model,
    });
  }
  return { route: "scene_prompts", mode: "mock", cases: results };
}
