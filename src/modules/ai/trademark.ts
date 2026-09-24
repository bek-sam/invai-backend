import type { TrademarkCheck } from "@invai/contracts";
import { sql } from "drizzle-orm";
import { runStructured } from "../../ai/gateway";
import { trademarkJudgePrompt } from "../../ai/prompts";
import type { TenantContext } from "../../api/context";
import type { Tx } from "../../db/client";
import { env } from "../../env";
import { logger } from "../../lib/log";

const log = logger("ai.trademark");

/*
 * Trademark risk (architecture 8.4): pg_trgm word similarity + whole-word matching of the title,
 * tags, description and design text against the global class-25 `trademark_marks` index.
 * Claude judges the ambiguous hits only when an API key is configured. A risk score, not legal advice.
 */

export type TmSource = TrademarkCheck["matches"][number]["source"];
export type TmMatch = TrademarkCheck["matches"][number] & {
  kind: string;
  exact: boolean;
  risk: number;
};

/** Same normalization as the seed (src/db/seed/trademarks.ts). */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const EXACT_WEIGHT: Record<string, number> = { slogan: 0.9, character: 0.85, word: 0.7 };
const FUZZY_MIN = 0.65;

/** Pure: risk contribution of one match, 0..1. */
export function matchRisk(m: {
  kind: string;
  exact: boolean;
  similarity: number;
  multiWord: boolean;
  judgement: "conflict" | "possible" | "unrelated" | null;
}): number {
  let base = EXACT_WEIGHT[m.kind] ?? 0.7;
  if (m.kind === "word" && m.multiWord) base = 0.85;
  let r = m.exact ? base : base * m.similarity * 0.6;
  if (m.judgement === "conflict") r = Math.max(r, 0.9);
  if (m.judgement === "unrelated") r *= 0.1;
  return r;
}

/** Pure: combine match risks into a 0–100 score and level. */
export function combineRisk(risks: number[]): {
  riskScore: number;
  riskLevel: "low" | "medium" | "high";
} {
  const p = 1 - risks.reduce((acc, r) => acc * (1 - Math.min(Math.max(r, 0), 1)), 1);
  const riskScore = Math.round(p * 100);
  return { riskScore, riskLevel: riskScore >= 60 ? "high" : riskScore >= 25 ? "medium" : "low" };
}

type MarkRow = {
  mark: string;
  normalized: string;
  owner: string | null;
  kind: string;
  serial_no: string | null;
  ws: number;
};

async function candidates(tx: Tx, text: string): Promise<MarkRow[]> {
  const res = await tx.execute<MarkRow>(sql`
    select mark, normalized, owner, kind, serial_no,
      word_similarity(normalized, ${text})::float8 as ws
    from trademark_marks
    where status = 'live' and kind <> 'generic'
      and (word_similarity(normalized, ${text}) >= ${FUZZY_MIN}
        or ${` ${text} `} like '% ' || normalized || ' %')
    order by ws desc
    limit 25`);
  return res.rows;
}

function snippet(text: string, needle: string): string {
  const i = text.indexOf(needle);
  if (i < 0) return text.slice(0, 80);
  return text.slice(Math.max(0, i - 20), i + needle.length + 20).trim();
}

export type TmInput = { source: TmSource; text: string }[];

