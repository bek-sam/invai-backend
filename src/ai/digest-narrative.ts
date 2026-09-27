/*
 * Weekly digest AI summary (T-19-2, spec weekly-digest pipeline 8–10). Day-1 stub with the agreed
 * signatures; the route, validator, cost guard and breaker land in the next commit.
 */

export type DigestLang = "en" | "es";
export type DigestSummaryMode = "off" | "shadow" | "on";
export type DigestNarrativeStatus = "ok" | "rejected" | "skipped_budget" | "skipped_off";

/** One computed fact. The model sees `{{id}}`; code substitutes `formatted[lang]`. */
export type NarrativeFact = {
  id: string;
  raw: number | string | null;
  formatted: { en: string; es: string };
};

/** One ranked insight, in display order. `factIds` are the only facts its text may use. */
export type NarrativeInsight = {
  id: string;
  kind: "data_health" | "action" | "win" | "market" | "glance" | "steady";
  factIds: string[];
  /** The code-written template for this insight in `lang`, placeholders unfilled (trusted copy). */
  template?: string;
};

export type DigestNarrativeInput = {
  digestId: string;
  lang: DigestLang;
  insights: NarrativeInsight[];
  facts: NarrativeFact[];
};

export type DigestNarrativeResult = {
  status: DigestNarrativeStatus;
  /** Substituted summary text (status `ok` only). */
  text?: string;
  failedRules?: string[];
  cents: number;
  /** The mode this call ran under. */
  mode: DigestSummaryMode;
  /** True only in mode `on` with status `ok`. In `shadow` the caller stores it and never shows it. */
  showable: boolean;
};

/** Global AI summary mode, breaker-aware. */
export async function digestSummaryMode(): Promise<DigestSummaryMode> {
  return "shadow";
}

export async function generateDigestNarrative(
  _companyId: string,
  _input: DigestNarrativeInput,
): Promise<DigestNarrativeResult> {
  const mode = await digestSummaryMode();
  return { status: "skipped_off", cents: 0, mode, showable: false };
}
