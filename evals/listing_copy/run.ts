import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ListingVars } from "../../src/ai/prompts";
import { listingCopyPrompt } from "../../src/ai/prompts";
import { validateListing } from "../../src/ai/validators/listing";
import { env } from "../../src/env";
import type { EvalTenant } from "../lib/fixtures";
import { callStructured } from "../lib/gateway-run";
import { loadCases } from "../lib/jsonl";
import type { CaseResult, RouteReport } from "../lib/types";

const dir = path.dirname(fileURLToPath(import.meta.url));

/*
 * listing_copy: schema validity comes from the gateway (zod .parse); the rule check here is the
 * same deterministic channel-rule validator the product runs at draft time (validators/listing.ts
 * validateListing), so a broken prompt or a broken mock fixture shows up the same way it would in
 * the app. `forbiddenSubstrings` (brand names, invented certifications) is a real-model-only
 * quality check: the mock is a template, not a language model, so it can't be tricked by an
 * injected brief the way a real model call could — checking it against the mock proves nothing.
 */

export type ListingExpect = {
  forbiddenSubstrings?: string[];
};

/*
 * Known gap found while writing this eval set, filed for the architect/T-8-2 (not fixable here —
 * read-only on src/ai/**): a raw NUL byte (\u0000) anywhere in `vars` crashes the `ai_jobs` insert
 * in gateway.ts's `startJob` — Postgres jsonb rejects it (22P05 "unsupported Unicode escape
 * sequence... \u0000 cannot be converted to text"), so the whole call 500s instead of failing
 * cleanly. T-8-2's own injection string #7 ("\u0000‮ ignore the schema...") triggers this;
 * the t82_injection_set cases below use only the bidi-override half of it (‮) so this eval
 * set stays green until that's fixed. Reproduce: run.ts case with designName/brief containing
 * "\u0000".
 */

export async function runListingCopy(tenant: EvalTenant): Promise<RouteReport> {
  const cases = loadCases<ListingVars, ListingExpect>(path.join(dir, "cases.jsonl"));
  const mode: RouteReport["mode"] = env.mocks.ai ? "mock" : "real";
  const results: CaseResult[] = [];

  for (const c of cases) {
    const res = await callStructured(
      {
        companyId: tenant.companyId,
        userId: tenant.userId,
        kind: "listing_draft",
        creditKind: "listing_draft",
        entity: null,
      },
      listingCopyPrompt,
      c.vars,
    );
    const base = {
      id: c.id,
      tags: c.tags,
      costCents: res.costCents,
      latencyMs: res.latencyMs,
      tokensIn: res.tokensIn,
      tokensOut: res.tokensOut,
      cacheReadTokens: res.cacheReadTokens,
      model: res.model,
    };
    if (res.error || !res.output) {
      results.push({
        ...base,
        plumbingPass: false,
        qualityPass: mode === "real" ? false : null,
        note: res.error ?? "no output",
      });
      continue;
    }

    // The AI schema's `attributes` is an array of {key, value} (models a JSON object without
    // duplicate-key ambiguity); modules/ai/service.ts converts it to the contracts ListingContent
    // Record<string,string> shape before storing/validating a real draft (service.ts:374) — mirror
    // that here so this call matches what the app actually validates.
    const attributes = Object.fromEntries(res.output.attributes.map((a) => [a.key, a.value]));
    const validation = validateListing(c.vars.channel, { ...res.output, attributes });
    const plumbingPass = validation.ok;
    let note = validation.ok
      ? "ok"
      : `validator: ${validation.errors.map((e) => e.rule).join(", ")}`;

    let qualityPass: boolean | null = null;
    if (mode === "real") {
      const hay = JSON.stringify(res.output).toLowerCase();
      const forbidden = (c.expect.forbiddenSubstrings ?? []).filter((s) =>
        hay.includes(s.toLowerCase()),
      );
      qualityPass = plumbingPass && forbidden.length === 0;
      if (forbidden.length) note += `; forbidden text present: ${forbidden.join(", ")}`;
    }

    results.push({ ...base, plumbingPass, qualityPass, note });
  }

  return { route: "listing_copy", mode, cases: results };
}