export async function checkTrademarks(
  tx: Tx,
  ctx: Pick<TenantContext, "companyId" | "userId">,
  sources: TmInput,
  opts: { judge?: boolean; ocrText?: string | null; entity?: { type: string; id: string } } = {},
): Promise<TrademarkCheck> {
  const byMark = new Map<string, TmMatch>();
  for (const s of sources) {
    const text = normalizeText(s.text);
    if (!text) continue;
    for (const row of await candidates(tx, text)) {
      const exact = ` ${text} `.includes(` ${row.normalized} `);
      // Very short marks ("lee", "vans") only count as whole words; fuzzy hits need substance.
      // Fuzzy hits need substance: no short or fragment-y marks ("lee", "in n out") and never
      // from long prose (descriptions), where trigram noise is high.
      if (
        !exact &&
        (row.normalized.length < 5 ||
          row.normalized.split(" ").some((w) => w.length < 3) ||
          row.ws < FUZZY_MIN ||
          s.source === "description")
      )
        continue;
      const similarity = exact ? 1 : Math.min(1, Number(row.ws));
      const match: TmMatch = {
        mark: row.mark,
        serialNo: row.serial_no,
        owner: row.owner,
        similarity,
        matchedText: snippet(text, exact ? row.normalized : (row.normalized.split(" ")[0] ?? "")),
        source: s.source,
        judgement: null,
        kind: row.kind,
        exact,
        risk: 0,
      };
      match.risk = matchRisk({ ...match, multiWord: row.normalized.includes(" ") });
      const prev = byMark.get(row.mark);
      if (!prev || match.risk > prev.risk) byMark.set(row.mark, match);
    }
  }
  let matches = [...byMark.values()].sort((a, b) => b.risk - a.risk).slice(0, 10);

  // Ambiguous: fuzzy hits and single common words. Claude judges them when a key exists.
  const ambiguous = matches.filter((m) => !m.exact || (m.kind === "word" && !m.mark.includes(" ")));
  let judged = false;
  if (opts.judge !== false && !env.mocks.ai && ambiguous.length) {
    try {
      const { output } = await runStructured(
        {
          companyId: ctx.companyId,
          userId: ctx.userId ?? null,
          kind: "trademark_check",
          creditKind: "trademark_check",
          entity: opts.entity ?? null,
        },
        trademarkJudgePrompt,
        {
          text: sources.map((s) => `${s.source}: ${s.text}`).join("\n"),
          candidates: ambiguous.map((m) => ({
            mark: m.mark,
            owner: m.owner,
            kind: m.kind,
            matchedText: m.matchedText,
          })),
        },
      );
      for (const j of output.judgements) {
        const m = matches.find((x) => x.mark.toLowerCase() === j.mark.toLowerCase());
        if (!m) continue;
        m.judgement = j.judgement;
        m.risk = matchRisk({ ...m, multiWord: m.mark.includes(" "), judgement: j.judgement });
      }
      judged = true;
    } catch (err) {
      log.warn("trademark judge failed; using the deterministic score", {
        error: (err as Error).message,
      });
    }
  }
  matches = matches.sort((a, b) => b.risk - a.risk);
  const { riskScore, riskLevel } = combineRisk(matches.map((m) => m.risk));
  return {
    riskScore,
    riskLevel,
    matches: matches.map(({ kind: _k, exact: _e, risk: _r, ...m }) => m),
    explanation: explain(matches, riskLevel, judged),
    ocrText: opts.ocrText ?? null,
    checkedAt: new Date().toISOString(),
  };
}

function explain(matches: TmMatch[], level: string, judged: boolean): string {
  if (!matches.length)
    return "No registered clothing (class 25) marks were found in this text. This is a risk score, not legal advice.";
  const top = matches
    .slice(0, 3)
    .map(
      (m) =>
        `"${m.mark}"${m.owner ? ` (${m.owner})` : ""} ${m.exact ? "appears word for word" : `is similar (${Math.round(m.similarity * 100)}%)`} in the ${m.source.replace("_", " ")}${m.judgement ? `; judged ${m.judgement}` : ""}`,
    )
    .join("; ");
  const advice =
    level === "high"
      ? "Remove or replace these terms before publishing; marketplaces act on trademark complaints quickly."
      : level === "medium"
        ? "Review these matches; ordinary descriptive use may be fine."
        : "Low risk, but double-check the wording.";
  return `${top}. ${advice}${judged ? "" : matches.some((m) => !m.exact) ? " Ambiguous matches were not reviewed by AI." : ""} This is a risk score, not legal advice.`;
}
