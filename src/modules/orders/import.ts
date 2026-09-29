import { type NormalizedOrder, NormalizedOrder as NormalizedOrderSchema } from "@invai/contracts";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { TenantContext } from "../../api/context";
import { afterCommit, type Tx } from "../../db/client";
import {
  auditLog,
  buyerPii,
  type channelConnections,
  companies,
  orderItems,
  orderItemTransitions,
  orders,
} from "../../db/schema";
import type { ChannelHold, ChannelLineCancel } from "../../integrations/channels/types";
import { audit } from "../../lib/audit";
import { emit } from "../../lib/outbox";
import { publish } from "../../lib/realtime";
import { sanitizeDeep } from "../../lib/text-safety";
import { loadMatcher, type Matcher, recordRuleUse } from "../channels/sku";
import { withFlags } from "./flags";
import { mapItems } from "./mapping";
import { upsertBuyerPii } from "./pii";
import { buyerRefOf, cancelOrder, holdOrder } from "./service";
import { computeShipBy, type ShipDays } from "./shipby";
import { transitionItem } from "./state-machine";

/*
 * The import pipeline every channel shares (CSV, API poll, webhooks):
 *   upsert by (company, channel, channelOrderId) -> explode lines into one item per unit ->
 *   buyer PII into buyer_pii (field-encrypted) -> SKU rules -> personalization render ->
 *   ready / needs_mapping / needs_artwork -> reserve blanks -> outbox + realtime.
 * Re-importing the same order updates what changed (address, totals, note, ship-by, lines) and
 * skips it otherwise, so a CSV can be uploaded twice and a webhook can race the poller. A payload
 * whose channel timestamp is older than `orders.channel_updated_at` is ignored (T-7-4, B-12).
 */

type ConnectionRow = typeof channelConnections.$inferSelect;
type OrderRow = typeof orders.$inferSelect;
type ItemRow = typeof orderItems.$inferSelect;

export type ImportSource = "csv" | "api" | "webhook";

export type ImportResult = {
  imported: number;
  updated: number;
  skipped: number;
  cancelled: number;
  /** Payloads older than what was already applied (skipped too; T-7-4). */
  stale: number;
  /** Orders put on hold by a channel signal (buyer cancel request, TikTok ON_HOLD). */
  held: number;
  orderIds: string[];
  /** Existing orders whose payload was stale: callers must not archive that payload. */
  staleOrderIds: string[];
  itemsNeedingMapping: number;
  errors: { index: number; channelOrderId: string | null; message: string }[];
};

type Options = {
  source: ImportSource;
  importRunId?: string | null;
  /** Channel order ids the channel reports as cancelled. */
  cancelledChannelOrderIds?: string[];
  /** Orders the channel says must not go to production yet (T-7-4, B-12). */
  holds?: ChannelHold[];
  /** Single lines the channel cancelled (Walmart CSV line status). */
  cancelledLines?: ChannelLineCancel[];
};

// Each hold signal holds an order once; a hold the shop released stays released.
export type { ChannelHold, ChannelLineCancel };

