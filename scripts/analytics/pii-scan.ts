import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { FIRST_NAMES, LAST_NAMES, PERSONALIZATION_ANSWERS, STREETS } from "../../src/db/seed/data";

/*
 * Output check for AC10 (spec analytics-first-queries.md, architect A2.4): counts how many seed
 * buyer values appear in a text. The values come from the seed's own pools (names, street lines,
 * personalization answers) and the seed buyer e-mail shape; the buyer table is never read.
 * Prints and returns counts only, never the matched text.
 *
 *   tsx scripts/analytics/pii-scan.ts <file>
 */

const EMAIL = /@example\.com/i;

function pool(): string[] {
  const answers = PERSONALIZATION_ANSWERS.flatMap((a) => Object.values(a)).filter(
    (v): v is string => typeof v === "string",
  );
  // Values with a letter and 3+ characters: bare dates and the empty string are not buyer data.
  const all = [...FIRST_NAMES, ...LAST_NAMES, ...STREETS, ...answers];
  return [...new Set(all.filter((v) => v.length >= 3 && /[A-Za-z]/.test(v)))];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function seedValueHits(text: string): number {
  let hits = EMAIL.test(text) ? 1 : 0;
  for (const value of pool()) {
    // Whole values only: a name inside a longer word (a slug, a column) is not a hit.
    if (new RegExp(`(?<![A-Za-z0-9])${escapeRe(value)}(?![A-Za-z0-9])`, "i").test(text)) hits += 1;
  }
  return hits;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: tsx scripts/analytics/pii-scan.ts <file>");
    process.exit(2);
  }
  console.log(`seed buyer value hits: ${seedValueHits(readFileSync(file, "utf8"))}`);
}
