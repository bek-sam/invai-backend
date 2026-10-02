import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { DesignPhotoAnalysis } from "@invai/contracts";
import type { PhotoAnalysisVars } from "../../src/ai/prompts";
import {
  altTextIssue,
  BANNED_ALT_CLAIMS,
  isPoorBlank,
} from "../../src/ai/validators/photo-analysis";
import { withTenant } from "../../src/db/client";
import { aiJobs } from "../../src/db/schema";
import { analyzeDesignForPhotos } from "../../src/modules/ai/photo-analysis";
import type { EvalTenant } from "../lib/fixtures";
import { loadCases } from "../lib/jsonl";
import { evalMode } from "../lib/mode";
import type { CaseResult, RouteReport } from "../lib/types";

const dir = path.dirname(fileURLToPath(import.meta.url));

/*
 * photo_analysis (T-26-3, ADR 0023). Each case is a design's name, tags and measured palette; the
 * call runs the product path (`analyzeDesignForPhotos`: gateway, validator, one retry, repair).
 * No preview images are attached yet (text + palette only), so detectedText isn't scored here.
 *
 * Plumbing (gates CI): the call completes; the result parses as the contract's
 * DesignPhotoAnalysis; every recommended blank contrasts with the palette (no light on light or
 * dark on dark); every channel has alt text of at most 250 characters with no banned claim; in
 * mock mode the result says `source: "mock"`.
 * Quality (real model): the same, plus `forbid` (a brand or injected word that must not reach alt
 * text or reasons) and `firstTry` (the first answer passed the validator: no retry was needed).
 */

type CaseVars = { designName: string; tags: string[]; palette: PhotoAnalysisVars["palette"] };
type CaseExpect = { forbid?: string };

export async function runPhotoAnalysis(tenant: EvalTenant): Promise<RouteReport> {
  const cases = loadCases<CaseVars, CaseExpect>(path.join(dir, "cases.jsonl"));
  const mode: RouteReport["mode"] = evalMode();
  const results: CaseResult[] = [];
  for (const c of cases) {
    const designId = randomUUID();
    const startedAt = Date.now();
    let error: string | null = null;
    let analysis: DesignPhotoAnalysis | null = null;
    try {
      analysis = await analyzeDesignForPhotos(tenant.companyId, null, {
        designId,
        previewKey: null,
        ...c.vars,
      });
    } catch (err) {
      error = (err as Error).message;
    }
    const latencyMs = Date.now() - startedAt;
    const jobs = await withTenant(tenant.companyId, (tx) =>
      tx
        .select()
        .from(aiJobs)
        .where(and(eq(aiJobs.kind, "photo_analysis"), eq(aiJobs.entityId, designId))),
    );
    const sum = (k: "costCents" | "tokensIn" | "tokensOut" | "cacheReadTokens") =>
      jobs.reduce((a, j) => a + (j[k] ?? 0), 0);

    const fails: string[] = [];
    if (analysis) {
      if (!DesignPhotoAnalysis.safeParse(analysis).success) fails.push("contract");
      for (const r of analysis.recommendedColors)
        if (isPoorBlank(c.vars.palette, r.hex)) fails.push(`contrast:${r.name}`);
      if (!analysis.recommendedColors.length) fails.push("no-colors");
      for (const ch of ["amazon", "etsy", "shopify", "tiktok", "walmart"] as const) {
        const t = analysis.altText[ch];
        if (t == null) fails.push(`alt-missing:${ch}`);
        else if (altTextIssue(t)) fails.push(`alt:${ch}:${altTextIssue(t)}`);
      }
      if (mode === "mock" && analysis.source !== "mock") fails.push("source");
    }
    const own = analysis
      ? [...Object.values(analysis.altText), ...analysis.recommendedColors.map((r) => r.reason)].join(" ")
      : "";
    const forbidHit = c.expect.forbid ? new RegExp(c.expect.forbid, "iu").test(own) : false;
    const claimHit = BANNED_ALT_CLAIMS.test(own);
    const firstTry = jobs.length === 1;
    const plumbingPass = error == null && analysis != null && fails.length === 0;
    const qualityPass = mode === "mock" ? null : plumbingPass && !forbidHit && !claimHit && firstTry;
    results.push({
      id: c.id,
      tags: c.tags,
      plumbingPass,
      qualityPass,
      note: error
        ? `error: ${error}`
        : fails.length
          ? `failed: ${fails.join(",")}`
          : `ok (${analysis?.recommendedColors.map((r) => r.name).join("/")})${forbidHit ? " forbidden word" : ""}${firstTry ? "" : " (retried)"}`,
      costCents: sum("costCents"),
      latencyMs,
      tokensIn: sum("tokensIn"),
      tokensOut: sum("tokensOut"),
      cacheReadTokens: sum("cacheReadTokens"),
      model: jobs[0]?.model ?? "none",
    });
  }
  return { route: "photo_analysis", mode, cases: results };
}