/** What an import run needs to build and route units. */
type Run = {
  timeZone: string;
  processingDays: number | null;
  shipDays: ShipDays;
  matcher: Matcher;
  source: ImportSource;
  importRunId: string | null;
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
    stale: 0,
    held: 0,
    orderIds: [],
    staleOrderIds: [],
    itemsNeedingMapping: 0,
    errors: [],
  };
  // B-99: one import per connection at a time (CSV chunk, poll and webhook can overlap). The
  // lock ends with the transaction; ON CONFLICT in createOrder covers two connections of one
  // channel importing the same order.
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`order_import:${connection.id}`}, 0))`,
  );
  const [company] = await tx
    .select({ tz: companies.timezone, settings: companies.settings })
    .from(companies)
    .where(eq(companies.id, ctx.companyId))
    .limit(1);
  const matcher = await loadMatcher(tx);
  const channel = connection.channel;
  const run: Run = {
    timeZone: company?.tz ?? "America/Phoenix",
    // Etsy CSV shops: the listing's processing time, set on the connection.
    processingDays:
      (connection.settings as { processingDays?: number | null } | null)?.processingDays ?? null,
    shipDays: {
      shipsSaturday:
        (company?.settings as { shipsSaturday?: boolean } | null)?.shipsSaturday === true,
    },
    matcher,
    source: opts.source,
    importRunId: opts.importRunId ?? null,
  };

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
    // Shared import pipeline for CSV, API poll and webhooks (see the module comment above): none
    // of that text comes through an oRPC input, so it never sees `orpc.ts`'s sanitizer. Same
    // helper, applied once here, right after validation and before the first raw insert/update of
    // this order's text (T-8-6; a NUL byte in `buyerNote` used to crash the `orders` insert).
    const n = sanitizeDeep(parsed.data);
    const find = async () =>
      (
        await tx
          .select()
          .from(orders)
          .where(and(eq(orders.channel, channel), eq(orders.channelOrderId, n.channelOrderId)))
          .limit(1)
      )[0];
    let existing = await find();
    if (!existing) {
      const created = await createOrder(tx, ctx, connection, n, run);
      if (created) {
        result.imported++;
        result.itemsNeedingMapping += created.needsMapping;
        result.orderIds.push(created.orderId);
        continue;
      }
      // Another transaction created it after our read (ON CONFLICT waited for its commit).
      existing = await find();
      if (!existing) throw new Error(`order ${n.channelOrderId} conflicted but is not visible`);
    }
    const changed = await updateExisting(tx, ctx, connection, existing, n, run);
    if (changed === "stale") {
      result.stale++;
      result.skipped++;
      result.staleOrderIds.push(existing.id);
      result.orderIds.push(existing.id);
      continue;
    }
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
  }

  for (const channelOrderId of opts.cancelledChannelOrderIds ?? []) {
    if (await cancelFromChannel(tx, ctx, channel, channelOrderId)) result.cancelled++;
  }
  for (const line of opts.cancelledLines ?? []) {
    if (await cancelLineFromChannel(tx, ctx, channel, line)) result.cancelled++;
  }
  for (const hold of opts.holds ?? []) {
    if (await holdFromChannel(tx, ctx, channel, hold)) result.held++;
  }
  await recordRuleUse(tx, matcher);
  return result;
}

async function createOrder(
  tx: Tx,
  ctx: TenantContext,
  connection: ConnectionRow,
  n: NormalizedOrder,
  opts: Run,
) {
  const placedAt = new Date(n.placedAt);
  const shipBy = computeShipBy({
    channel: connection.channel,
    placedAt,
    channelShipBy: n.shipBy ? new Date(n.shipBy) : null,
    processingDays: opts.processingDays,
    timeZone: opts.timeZone,
    shipDays: opts.shipDays,
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
      channelUpdatedAt: n.sourceUpdatedAt ? new Date(n.sourceUpdatedAt) : null,
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
    .onConflictDoNothing({ target: [orders.companyId, orders.channel, orders.channelOrderId] })
    .returning();
  if (!order) return null;

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
    data: {
      source: opts.source,
      importRunId: opts.importRunId,
    },
  });
  const unmatched = await routeUnits(tx, ctx, connection, itemRows, opts.matcher);

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
  return { orderId: order.id, needsMapping: unmatched };
}

/** SKU rules on new units: map the matches, flag the rest `needs_mapping`. Returns the unmatched count. */
async function routeUnits(
  tx: Tx,
  ctx: TenantContext,
  connection: ConnectionRow,
  itemRows: ItemRow[],
  matcher: Matcher,
): Promise<number> {
  // SKU rules: group matched units by target so each mapping runs once.
  const groups = new Map<
    string,
    { designId: string; blankVariantId: string; ruleId: string; ids: string[] }
  >();
  const unmatched: typeof itemRows = [];
  for (const item of itemRows) {
    const hit = matcher.match(item.channelSku, {
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
    if (item.state === "imported")
      await transitionItem(tx, item.id, "needs_mapping", {
        actor: ctx.actor,
        reason: "unknown_sku",
      });
  }
  for (const g of groups.values()) {
    await mapItems(tx, ctx, g.ids, {
      designId: g.designId,
      blankVariantId: g.blankVariantId,
      ruleId: g.ruleId,
      via: "rule",
    });
  }

  return unmatched.length;
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

/**
 * Apply channel-side changes to an existing order; returns what changed (null = unchanged,
 * "stale" = the payload is older than one already applied and was ignored).
 */
async function updateExisting(
  tx: Tx,
  ctx: TenantContext,
  connection: ConnectionRow,
  o: OrderRow,
  n: NormalizedOrder,
  run: Run,
): Promise<string[] | null | "stale"> {
  // Staleness (B-12): against the newest channel timestamp applied, not `updated_at`, which moves
  // on every floor scan (the cached status) and would drop a real edit that arrives after one.
  const sourceAt = n.sourceUpdatedAt ? new Date(n.sourceUpdatedAt) : null;
  if (sourceAt && o.channelUpdatedAt && sourceAt.getTime() < o.channelUpdatedAt.getTime())
    return "stale";
  const changed: string[] = [];
  const set: Partial<typeof orders.$inferInsert> = {};
  const totals = mergeTotals(o, n);
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
  if (n.shipBy && !SHIPPED.has(o.status)) {
    // Normalize the channel's value the way import did (a date-only CSV ship-by is the end of that
    // day in the shop's timezone), then compare: the raw value never equals the stored one.
    const shipBy = computeShipBy({
      channel: connection.channel,
      placedAt: new Date(n.placedAt),
      channelShipBy: new Date(n.shipBy),
      processingDays: run.processingDays,
      timeZone: run.timeZone,
      shipDays: run.shipDays,
    });
    if (shipBy.getTime() !== o.shipBy.getTime()) {
      set.shipBy = shipBy;
      changed.push("ship-by");
    }
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
  if (!SHIPPED.has(o.status))
    changed.push(...(await applyLineEdits(tx, ctx, connection, { ...o, ...set }, n, run)));
  // Advance the watermark even when nothing changed, so an older payload is caught after it.
  if (sourceAt && (!o.channelUpdatedAt || sourceAt.getTime() > o.channelUpdatedAt.getTime()))
    await tx.update(orders).set({ channelUpdatedAt: sourceAt }).where(eq(orders.id, o.id));
  return changed.length ? changed : null;
}

/** A payload with no prices at all (Amazon's Unshipped Orders report has no price columns). */
const isPriceless = (n: NormalizedOrder) =>
  n.totals.subtotal === 0 && n.totals.total === 0 && n.items.every((i) => i.unitPrice === 0);

/**
 * B-197: a re-import never replaces known money with 0 or blank. Item subtotal, shipping, tax
 * and total keep their stored value when the payload says 0 (a report without that column, not
 * a real change: a refund is recorded as a refund, not a new total); a discount keeps its value
 * only when the payload carries no prices at all. Anything non-zero is applied as sent.
 */
function mergeTotals(o: OrderRow, n: NormalizedOrder) {
  const keep = (incoming: number, stored: number) => (incoming === 0 ? stored : incoming);
  return {
    subtotalCents: keep(n.totals.subtotal, o.subtotalCents),
    shippingCents: keep(n.totals.shipping, o.shippingCents),
    taxCents: keep(n.totals.tax, o.taxCents),
    discountCents: isPriceless(n) ? o.discountCents : n.totals.discount,
    totalCents: keep(n.totals.total, o.totalCents),
  };
}

/* ------------------------------ line edits (T-7-4, B-12) ------------------------------ */

/** Units in these states are physical shirts already: a channel edit flags them, never changes them. */
const PRESSED = new Set(["pressed", "packed", "shipped", "delivered"]);
/** Cheapest units to cancel first: nothing printed, then printed transfers, never pressed. */
const CANCEL_RANK: Record<string, number> = {
  imported: 0,
  needs_mapping: 0,
  needs_artwork: 1,
  ready: 1,
  on_sheet: 2,
  transfer_in: 3,
};
/** States where changing a unit's SKU or personalization in place is safe (nothing is routed). */
const UNROUTED = new Set(["imported", "needs_mapping"]);

const effectiveState = (i: ItemRow) =>
  i.state === "on_hold" ? (i.heldFromState ?? "imported") : i.state;
const isPressed = (i: ItemRow) => PRESSED.has(effectiveState(i));
const personalizationKey = (p: NormalizedOrder["items"][number]["personalization"]) =>
  JSON.stringify(p.map((a) => [a.question, a.answer ?? null, a.fileUrl ?? null]));

type ExistingLine = { lineNo: number; channelLineId: string; sku: string; units: ItemRow[] };

/**
 * Apply the channel's current lines to the order's units, per line:
 * - quantity down (or, for API/webhook payloads, the line gone): cancel that many units, cheapest
 *   first; units the shop cancelled itself count first; pressed units are flagged instead;
 * - quantity up or a new line: add units and route them like an import;
 * - SKU or personalization changed: unrouted units change in place; routed ones are replaced (new
 *   unit, old one cancelled, its transfer scrapped) unless the new SKU maps to the same print;
 *   pressed units are flagged `channel_edit_after_press`.
 * CSV files can drop a bad row, so a line missing from a CSV never cancels anything.
 */
async function applyLineEdits(
  tx: Tx,
  ctx: TenantContext,
  connection: ConnectionRow,
  o: OrderRow,
  n: NormalizedOrder,
  run: Run,
): Promise<string[]> {
  const all = await tx
    .select()
    .from(orderItems)
    .where(eq(orderItems.orderId, o.id))
    .orderBy(orderItems.lineNo, orderItems.unitNo);
  const units = all.filter((i) => !i.isReprint);
  const byLine = new Map<number, ItemRow[]>();
  for (const u of units) byLine.set(u.lineNo, [...(byLine.get(u.lineNo) ?? []), u]);
  const pending: ExistingLine[] = [...byLine.entries()].map(([lineNo, us]) => ({
    lineNo,
    channelLineId: us[0]?.channelLineId ?? "",
    sku: (us.find((u) => u.state !== "cancelled") ?? us[0])?.channelSku ?? "",
    units: us,
  }));
  const localCancels = await locallyCancelled(
    tx,
    units.filter((u) => u.state === "cancelled").map((u) => u.id),
  );

  // Match by channel line id, then by SKU (some CSV exports key lines by row number).
  const pairs: { line: NormalizedOrder["items"][number]; ex: ExistingLine | null }[] = [];
  const take = (pred: (e: ExistingLine) => boolean) => {
    const idx = pending.findIndex(pred);
    return idx >= 0 ? (pending.splice(idx, 1)[0] ?? null) : null;
  };
  const unpaired: NormalizedOrder["items"] = [];
  for (const line of n.items) {
    const ex = take((e) => e.channelLineId === line.channelLineId);
    if (ex) pairs.push({ line, ex });
    else unpaired.push(line);
  }
  for (const line of unpaired)
    pairs.push({ line, ex: take((e) => e.sku === line.channelSku.trim()) });

  const changed = new Set<string>();
  const toAdd: (typeof orderItems.$inferInsert)[] = [];
  const toCancel: ItemRow[] = [];
  const toRoute: string[] = [];
  const flags: { item: ItemRow; message: string; fingerprint: string }[] = [];
  let nextLineNo = Math.max(0, ...units.map((u) => u.lineNo)) + 1;

  const newUnit = (
    line: NormalizedOrder["items"][number],
    lineNo: number,
    unitNo: number,
    knownPriceCents = 0,
  ): typeof orderItems.$inferInsert => ({
    companyId: ctx.companyId,
    orderId: o.id,
    lineNo,
    unitNo,
    unitsInLine: line.quantity,
    channelLineId: line.channelLineId,
    channelSku: line.channelSku.trim(),
    channelListingId: line.channelListingId,
    title: line.title,
    variantTitle: line.variantTitle,
    // B-197: a price-less file adding a unit to a known line keeps the line's price.
    unitPriceCents: line.unitPrice || knownPriceCents,
    personalization: line.personalization,
    state: "imported" as const,
    shipBy: o.shipBy,
    isRush: o.isRush,
  });

  for (const { line, ex } of pairs) {
    if (!ex) {
      const lineNo = nextLineNo++;
      for (let u = 1; u <= line.quantity; u++) toAdd.push(newUnit(line, lineNo, u));
      changed.add("line added");
      continue;
    }
    let unitNo = Math.max(0, ...ex.units.map((u) => u.unitNo));
    const sku = line.channelSku.trim();
    const pKey = personalizationKey(line.personalization);
    if (ex.channelLineId !== line.channelLineId)
      await tx
        .update(orderItems)
        .set({ channelLineId: line.channelLineId })
        .where(
          inArray(
            orderItems.id,
            ex.units.map((u) => u.id),
          ),
        );

    // Content edits on the units that stay.
    const active = ex.units.filter((u) => u.state !== "cancelled");
    const kept: ItemRow[] = [];
    const replaced: ItemRow[] = [];
    for (const u of active) {
      const skuChanged = u.channelSku !== sku;
      const persChanged = personalizationKey(u.personalization) !== pKey;
      if (!skuChanged && !persChanged) {
        kept.push(u);
        continue;
      }
      const what = [skuChanged && `SKU ${sku || "(none)"}`, persChanged && "personalization"]
        .filter(Boolean)
        .join(" and ");
      if (isPressed(u)) {
        kept.push(u);
        flags.push({
          item: u,
          message: `The channel changed ${what} after this unit was pressed`,
          fingerprint: `${sku}|${pKey}`,
        });
        continue;
      }
      const inPlace =
        UNROUTED.has(effectiveState(u)) ||
        (!persChanged && sameTarget(run.matcher, connection, u, sku));
      if (inPlace) {
        await tx
          .update(orderItems)
          .set({
            channelSku: sku,
            personalization: line.personalization,
            title: line.title,
            variantTitle: line.variantTitle,
            channelListingId: line.channelListingId,
          })
          .where(eq(orderItems.id, u.id));
        if (UNROUTED.has(effectiveState(u)) && skuChanged) toRoute.push(u.id);
        kept.push(u);
      } else {
        replaced.push(u);
        toCancel.push(u);
      }
      changed.add(skuChanged ? "line SKU" : "personalization");
    }

    // Quantity: units the shop cancelled itself still count toward the channel's quantity.
    // Replaced units are cancelled above; their replacements are added below, minus any excess.
    const local = ex.units.filter((u) => localCancels.has(u.id)).length;
    const counted = kept.length + replaced.length + local;
    let replacements = replaced.length;
    if (line.quantity > counted) {
      replacements += line.quantity - counted;
      changed.add("quantity");
    } else if (line.quantity < counted) {
      let excess = counted - line.quantity - Math.min(local, counted - line.quantity);
      const dropped = Math.min(excess, replacements);
      replacements -= dropped;
      excess -= dropped;
      const took = cancelCheapest(kept, excess, flags, `quantity ${line.quantity}`);
      toCancel.push(...took);
      if (took.length || dropped) changed.add("quantity");
    }
    const linePrice = ex.units.find((u) => u.unitPriceCents > 0)?.unitPriceCents ?? 0;
    for (let k = 0; k < replacements; k++)
      toAdd.push(newUnit(line, ex.lineNo, ++unitNo, linePrice));
    if (active.some((u) => u.unitsInLine !== line.quantity))
      await tx
        .update(orderItems)
        .set({ unitsInLine: line.quantity })
        .where(
          and(
            eq(orderItems.orderId, o.id),
            eq(orderItems.lineNo, ex.lineNo),
            eq(orderItems.isReprint, false),
          ),
        );
  }

  // Lines the channel no longer lists (API/webhook payloads are the whole order).
  if (run.source !== "csv")
    for (const ex of pending) {
      const active = ex.units.filter((u) => u.state !== "cancelled");
      const took = cancelCheapest(active, active.length, flags, "the line removed");
      toCancel.push(...took);
      if (took.length) changed.add("line removed");
    }

  // New units first, so a replacement never leaves the order momentarily all-cancelled.
  if (toAdd.length) {
    const rows = await tx.insert(orderItems).values(toAdd).returning();
    await routeUnits(tx, ctx, connection, rows, run.matcher);
    if (o.holdReason) {
      // The order is on hold: new units wait with it.
      const fresh = await tx
        .select()
        .from(orderItems)
        .where(
          inArray(
            orderItems.id,
            rows.map((r) => r.id),
          ),
        );
      for (const r of fresh)
        if (r.state !== "on_hold" && r.state !== "cancelled")
          await transitionItem(tx, r.id, "on_hold", { actor: ctx.actor, reason: o.holdReason });
    }
  }
  if (toRoute.length) {
    const rows = await tx.select().from(orderItems).where(inArray(orderItems.id, toRoute));
    await routeUnits(tx, ctx, connection, rows, run.matcher);
  }
  if (toCancel.length)
    await cancelOrder(tx, ctx, {
      id: o.id,
      reason: "channel_cancelled",
      note: "Changed on the channel",
      orderItemIds: toCancel.map((u) => u.id),
    });
  if (await flagPressed(tx, ctx, flags)) changed.add("edit after press flagged");

  if (changed.size) {
    const itemCount = n.items.reduce((s, i) => s + i.quantity, 0);
    const hasPersonalization = n.items.some((i) =>
      i.personalization.some((p) => (p.answer ?? "").trim() !== ""),
    );
    await tx.update(orders).set({ itemCount, hasPersonalization }).where(eq(orders.id, o.id));
  }
  return [...changed];
}

/** The new SKU resolves to the design and blank this unit already prints. */
function sameTarget(matcher: Matcher, connection: ConnectionRow, u: ItemRow, sku: string) {
  const hit = matcher.match(sku, { channel: connection.channel, connectionId: connection.id });
  return !!hit && hit.designId === u.designId && hit.blankVariantId === u.blankVariantId;
}

/** Pick `count` units to cancel, cheapest first; what can't be cancelled (pressed) gets a flag. */
function cancelCheapest(
  units: ItemRow[],
  count: number,
  flags: { item: ItemRow; message: string; fingerprint: string }[],
  why: string,
): ItemRow[] {
  if (count <= 0) return [];
  const open = units
    .filter((u) => !isPressed(u) && u.state !== "cancelled")
    .sort(
      (a, b) =>
        (CANCEL_RANK[effectiveState(a)] ?? 9) - (CANCEL_RANK[effectiveState(b)] ?? 9) ||
        b.unitNo - a.unitNo,
    );
  const took = open.slice(0, count);
  const left = count - took.length;
  if (left > 0)
    for (const u of units.filter((x) => isPressed(x)).slice(0, left))
      flags.push({
        item: u,
        message: `The channel cancelled this unit (${why}) after it was pressed`,
        fingerprint: `cancel|${why}`,
      });
  return took;
}

/** Units the shop cancelled itself (any reason but the channel's). */
async function locallyCancelled(tx: Tx, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await tx
    .select({ id: orderItemTransitions.orderItemId, reason: orderItemTransitions.reason })
    .from(orderItemTransitions)
    .where(
      and(
        inArray(orderItemTransitions.orderItemId, ids),
        eq(orderItemTransitions.toState, "cancelled"),
      ),
    );
  return new Set(rows.filter((r) => r.reason !== "channel_cancelled").map((r) => r.id));
}

/**
 * Flag pressed units the channel tried to change. Once per edit: a flag the shop cleared isn't
 * raised again for the same channel values. Returns whether anything was flagged.
 */
async function flagPressed(
  tx: Tx,
  ctx: TenantContext,
  flags: { item: ItemRow; message: string; fingerprint: string }[],
): Promise<boolean> {
  let any = false;
  for (const f of flags) {
    const [seen] = await tx
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.companyId, ctx.companyId),
          eq(auditLog.entityType, "order_item"),
          eq(auditLog.entityId, f.item.id),
          eq(auditLog.action, "item.flag"),
          sql`${auditLog.data}->>'fingerprint' = ${f.fingerprint}`,
        ),
      )
      .limit(1);
    if (seen) continue;
    await tx
      .update(orderItems)
      .set({
        flags: withFlags(f.item.flags, [
          { code: "channel_edit_after_press", severity: "warn", message: f.message },
        ]),
      })
      .where(eq(orderItems.id, f.item.id));
    await audit(tx, {
      companyId: ctx.companyId,
      actor: ctx.actor,
      action: "item.flag",
      entityType: "order_item",
      entityId: f.item.id,
      summary: `Flagged channel edit after press: ${f.message}`,
      data: {
        orderId: f.item.orderId,
        code: "channel_edit_after_press",
        active: true,
        fingerprint: f.fingerprint,
      },
    });
    afterCommit(tx, async () => {
      await publish(ctx.companyId, "item.flagged", {
        orderItemId: f.item.id,
        orderId: f.item.orderId,
        codes: ["channel_edit_after_press"],
      });
    });
    any = true;
  }
  return any;
}

/** The channel cancelled one line: cancel its open units, flag pressed ones (idempotent). */
export async function cancelLineFromChannel(
  tx: Tx,
  ctx: TenantContext,
  channel: OrderRow["channel"],
  line: ChannelLineCancel,
): Promise<boolean> {
  const [o] = await tx
    .select()
    .from(orders)
    .where(and(eq(orders.channel, channel), eq(orders.channelOrderId, line.channelOrderId)))
    .limit(1);
  if (!o || SHIPPED.has(o.status)) return false;
  const units = await tx
    .select()
    .from(orderItems)
    .where(
      and(
        eq(orderItems.orderId, o.id),
        eq(orderItems.channelLineId, line.channelLineId),
        eq(orderItems.isReprint, false),
      ),
    );
  const active = units.filter((u) => u.state !== "cancelled");
  const flags: { item: ItemRow; message: string; fingerprint: string }[] = [];
  const took = cancelCheapest(active, active.length, flags, "line cancelled");
  if (took.length)
    await cancelOrder(tx, ctx, {
      id: o.id,
      reason: "channel_cancelled",
      note: "Line cancelled on the channel",
      orderItemIds: took.map((u) => u.id),
    });
  const flagged = await flagPressed(tx, ctx, flags);
  return took.length > 0 || flagged;
}

/**
 * Hold an order on a channel signal (buyer cancel request, TikTok ON_HOLD). Once per signal per
 * order: a hold the shop released is not re-applied by the next read. Returns true when held.
 */
export async function holdFromChannel(
  tx: Tx,
  ctx: TenantContext,
  channel: OrderRow["channel"],
  hold: ChannelHold,
): Promise<boolean> {
  const [o] = await tx
    .select()
    .from(orders)
    .where(and(eq(orders.channel, channel), eq(orders.channelOrderId, hold.channelOrderId)))
    .limit(1);
  if (!o || o.holdReason || o.cancelReason || SHIPPED.has(o.status)) return false;
  const [seen] = await tx
    .select({ id: orderItemTransitions.id })
    .from(orderItemTransitions)
    .where(
      and(
        eq(orderItemTransitions.orderId, o.id),
        sql`${orderItemTransitions.data}->>'channelSignal' = ${hold.signal}`,
      ),
    )
    .limit(1);
  if (seen) return false;
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
        ]),
      ),
    )
    .limit(1);
  if (open.length === 0) return false;
  const buyer = hold.signal === "buyer_cancel_request";
  await holdOrder(tx, ctx, {
    id: o.id,
    reason: buyer ? "buyer_request" : "other",
    note: buyer
      ? "The buyer asked the channel to cancel: answer the request before printing"
      : `${channel === "tiktok" ? "TikTok" : "The channel"} has this order on hold: don't ship until it's released there`,
    channelSignal: hold.signal,
  });
  return true;
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
