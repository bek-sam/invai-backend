import { and, eq, isNull } from "drizzle-orm";
import type { Tx } from "../../db/client";
import { orderItems } from "../../db/schema";

/*
 * Late preview backfill (B-233 rest, T-P5-2, architect ruling R2 in
 * `waves/P5/reviews/plan-architect.md`). An item can be mapped to a design before that design's
 * own preview has rendered (`mapping.ts` copies `designFiles.previewKey` at map time, still null
 * then). `catalog.renderDesignPreviews` calls this in the same short `withTenant` transaction
 * that writes the design file's `previewKey`, so the item's thumbnail catches up without a remap.
 *
 * `IS NULL` / `= 'none'` guard every column this can touch, which makes a retry or a duplicate
 * call a no-op once the first run lands: an item with its own artwork (personalized, templated)
 * or an existing preview key is never overwritten.
 */
export async function backfillItemPreviews(
  tx: Tx,
  companyId: string,
  opts: { designId: string; placement: string; previewKey: string },
): Promise<number> {
  const rows = await tx
    .update(orderItems)
    .set({ artworkPreviewKey: opts.previewKey })
    .where(
      and(
        eq(orderItems.companyId, companyId),
        eq(orderItems.designId, opts.designId),
        eq(orderItems.placement, opts.placement),
        isNull(orderItems.artworkPreviewKey),
        isNull(orderItems.artworkKey),
        eq(orderItems.artworkStatus, "none"),
      ),
    )
    .returning({ id: orderItems.id });
  return rows.length;
}
