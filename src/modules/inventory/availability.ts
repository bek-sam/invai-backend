import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Tx } from "../../db/client";
import { channelConnections, listings, listingVariants, stockLevels } from "../../db/schema";
import { getChannelAdapter } from "../../integrations/channels";
import { logger } from "../../lib/log";
import { settingsOf, toChannelConn } from "../channels/service";

const log = logger("inventory.availability");

/** Pure: the quantity pushed for one listing variant. */
export function pushQuantity(available: number, cap: number | null): number {
  const q = Math.max(0, available);
  return cap != null ? Math.min(q, Math.max(0, cap)) : q;
}

/**
 * Push each listing variant's quantity (its blank's available stock over every location, capped
 * by the per-listing cap) to its channel. Only variants whose quantity changed since the last
 * push are sent. CSV channels are skipped, as are connections whose `pushAvailability` setting
 * is off (the shop opts in per connection).
 */
export async function syncAvailability(tx: Tx, companyId: string) {
  const rows = await tx
    .select({
      variantId: listingVariants.id,
      channelSku: listingVariants.channelSku,
      blankVariantId: listingVariants.blankVariantId,
      cap: listingVariants.quantityCap,
      lastPushedQty: listingVariants.lastPushedQty,
      connectionId: listings.connectionId,
    })
    .from(listingVariants)
    .innerJoin(listings, eq(listings.id, listingVariants.listingId))
    .where(
      and(
        eq(listingVariants.companyId, companyId),
        isNotNull(listingVariants.blankVariantId),
        isNotNull(listingVariants.channelSku),
      ),
    );
  if (!rows.length) return { connections: 0, pushed: 0, skipped: 0 };

  const blankIds = [...new Set(rows.map((r) => r.blankVariantId as string))];
  const avail = await tx
    .select({
      id: stockLevels.blankVariantId,
      available: sql<number>`coalesce(sum(${stockLevels.available}), 0)::int`,
    })
    .from(stockLevels)
    .where(and(eq(stockLevels.companyId, companyId), inArray(stockLevels.blankVariantId, blankIds)))
    .groupBy(stockLevels.blankVariantId);
  const availBy = new Map(avail.map((a) => [a.id, a.available]));

  const connIds = [...new Set(rows.map((r) => r.connectionId))];
  const conns = await tx
    .select()
    .from(channelConnections)
    .where(inArray(channelConnections.id, connIds));

  let pushed = 0;
  let skipped = 0;
  for (const conn of conns) {
    const explicitOff = !settingsOf(conn).pushAvailability;
    if (
      conn.channel === "csv" ||
      conn.mode === "csv" ||
      conn.status === "disconnected" ||
      explicitOff
    ) {
      skipped++;
      continue;
    }
    const changes = rows
      .filter((r) => r.connectionId === conn.id)
      .map((r) => ({
        id: r.variantId,
        channelSku: r.channelSku as string,
        quantity: pushQuantity(availBy.get(r.blankVariantId as string) ?? 0, r.cap),
        last: r.lastPushedQty,
      }))
      .filter((r) => r.quantity !== r.last);
    if (!changes.length) continue;
    try {
      const adapter = getChannelAdapter(conn.channel, conn.provider);
      await adapter.setAvailability(
        toChannelConn(conn),
        changes.map((c) => ({ channelSku: c.channelSku, quantity: c.quantity })),
      );
      for (const c of changes) {
        // Bookkeeping on the channels table so the next run only sends what changed.
        await tx
          .update(listingVariants)
          .set({ lastPushedQty: c.quantity })
          .where(eq(listingVariants.id, c.id));
      }
      pushed += changes.length;
    } catch (err) {
      log.warn("availability push failed", {
        connectionId: conn.id,
        channel: conn.channel,
        error: (err as Error).message,
      });
    }
  }
  return { connections: conns.length, pushed, skipped };
}
