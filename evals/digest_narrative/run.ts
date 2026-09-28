import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DigestNarrative, DigestNarrativeVars } from "../../src/ai/prompts";
import { digestNarrativePrompt } from "../../src/ai/prompts";
import { validateNarrative } from "../../src/ai/validators/digest";
import { env } from "../../src/env";
import type { EvalTenant } from "../lib/fixtures";
import { callStructured } from "../lib/gateway-run";
import { loadCases } from "../lib/jsonl";
import type { CaseResult, RouteReport } from "../lib/types";

const dir = path.dirname(fileURLToPath(import.meta.url));

/*
 * digest_narrative (T-19-2, spec weekly-digest pipeline 8, AC19–AC20). Each case is one digest's
 * ranked insights and formatted facts; the call goes through the real gateway and the output
 * through the same validator the product runs (validators/digest.ts).
 *
 * Plumbing (gates CI): the call completes with schema-valid output, and, in mock mode, the
 * validator passes (the mock is built to, so the shadow path works with no key).
 * Quality (real model): `valid` says whether the validator should pass; `forbid` is a regex the
 * model's own words (placeholders removed) must never match, e.g. /doubl/ for the injected design
 * name (AC20); `mustRender` is a value that must appear substituted when the output passes.
 */

type CaseVars = {
  lang: "en" | "es";
  insights: { id: string; kind: string; factIds: string[]; template?: string }[];
  facts: { id: string; en: string; es: string }[];
};
type CaseExpect = { valid: boolean; forbid?: string; mustRender?: string };

const PLACEHOLDER = /\{\{\s*[A-Za-z0-9_.:-]+\s*\}\}/g;

export async function runDigestNarrative(tenant: EvalTenant): Promise<RouteReport> {
  const cases = loadCases<CaseVars, CaseExpect>(path.join(dir, "cases.jsonl"));
  const mode: RouteReport["mode"] = env.mocks.ai ? "mock" : "real";
  const results: CaseResult[] = [];
  for (const c of cases) {
    const v = c.vars;
    const vars: DigestNarrativeVars = {
      lang: v.lang,
      insights: v.insights.map((i) => ({ ...i, template: i.template ?? null })),
      facts: v.facts.map((f) => ({ id: f.id, value: f[v.lang] })),
    };
    const res = await callStructured<DigestNarrativeVars, DigestNarrative>(
      {
        companyId: tenant.companyId,
        userId: null,
        kind: "digest_narrative",
        creditKind: "digest_narrative",
        entity: { type: "digest", id: randomUUID() },
      },
      digestNarrativePrompt,
      vars,
    );
    const check = res.output
      ? validateNarrative(res.output, {
          lang: v.lang,
          insights: v.insights,
          facts: v.facts.map((f) => ({ id: f.id, formatted: { en: f.en, es: f.es } })),
        })
      : null;
    const own = res.output
      ? [res.output.headline, ...res.output.items.map((i) => i.text)]
          .join(" ")
          .replace(PLACEHOLDER, " ")
      : "";
    const forbidHit = c.expect.forbid ? new RegExp(c.expect.forbid, "iu").test(own) : false;
    const rendered = check?.ok ? check.rendered.text : "";
    const renderOk = !check?.ok || !c.expect.mustRender || rendered.includes(c.expect.mustRender);
    const plumbingPass = res.error == null && check != null && (mode === "real" || check.ok);
    const qualityPass =
      mode === "mock"
        ? null
        : check != null && check.ok === c.expect.valid && !forbidHit && renderOk;
    results.push({
      id: c.id,
      tags: c.tags,
      plumbingPass,
      qualityPass,
      note: res.error
        ? `error: ${res.error}`
        : check?.ok
          ? `ok${forbidHit ? " (forbidden words in model text)" : ""}${renderOk ? "" : " (value not rendered)"}`
          : `rejected: ${check?.failedRules.join(",")}`,
      costCents: res.costCents,
      latencyMs: res.latencyMs,
      tokensIn: res.tokensIn,
      tokensOut: res.tokensOut,
      cacheReadTokens: res.cacheReadTokens,
      model: res.model,
    });
  }
  return { route: "digest_narrative", mode, cases: results };
}
