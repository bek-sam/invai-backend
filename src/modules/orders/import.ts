import { type NormalizedOrder, NormalizedOrder as NormalizedOrderSchema } from "@invai/contracts";
import { and, eq, inArray } from "drizzle-orm";
import type { TenantContext } from "../../api/context";
import { afterCommit, type Tx } from "../../db/client";
import { buyerPii, type channelConnections, companies, orderItems, orders } from "../../db/schema";
import { audit } from "../../lib/audit";
import { emit } from "../../lib/outbox";
import { publish } from "../../lib/realtime";
import { loadMatcher, type Matcher, recordRuleUse } from "../channels/sku";
import { withFlags } from "./flags";
import { mapItems } from "./mapping";
import { upsertBuyerPii } from "./pii";
import { buyerRefOf, cancelOrder } from "./service";
import { computeShipBy } from "./shipby";
import { transitionItem } from "./state-machine";

/*
 * The import pipeline every channel shares (CSV, API poll, webhooks):
 *   upsert by (company, channel, channelOrderId) -> explode lines into one item per unit ->
 *   buyer PII into buyer_pii (field-encrypted) -> SKU rules -> personalization render ->
 *   ready / needs_mapping / needs_artwork -> reserve blanks -> outbox + realtime.
 * Re-importing the same order updates what changed (address, totals, note, ship-by) and skips
 * it otherwise, so a CSV can be uploaded twice and a webhook can race the poller.
 */

type ConnectionRow = typeof channelConnections.$inferSelect;
type OrderRow = typeof orders.$inferSelect;

export type ImportSource = "csv" | "api" | "webhook";

export type ImportResult = {
  imported: number;
  updated: number;
  skipped: number;
  cancelled: number;
  orderIds: string[];
  itemsNeedingMapping: number;
  errors: { index: number; channelOrderId: string | null; message: string }[];
};

type Options = {
  source: ImportSource;
  importRunId?: string | null;
  /** Channel order ids the channel reports as cancelled. */
  cancelledChannelOrderIds?: string[];
};

export async function importNormalizedOrders(
  tx: Tx,
  ctx: TenantContext,
  connection: ConnectionRow,
  list: NormalizedOrder[],
  opts: Options,
): Promise<ImportResult> {
  const result: ImportResult = {
    imported: 0,
    updated: 0,
    skipped: 0,
    cancelled: 0,
    orderIds: [],
    itemsNeedingMapping: 0,
    errors: [],
  };
  const [company] = await tx
    .select({ tz: companies.timezone })
    .from(companies)
    .where(eq(companies.id, ctx.companyId))
    .limit(1);
  const timeZone = company?.tz ?? "America/Phoenix";
  const processingDays =
    (connection.settings as { processingDays?: number | null } | null)?.processingDays ?? null;
  const matcher = await loadMatcher(tx);
  const channel = connection.channel;

  for (let index = 0; index < list.length; index++) {
    const parsed = NormalizedOrderSchema.safeParse(list[index]);
    if (!parsed.success) {
      result.errors.push({
        index,
        channelOrderId:
          (list[index] as { channelOrderId?: string } | undefined)?.channelOrderId ?? null,
        message: parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .slice(0, 3)
          .join("; "),
      });
      continue;
    }
    const n = parsed.data;
    const [existing] = await tx
      .select()
      .from(orders)
      .where(and(eq(orders.channel, channel), eq(orders.channelOrderId, n.channelOrderId)))
      .limit(1);
    if (existing) {
      const changed = await updateExisting(tx, ctx, existing, n);
      if (changed) {
        result.updated++;
        await audit(tx, {
          companyId: ctx.companyId,
          actor: ctx.actor,
          action: "order.synced",
          entityType: "order",
          entityId: existing.id,
          summary: `Updated from ${opts.source === "csv" ? "CSV import" : "channel sync"}: ${changed.join(", ")}`,
        });
        await emit(tx, ctx.companyId, "order.updated", { orderId: existing.id });
      } else result.skipped++;
      result.orderIds.push(existing.id);
      continue;
    }
    const { orderId, needsMapping } = await createOrder(tx, ctx, connection, n, {
      timeZone,
      processingDays,
      matcher,
      source: opts.source,
      importRunId: opts.importRunId ?? null,
    });
    result.imported++;
    result.itemsNeedingMapping += needsMapping;
    result.orderIds.push(orderId);
  }

  for (const channelOrderId of opts.cancelledChannelOrderIds ?? []) {
    if (await cancelFromChannel(tx, ctx, channel, channelOrderId)) result.cancelled++;
  }
  await recordRuleUse(tx, matcher);
  return result;
}

