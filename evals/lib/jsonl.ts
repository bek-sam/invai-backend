import { readFileSync } from "node:fs";
import type { EvalCase } from "./types";

/** Reads `evals/<route>/cases.jsonl` (one JSON object per line, per eval-template.md). */
export function loadCases<V, E>(path: string): EvalCase<V, E>[] {
  const text = readFileSync(path, "utf8");
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, i) => {
      try {
        return JSON.parse(line) as EvalCase<V, E>;
      } catch (err) {
        throw new Error(`${path}:${i + 1}: invalid JSON (${(err as Error).message})`);
      }
    });
}
