import { median, p95 } from "./stats";
import { cacheHitRate, type RouteReport } from "./types";

/*
 * Console + JSON summary. Format follows eval-template.md's "Report block": pass rate, cost and
 * latency per route, cache hit rate. `plumbingPass` (mode-independent) is what the script's exit
 * code is judged on; `qualityPass` (expect-match) is reported alongside it whenever it's
 * meaningful (see types.ts) so a keyed run shows real quality, not just "it didn't crash".
 */

function rate(n: number, of: number): string {
  return of === 0 ? "n/a" : `${n}/${of} (${((100 * n) / of).toFixed(0)}%)`;
}

export type RouteSummary = {
  route: string;
  mode: RouteReport["mode"];
  skippedReason?: string;
  cases: number;
  plumbingPass: number;
  qualityPass: number | null;
  qualityAssessed: number;
  byTag: Record<string, { plumbingPass: number; qualityPass: number | null; total: number }>;
  costCentsMedian: number;
  costCentsP95: number;
  latencyMsMedian: number;
  latencyMsP95: number;
  cacheHitRate: number;
};

export function summarize(report: RouteReport): RouteSummary {
  const cases = report.cases;
  const byTag: RouteSummary["byTag"] = {};
  for (const c of cases) {
    for (const tag of c.tags) {
      byTag[tag] ??= { plumbingPass: 0, qualityPass: 0, total: 0 };
      const bucket = byTag[tag];
      bucket.total += 1;
      if (c.plumbingPass) bucket.plumbingPass += 1;
      if (c.qualityPass) bucket.qualityPass = (bucket.qualityPass ?? 0) + 1;
    }
  }
  const assessed = cases.filter((c) => c.qualityPass !== null);
  const costs = cases.map((c) => c.costCents);
  const latencies = cases.map((c) => c.latencyMs);
  return {
    route: report.route,
    mode: report.mode,
    skippedReason: report.skippedReason,
    cases: cases.length,
    plumbingPass: cases.filter((c) => c.plumbingPass).length,
    qualityPass: assessed.length ? assessed.filter((c) => c.qualityPass).length : null,
    qualityAssessed: assessed.length,
    byTag,
    costCentsMedian: median(costs),
    costCentsP95: p95(costs),
    latencyMsMedian: median(latencies),
    latencyMsP95: p95(latencies),
    cacheHitRate: cacheHitRate(cases),
  };
}

const cents = (c: number) => `${(c / 100).toFixed(2)}¢`.replace("0.", ".");

export function printRoute(report: RouteReport): RouteSummary {
  const s = summarize(report);
  console.log(`\nRoute: ${report.route}   mode: ${s.mode}`);
  if (s.mode === "skipped") {
    console.log(`  SKIPPED — ${s.skippedReason}`);
    return s;
  }
  console.log(`  Cases: ${s.cases}`);
  console.log(`  Plumbing (schema/structure, gates CI): ${rate(s.plumbingPass, s.cases)}`);
  console.log(
    `  Quality (expect match${s.mode === "mock" ? ", informational only in mock mode" : ""}): ${
      s.qualityAssessed ? rate(s.qualityPass ?? 0, s.qualityAssessed) : "not assessed"
    }`,
  );
  const tagLine = Object.entries(s.byTag)
    .map(([tag, b]) => `${tag} ${b.plumbingPass}/${b.total}`)
    .join(", ");
  if (tagLine) console.log(`  By tag (plumbing): ${tagLine}`);
  console.log(
    `  Cost/call: median ${cents(s.costCentsMedian)}, p95 ${cents(s.costCentsP95)}   latency: median ${s.latencyMsMedian}ms, p95 ${s.latencyMsP95}ms   cache hit: ${(s.cacheHitRate * 100).toFixed(0)}%`,
  );
  const failed = report.cases.filter((c) => !c.plumbingPass);
  if (failed.length) {
    console.log("  Plumbing failures:");
    for (const c of failed) console.log(`    - ${c.id}: ${c.note}`);
  }
  return s;
}

export function printOverall(summaries: RouteSummary[]) {
  const total = summaries.reduce((a, s) => a + s.cases, 0);
  const passed = summaries.reduce((a, s) => a + s.plumbingPass, 0);
  console.log(`\nOverall plumbing: ${rate(passed, total)} across ${summaries.length} route(s).`);
}
