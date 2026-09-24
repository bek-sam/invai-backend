/*
 * Pure reorder math (no database): velocity-based reorder points and the free-freight top-up.
 * Tested in reorder.test.ts.
 */

export type ReorderReason = "below_reorder_point" | "low_cover" | "top_up_to_free_freight";

export type ReorderCandidate = {
  blankVariantId: string;
  supplier: string;
  available: number;
  incoming: number;
  /** Manual point (stock level or blank), or null to derive it from velocity. */
  manualReorderPoint: number | null;
  reorderQty: number | null;
  dailyVelocity: number;
  unitCostCents: number;
  /** Live supplier stock, null when unknown. 0 means "don't order". */
  supplierStock: number | null;
};

export type ReorderParams = { leadTimeDays: number; safetyDays: number; coverDays: number };

export type PlannedLine = {
  blankVariantId: string;
  qty: number;
  reason: ReorderReason;
  reorderPoint: number | null;
  daysOfCover: number | null;
};

export type SupplierPlan = {
  supplier: string;
  threshold: number;
  subtotal: number;
  meetsThreshold: boolean;
  shortfall: number;
  lines: PlannedLine[];
};

/** Reorder point = velocity × (lead + safety days), rounded up; null with no velocity. */
export function effectiveReorderPoint(
  manual: number | null,
  dailyVelocity: number,
  p: Pick<ReorderParams, "leadTimeDays" | "safetyDays">,
): number | null {
  if (manual != null) return manual;
  if (dailyVelocity <= 0) return null;
  return Math.ceil(dailyVelocity * (p.leadTimeDays + p.safetyDays));
}

export function daysOfCover(available: number, dailyVelocity: number): number | null {
  if (dailyVelocity <= 0) return null;
  return Math.max(0, available) / dailyVelocity;
}

/** Units that bring (available + incoming) up to the point plus `coverDays` of demand. */
export function baseSuggestion(c: ReorderCandidate, p: ReorderParams) {
  const point = effectiveReorderPoint(c.manualReorderPoint, c.dailyVelocity, p);
  const position = c.available + c.incoming;
  const cover = daysOfCover(position, c.dailyVelocity);
  const belowPoint = point != null && position < point;
  const lowCover = cover != null && cover < p.leadTimeDays + p.safetyDays;
  if (!belowPoint && !lowCover) return null;
  if (c.supplierStock === 0) return null;
  const target = (point ?? 0) + Math.ceil(c.dailyVelocity * p.coverDays);
  let qty = Math.max(target - position, c.reorderQty ?? 0, 1);
  if (c.supplierStock != null) qty = Math.min(qty, c.supplierStock);
  if (qty <= 0) return null;
  return {
    qty,
    reason: (belowPoint ? "below_reorder_point" : "low_cover") as ReorderReason,
    point,
  };
}

/**
 * Suggestions per supplier. When a supplier's subtotal is under its free-freight threshold we
 * add units one at a time to whichever variant would have the fewest days of cover after the
 * order (the most-needed shirt), until the threshold is reached. Suppliers with nothing below
 * their point get no suggestion at all (we never order just to earn free freight).
 */
export function planReorder(
  candidates: ReorderCandidate[],
  thresholds: Record<string, number>,
  p: ReorderParams,
): SupplierPlan[] {
  const bySupplier = new Map<string, ReorderCandidate[]>();
  for (const c of candidates) {
    const list = bySupplier.get(c.supplier) ?? [];
    list.push(c);
    bySupplier.set(c.supplier, list);
  }
  const plans: SupplierPlan[] = [];
  for (const [supplier, list] of bySupplier) {
    const qty = new Map<string, number>();
    const lines = new Map<string, PlannedLine>();
    for (const c of list) {
      const s = baseSuggestion(c, p);
      if (!s) continue;
      qty.set(c.blankVariantId, s.qty);
      lines.set(c.blankVariantId, {
        blankVariantId: c.blankVariantId,
        qty: s.qty,
        reason: s.reason,
        reorderPoint: s.point,
        daysOfCover: daysOfCover(c.available, c.dailyVelocity),
      });
    }
    if (!lines.size) continue;
    const threshold = thresholds[supplier] ?? 0;
    const cost = new Map(list.map((c) => [c.blankVariantId, c.unitCostCents]));
    let subtotal = [...qty].reduce((s, [id, n]) => s + n * (cost.get(id) ?? 0), 0);

    const pool = list.filter((c) => c.dailyVelocity > 0 && c.unitCostCents > 0);
    const fallback = pool.length ? pool : list.filter((c) => lines.has(c.blankVariantId));
    let guard = 0;
    while (subtotal < threshold && fallback.length && guard++ < 5000) {
      let best: ReorderCandidate | null = null;
      let bestCover = Number.POSITIVE_INFINITY;
      for (const c of fallback) {
        const have = qty.get(c.blankVariantId) ?? 0;
        if (c.supplierStock != null && have >= c.supplierStock) continue;
        const cover =
          c.dailyVelocity > 0
            ? (c.available + c.incoming + have) / c.dailyVelocity
            : Number.MAX_SAFE_INTEGER - 1 + have;
        if (cover < bestCover) {
          bestCover = cover;
          best = c;
        }
      }
      if (!best) break;
      const id = best.blankVariantId;
      qty.set(id, (qty.get(id) ?? 0) + 1);
      subtotal += best.unitCostCents;
      if (!lines.has(id)) {
        lines.set(id, {
          blankVariantId: id,
          qty: 0,
          reason: "top_up_to_free_freight",
          reorderPoint: effectiveReorderPoint(best.manualReorderPoint, best.dailyVelocity, p),
          daysOfCover: daysOfCover(best.available, best.dailyVelocity),
        });
      }
    }
    const out = [...lines.values()].map((l) => ({ ...l, qty: qty.get(l.blankVariantId) ?? l.qty }));
    out.sort((a, b) => (a.daysOfCover ?? 1e9) - (b.daysOfCover ?? 1e9));
    plans.push({
      supplier,
      threshold,
      subtotal,
      meetsThreshold: subtotal >= threshold,
      shortfall: Math.max(0, threshold - subtotal),
      lines: out,
    });
  }
  return plans;
}