async function createOrder(
  tx: Tx,
  ctx: TenantContext,
  connection: ConnectionRow,
  n: NormalizedOrder,
  opts: {
    timeZone: string;
    processingDays: number | null;
    matcher: Matcher;
    source: ImportSource;
    importRunId: string | null;
  },
) {
  const placedAt = new Date(n.placedAt);
  const shipBy = computeShipBy({
    channel: connection.channel,
    placedAt,
    channelShipBy: n.shipBy ? new Date(n.shipBy) : null,
    processingDays: opts.processingDays,
    timeZone: opts.timeZone,
  });
  const units = n.items.reduce((s, i) => s + i.quantity, 0);
  const hasPersonalization = n.items.some((i) =>
    i.personalization.some((p) => (p.answer ?? "").trim() !== ""),
  );
  const [order] = await tx
    .insert(orders)
    .values({
      companyId: ctx.companyId,
      connectionId: connection.id,
      channel: connection.channel,
      channelOrderId: n.channelOrderId,
      orderNo: n.orderNo,
      status: "new",
      placedAt,
      shipBy,
      isRush: n.isRush,
      hasPersonalization,
      shippingMethod: n.shippingMethod,
      buyerNote: n.buyerNote,
      buyerRef: buyerRefOf(ctx.companyId, n.buyerName),
      subtotalCents: n.totals.subtotal,
      shippingCents: n.totals.shipping,
      taxCents: n.totals.tax,
      discountCents: n.totals.discount,
      totalCents: n.totals.total,
      itemCount: units,
      importRunId: opts.importRunId,
    })
    .returning();
  if (!order) throw new Error("order insert failed");

  await tx.insert(buyerPii).values(piiValues(ctx.companyId, order.id, n));

  const itemRows = await tx
    .insert(orderItems)
    .values(
      n.items.flatMap((line, li) =>
        Array.from({ length: line.quantity }, (_, u) => ({
          companyId: ctx.companyId,
          orderId: order.id,
          lineNo: li + 1,
          unitNo: u + 1,
          unitsInLine: line.quantity,
          channelLineId: line.channelLineId,
          channelSku: line.channelSku.trim(),
          channelListingId: line.channelListingId,
          title: line.title,
          variantTitle: line.variantTitle,
          unitPriceCents: line.unitPrice,
          personalization: line.personalization,
          state: "imported" as const,
          shipBy,
          isRush: n.isRush,
        })),
      ),
    )
    .returning();

  await audit(tx, {
    companyId: ctx.companyId,
    actor: ctx.actor,
    action: "order.imported",
    entityType: "order",
    entityId: order.id,
    summary: `Imported from ${
      opts.source === "csv" ? "CSV" : opts.source === "webhook" ? "webhook" : "channel sync"
    }: ${units} unit(s), ship by ${shipBy.toISOString().slice(0, 10)}`,
    data: { source: opts.source, importRunId: opts.importRunId },
  });

  // SKU rules: group matched units by target so each mapping runs once.
  const groups = new Map<
    string,
    { designId: string; blankVariantId: string; ruleId: string; ids: string[] }
  >();
  const unmatched: typeof itemRows = [];
  for (const item of itemRows) {
    const hit = opts.matcher.match(item.channelSku, {
      channel: connection.channel,
      connectionId: connection.id,
    });
    if (!hit) {
      unmatched.push(item);
      continue;
    }
    const key = `${hit.designId}|${hit.blankVariantId}|${hit.ruleId}`;
    const g = groups.get(key) ?? { ...hit, ids: [] };
    g.ids.push(item.id);
    groups.set(key, g);
  }
  for (const item of unmatched) {
    await tx
      .update(orderItems)
      .set({
        flags: withFlags(item.flags, [
          {
            code: "needs_mapping",
            severity: "error",
            message: item.channelSku
              ? `SKU ${item.channelSku} is not mapped`
              : "The line has no SKU",
          },
        ]),
      })
      .where(eq(orderItems.id, item.id));
    await transitionItem(tx, item.id, "needs_mapping", { actor: ctx.actor, reason: "unknown_sku" });
  }
  for (const g of groups.values()) {
    await mapItems(tx, ctx, g.ids, {
      designId: g.designId,
      blankVariantId: g.blankVariantId,
      ruleId: g.ruleId,
      via: "rule",
    });
  }

  await emit(tx, ctx.companyId, "order.imported", {
    orderId: order.id,
    connectionId: connection.id,
    itemIds: itemRows.map((i) => i.id),
  });
  afterCommit(tx, async () => {
    await publish(ctx.companyId, "order.imported", {
      orderId: order.id,
      orderNo: order.orderNo,
      channel: order.channel,
      itemCount: units,
    });
  });
  return { orderId: order.id, needsMapping: unmatched.length };
}

