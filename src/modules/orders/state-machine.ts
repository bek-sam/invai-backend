import {
  canTransition,
  deriveOrderStatus,
  ITEM_TRANSITIONS,
  type OrderItemState,
} from "@invai/contracts";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { afterCommit, type Tx } from "../../db/client";
import type { StationKind } from "../../db/schema";
import { orderItems, orderItemTransitions, orders } from "../../db/schema";
import { type Actor, audit } from "../../lib/audit";
import { invalidTransition, notFound } from "../../lib/errors";
import { emit } from "../../lib/outbox";
import { publish } from "../../lib/realtime";

/*
 * The one place an order item changes state. Every call, inside the caller's transaction:
 *   1. locks the item and validates the move against contracts ITEM_TRANSITIONS
 *   2. updates order_items (state, heldFromState, stateChangedAt)
 *   3. appends order_item_transitions + audit_log
 *   4. emits outbox events (item.state_changed plus the specific event for the target state)
 *   5. recomputes the order's cached status from its items
 *   6. after commit: realtime `item.state_changed` and `order.updated`
 */

export { canTransition, ITEM_TRANSITIONS };

const DEFAULT_RISK_WINDOW_MS = 24 * 3600_000;

export type OrderItemRow = typeof orderItems.$inferSelect;

export type TransitionOptions = {
  actor: Actor;
  /** The station kind for floor scans, recorded on the transition and the event. */
  stationKind?: StationKind | null;
  reason?: string | null;
  data?: Record<string, unknown>;
};

export async function transitionItem(
  tx: Tx,
  itemId: string,
  to: OrderItemState,
  opts: TransitionOptions,
): Promise<OrderItemRow> {
  const [item] = await tx.select().from(orderItems).where(eq(orderItems.id, itemId)).for("update");
  if (!item) throw notFound("order_item", itemId);
  const from = item.state;
  if (!canTransition(from, to)) throw invalidTransition("order_item", itemId, from, to);
  if (from === "on_hold" && to !== "cancelled" && item.heldFromState && to !== item.heldFromState) {
    // Releasing a hold restores the held-from state; anything else is a different action.
    throw invalidTransition("order_item", itemId, from, to);
  }

  const now = new Date();
  const [updated] = await tx
    .update(orderItems)
    .set({
      state: to,
      heldFromState: to === "on_hold" ? from : null,
      stateChangedAt: now,
      updatedAt: now,
    })
    .where(eq(orderItems.id, itemId))
    .returning();
  if (!updated) throw notFound("order_item", itemId);

  await tx.insert(orderItemTransitions).values({
    companyId: item.companyId,
    orderItemId: itemId,
    orderId: item.orderId,
    fromState: from,
    toState: to,
    actorKind: opts.actor.kind,
    actorUserId: opts.actor.userId ?? null,
    stationId: opts.actor.stationId ?? null,
    reason: opts.reason ?? null,
    data: opts.data ?? {},
  });

  await audit(tx, {
    companyId: item.companyId,
    actor: opts.actor,
    action: "item.state_changed",
    entityType: "order_item",
    entityId: itemId,
    summary: `${from} -> ${to}${opts.reason ? ` (${opts.reason})` : ""}`,
    data: { from, to, orderId: item.orderId, ...(opts.data ?? {}) },
  });

  const station = opts.stationKind ?? null;
  await emit(tx, item.companyId, "item.state_changed", {
    orderItemId: itemId,
    orderId: item.orderId,
    from,
    to,
    station,
    userId: opts.actor.userId ?? null,
  });
  await emitSpecific(tx, updated, from, opts);

  const status = await recomputeOrderStatus(tx, item.companyId, item.orderId);
  const [order] = await tx
    .select({ shipBy: orders.shipBy })
    .from(orders)
    .where(eq(orders.id, item.orderId))
    .limit(1);
  const atRisk =
    !!order &&
    !["shipped", "delivered", "cancelled"].includes(status) &&
    order.shipBy.getTime() <= Date.now() + DEFAULT_RISK_WINDOW_MS;

  afterCommit(tx, async () => {
    await publish(item.companyId, "item.state_changed", {
      orderItemId: itemId,
      orderId: item.orderId,
      from,
      to,
      station,
    });
    await publish(item.companyId, "order.updated", { orderId: item.orderId, status, atRisk });
  });

  return updated;
}

/** Transition several items with the same options; stops at the first invalid one. */
export async function transitionItems(
  tx: Tx,
  itemIds: string[],
  to: OrderItemState,
  opts: TransitionOptions,
): Promise<OrderItemRow[]> {
  const out: OrderItemRow[] = [];
  for (const id of itemIds) out.push(await transitionItem(tx, id, to, opts));
  return out;
}

async function emitSpecific(
  tx: Tx,
  item: OrderItemRow,
  from: OrderItemState,
  opts: TransitionOptions,
) {
  switch (item.state) {
    case "ready":
      await emit(tx, item.companyId, "item.ready", { orderItemId: item.id });
      break;
    case "needs_mapping":
      await emit(tx, item.companyId, "item.needs_mapping", {
        orderItemId: item.id,
        channelSku: item.channelSku,
      });
      break;
    case "pressed":
      if (item.transferId) {
        await emit(tx, item.companyId, "item.pressed", {
          orderItemId: item.id,
          transferId: item.transferId,
          userId: opts.actor.userId ?? null,
        });
      }
      break;
    case "packed": {
      const open = await tx
        .select({ id: orderItems.id })
        .from(orderItems)
        .where(
          and(eq(orderItems.orderId, item.orderId), inArray(orderItems.state, OPEN_BEFORE_PACKED)),
        );
      await emit(tx, item.companyId, "item.packed", {
        orderItemId: item.id,
        orderId: item.orderId,
        orderComplete: open.length === 0,
      });
      break;
    }
    default:
      break;
  }
  void from;
}

const OPEN_BEFORE_PACKED: OrderItemState[] = [
  "imported",
  "needs_mapping",
  "ready",
  "needs_artwork",
  "on_sheet",
  "transfer_in",
  "pressed",
  "on_hold",
];

/** Recompute and store the order's rollup status; returns the new status. */
export async function recomputeOrderStatus(tx: Tx, companyId: string, orderId: string) {
  const rows = await tx
    .select({ state: orderItems.state })
    .from(orderItems)
    .where(and(eq(orderItems.companyId, companyId), eq(orderItems.orderId, orderId)));
  const status = deriveOrderStatus(rows.map((r) => r.state));
  const now = new Date();
  const keepFirst = (col: AnyPgColumn) => sql`coalesce(${col}, ${now})`;
  await tx
    .update(orders)
    .set({
      status,
      shippedAt:
        status === "shipped" || status === "delivered" ? keepFirst(orders.shippedAt) : undefined,
      deliveredAt: status === "delivered" ? keepFirst(orders.deliveredAt) : undefined,
      cancelledAt: status === "cancelled" ? keepFirst(orders.cancelledAt) : undefined,
      updatedAt: now,
    })
    .where(eq(orders.id, orderId));
  return status;
}
