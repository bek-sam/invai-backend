/** Median and p95, nearest-rank (no interpolation — fine for the small case counts here). */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)] as number;
}

export function median(values: number[]): number {
  return percentile(
    [...values].sort((a, b) => a - b),
    50,
  );
}

export function p95(values: number[]): number {
  return percentile(
    [...values].sort((a, b) => a - b),
    95,
  );
}