function piiValues(companyId: string, orderId: string, n: NormalizedOrder) {
  const a = n.shipTo;
  return {
    companyId,
    orderId,
    name: a?.name || n.buyerName,
    email: n.buyerEmail ?? a?.email ?? null,
    phone: a?.phone ?? null,
    company: a?.company ?? null,
    street1: a?.street1 ?? null,
    street2: a?.street2 ?? null,
    city: a?.city ?? null,
    state: a?.state ?? null,
    zip: a?.zip ?? null,
    country: a?.country ?? "US",
  };
}

const SHIPPED = new Set(["shipped", "delivered", "cancelled"]);

/** Apply channel-side changes to an existing order; returns what changed (null = unchanged). */
async function updateExisting(
  tx: Tx,
  ctx: TenantContext,
  o: OrderRow,
  n: NormalizedOrder,
): Promise<string[] | null> {
  const changed: string[] = [];
  const set: Partial<typeof orders.$inferInsert> = {};
  const totals = {
    subtotalCents: n.totals.subtotal,
    shippingCents: n.totals.shipping,
    taxCents: n.totals.tax,
    discountCents: n.totals.discount,
    totalCents: n.totals.total,
  };
  if (Object.entries(totals).some(([k, v]) => o[k as keyof typeof totals] !== v)) {
    Object.assign(set, totals);
    changed.push("totals");
  }
  if ((n.buyerNote ?? null) !== (o.buyerNote ?? null)) {
    set.buyerNote = n.buyerNote;
    changed.push("buyer note");
  }
  if ((n.shippingMethod ?? null) !== (o.shippingMethod ?? null)) {
    set.shippingMethod = n.shippingMethod;
    changed.push("shipping method");
  }
  if (n.isRush && !o.isRush) {
    set.isRush = true;
    changed.push("rush");
  }
  if (n.shipBy && new Date(n.shipBy).getTime() !== o.shipBy.getTime() && !SHIPPED.has(o.status)) {
    set.shipBy = new Date(n.shipBy);
    changed.push("ship-by");
  }
  if (Object.keys(set).length) {
    await tx.update(orders).set(set).where(eq(orders.id, o.id));
    if (set.shipBy)
      await tx.update(orderItems).set({ shipBy: set.shipBy }).where(eq(orderItems.orderId, o.id));
  }

  // Address updates before the label is bought (buyer asked the channel to change it).
  if (n.shipTo && !SHIPPED.has(o.status) && o.status !== "partially_shipped") {
    const done = await upsertBuyerPii(tx, piiValues(ctx.companyId, o.id, n));
    if (done === "updated") changed.push("shipping address");
  }
  return changed.length ? changed : null;
}

/** The channel cancelled the order: cancel every open unit (idempotent). */
export async function cancelFromChannel(
  tx: Tx,
  ctx: TenantContext,
  channel: OrderRow["channel"],
  channelOrderId: string,
): Promise<boolean> {
  const [o] = await tx
    .select()
    .from(orders)
    .where(and(eq(orders.channel, channel), eq(orders.channelOrderId, channelOrderId)))
    .limit(1);
  if (!o) return false;
  const open = await tx
    .select({ id: orderItems.id })
    .from(orderItems)
    .where(
      and(
        eq(orderItems.orderId, o.id),
        inArray(orderItems.state, [
          "imported",
          "needs_mapping",
          "ready",
          "needs_artwork",
          "on_sheet",
          "transfer_in",
          "pressed",
          "packed",
          "on_hold",
        ]),
      ),
    );
  if (open.length === 0) return false;
  await cancelOrder(tx, ctx, {
    id: o.id,
    reason: "channel_cancelled",
    note: "Cancelled on the channel",
    orderItemIds: open.map((i) => i.id),
  });
  return true;
}
