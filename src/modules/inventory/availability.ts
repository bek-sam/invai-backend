import { and, eq, inArray, sql } from "drizzle-orm";
import { type Tx, withTenant } from "../../db/client";
import { channelConnections, stockLevels } from "../../db/schema";
import { getChannelAdapter } from "../../integrations/channels";
import { logger } from "../../lib/log";
import { freshChannelConn, settingsOf } from "../channels/service";
import { lastPushedQuantities, listPushTargets, markAvailabilityPushed } from "../channels/sku";

const log = logger("inventory.availability");

/*
 * Availability push (decision 0003: opt-in per connection). A listing variant's quantity is its
 * blank's available stock (on hand minus reserved, summed over every location), capped by the
 * variant's `quantityCap`. Planning runs in a transaction and freezes each connection's changes
 * into one push with its own idempotency key; the channel call runs outside any transaction,
 * and a retry of the push reuses the key and the frozen quantities.
 */

/** Pure: the quantity pushed for one listing variant. */
export function pushQuantity(available: number, cap: number | null): number {
  const q = Math.max(0, available);
  return cap != null ? Math.min(q, Math.max(0, cap)) : q;
}

type ConnectionRow = typeof channelConnections.$inferSelect;

/** Only connected API connections whose shop turned the push on, on channels that allow it. */
export function canPushAvailability(conn: ConnectionRow): boolean {
  if (conn.channel === "csv" || conn.mode !== "api" || conn.status !== "connected") return false;
  if (!settingsOf(conn).pushAvailability) return false;
  return !getChannelAdapter(conn.channel, conn.provider).pendingApproval;
}

export type AvailabilityUpdatePlan = {
  listingVariantId: string;
  channelSku: string;
  available: number;
  /** `lastPushedQty` when planned: the push is dropped for a variant pushed since. */
  fromQty: number | null;
};

export type ConnectionPushPlan = { connectionId: string; updates: AvailabilityUpdatePlan[] };

/** Blank id -> available units over every location. */
async function availableByBlank(tx: Tx, companyId: string, blankIds: string[]) {
  if (!blankIds.length) return new Map<string, number>();
  const rows = await tx
    .select({
      id: stockLevels.blankVariantId,
      available: sql<number>`coalesce(sum(${stockLevels.available}), 0)::int`,
    })
    .from(stockLevels)
    .where(and(eq(stockLevels.companyId, companyId), inArray(stockLevels.blankVariantId, blankIds)))
    .groupBy(stockLevels.blankVariantId);
  return new Map(rows.map((r) => [r.id, r.available]));
}

/**
 * The changes to push, per opted-in connection: only variants whose quantity differs from the
 * last pushed one (a never-pushed variant always goes once).
 */
export async function planAvailability(
  tx: Tx,
  companyId: string,
): Promise<{ pushes: ConnectionPushPlan[]; skippedConnections: number }> {
  const targets = await listPushTargets(tx, companyId);
  if (!targets.length) return { pushes: [], skippedConnections: 0 };
  const connIds = [...new Set(targets.map((t) => t.connectionId))];
  const conns = await tx
    .select()
    .from(channelConnections)
    .where(
      and(eq(channelConnections.companyId, companyId), inArray(channelConnections.id, connIds)),
    );
  const open = new Set(conns.filter(canPushAvailability).map((c) => c.id));
  const live = targets.filter((t) => open.has(t.connectionId));
  const availBy = await availableByBlank(tx, companyId, [
    ...new Set(live.map((t) => t.blankVariantId)),
  ]);

  const byConn = new Map<string, AvailabilityUpdatePlan[]>();
  for (const t of live) {
    const available = pushQuantity(availBy.get(t.blankVariantId) ?? 0, t.quantityCap);
    if (available === t.lastPushedQty) continue;
    const list = byConn.get(t.connectionId) ?? [];
    list.push({
      listingVariantId: t.listingVariantId,
      channelSku: t.channelSku,
      available,
      fromQty: t.lastPushedQty,
    });
    byConn.set(t.connectionId, list);
  }
  return {
    pushes: [...byConn].map(([connectionId, updates]) => ({ connectionId, updates })),
    skippedConnections: connIds.length - open.size,
  };
}

export type AvailabilityPush = ConnectionPushPlan & { companyId: string; idempotencyKey: string };

export type AvailabilityPushResult = {
  /** Variants the channel now holds at the planned quantity. */
  pushed: number;
  /** Not sent: the connection was turned off, or the variant was pushed since the plan. */
  skipped: number;
  notFound: number;
  failed: number;
};

/**
 * Send one frozen push. Idempotent: a variant already pushed since the plan is dropped before
 * the call, and the channel dedupes a repeat under the same key (Shopify `@idempotent`, plus its
 * compare-and-set). A thrown channel error propagates so the job retries with the same key.
 */
export async function pushAvailability(push: AvailabilityPush): Promise<AvailabilityPushResult> {
  const { companyId } = push;
  const pre = await withTenant(companyId, async (tx) => {
    const [conn] = await tx
      .select()
      .from(channelConnections)
      .where(
        and(
          eq(channelConnections.companyId, companyId),
          eq(channelConnections.id, push.connectionId),
        ),
      )
      .limit(1);
    if (!conn || !canPushAvailability(conn)) return null;
    const last = await lastPushedQuantities(
      tx,
      companyId,
      push.updates.map((u) => u.listingVariantId),
    );
    const updates = push.updates.filter(
      (u) => last.has(u.listingVariantId) && last.get(u.listingVariantId) === u.fromQty,
    );
    return { conn, updates };
  });
  const empty = { pushed: 0, skipped: push.updates.length, notFound: 0, failed: 0 };
  if (!pre?.updates.length) return empty;

  const adapter = getChannelAdapter(pre.conn.channel, pre.conn.provider);
  const conn = await freshChannelConn(pre.conn);
  const res = await adapter.setAvailability(
    conn,
    pre.updates.map((u) => ({
      listingVariantId: u.listingVariantId,
      channelSku: u.channelSku,
      available: u.available,
    })),
    { idempotencyKey: push.idempotencyKey },
  );
  const results =
    res.results ??
    (res.updated === pre.updates.length
      ? pre.updates.map((u) => ({
          listingVariantId: u.listingVariantId,
          status: "set" as const,
          available: u.available,
          message: null,
        }))
      : []);
  const planned = new Map(pre.updates.map((u) => [u.listingVariantId, u.available]));
  const set = results
    .filter((r) => r.status === "set" && planned.has(r.listingVariantId))
    .map((r) => ({
      listingVariantId: r.listingVariantId,
      available: r.available ?? (planned.get(r.listingVariantId) as number),
    }));
  await withTenant(companyId, (tx) => markAvailabilityPushed(tx, companyId, set));

  const out = {
    pushed: set.length,
    skipped: push.updates.length - pre.updates.length,
    notFound: results.filter((r) => r.status === "not_found").length,
    failed: results.filter((r) => r.status === "failed").length,
  };
  if (out.notFound || out.failed)
    log.warn("availability push incomplete", {
      companyId,
      connectionId: push.connectionId,
      ...out,
      // Ids and channel messages only (no PII); the first few are enough to act on.
      problems: results
        .filter((r) => r.status !== "set")
        .slice(0, 10)
        .map((r) => ({
          listingVariantId: r.listingVariantId,
          status: r.status,
          message: r.message,
        })),
    });
  return out;
}
