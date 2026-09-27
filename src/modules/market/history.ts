import type { Channel } from "@invai/contracts";
import { and, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import type { Tx } from "../../db/client";
import {
  blankVariants,
  channelConnections,
  companies,
  designs,
  inventoryMovements,
  listings,
  orderItems,
  orders,
  products,
  stockLevels,
} from "../../db/schema";

/*
 * Read-only aggregates over the shop's own orders, catalog and stock (spec step 1). The market
 * module never writes these tables (AC16); it reads them the way `today` reads counts, under the
 * caller's `withTenant`. One order item = one unit. Excluded from sales: cancelled items (also
 * cancelled after `on_sheet`), cancelled orders and reprints. Refunded items still count as units.
 */

export function getOrSet<K, V>(map: Map<K, V>, key: K, init: () => V): V {
  let v = map.get(key);
  if (v === undefined) {
    v = init();
    map.set(key, v);
  }
  return v;
}

export type WeeklyCell = { units: number; grossCents: number };

/** Units and gross item revenue per design × channel × ISO week (shop time zone), from `from` on. */
export async function ownWeekly(
  tx: Tx,
  companyId: string,
  timeZone: string,
  from: Date,
  designIds?: string[],
): Promise<Map<string, Map<Channel, Map<string, WeeklyCell>>>> {
  const week = sql<string>`to_char(${orders.placedAt} at time zone ${timeZone}, 'IYYY-"W"IW')`;
  const rows = await tx
    .select({
      designId: orderItems.designId,
      channel: orders.channel,
      week,
      units: sql<number>`count(*)::int`,
      gross: sql<number>`coalesce(sum(${orderItems.unitPriceCents}), 0)::int`,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(
      and(
        eq(orderItems.companyId, companyId),
        isNotNull(orderItems.designId),
        sql`${orderItems.state} <> 'cancelled'`,
        sql`${orders.status} <> 'cancelled'`,
        eq(orderItems.isReprint, false),
        gte(orders.placedAt, from),
        designIds?.length ? inArray(orderItems.designId, designIds) : undefined,
      ),
    )
    .groupBy(sql`1`, sql`2`, sql`3`);
  const out = new Map<string, Map<Channel, Map<string, WeeklyCell>>>();
  for (const r of rows) {
    if (!r.designId) continue;
    const byCh = getOrSet(out, r.designId, () => new Map());
    getOrSet(byCh, r.channel, () => new Map()).set(r.week, { units: r.units, grossCents: r.gross });
  }
  return out;
}

/** Units per design and unit price on one channel since `from` (own price points). */
export async function ownPricePoints(
  tx: Tx,
  companyId: string,
  designId: string,
  channel: Channel,
  from: Date,
  timeZone: string,
): Promise<{ priceCents: number; units: number; weeks: number }[]> {
  const rows = await tx
    .select({
      price: orderItems.unitPriceCents,
      units: sql<number>`count(*)::int`,
      weeks: sql<number>`count(distinct to_char(${orders.placedAt} at time zone ${timeZone}, 'IYYY-IW'))::int`,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(
      and(
        eq(orderItems.companyId, companyId),
        eq(orderItems.designId, designId),
        eq(orders.channel, channel),
        sql`${orderItems.state} <> 'cancelled'`,
        sql`${orders.status} <> 'cancelled'`,
        eq(orderItems.isReprint, false),
        gte(orders.placedAt, from),
      ),
    )
    .groupBy(orderItems.unitPriceCents);
  return rows.map((r) => ({ priceCents: r.price, units: r.units, weeks: r.weeks }));
}

/** Median paid (placed) → shipped hours over the last 90 days of shipped orders; null if none. */
export async function medianLeadHours(
  tx: Tx,
  companyId: string,
  now: Date,
): Promise<number | null> {
  const [row] = await tx
    .select({
      h: sql<
        number | null
      >`percentile_cont(0.5) within group (order by extract(epoch from (${orders.shippedAt} - ${orders.placedAt})) / 3600)`,
    })
    .from(orders)
    .where(
      and(
        eq(orders.companyId, companyId),
        isNotNull(orders.shippedAt),
        gte(orders.placedAt, new Date(now.getTime() - 90 * 86_400_000)),
      ),
    );
  return row?.h === null || row?.h === undefined ? null : Number(row.h);
}

export type DesignRow = {
  id: string;
  name: string;
  tags: string[];
  personalized: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export async function activeDesigns(
  tx: Tx,
  companyId: string,
  ids?: string[],
): Promise<DesignRow[]> {
  const rows = await tx
    .select({
      id: designs.id,
      name: designs.name,
      tags: designs.tags,
      template: designs.personalizationTemplateId,
      createdAt: designs.createdAt,
      updatedAt: designs.updatedAt,
    })
    .from(designs)
    .where(
      and(
        eq(designs.companyId, companyId),
        eq(designs.status, "active"),
        ids?.length ? inArray(designs.id, ids) : undefined,
      ),
    );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    tags: r.tags,
    personalized: r.template !== null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

export async function companyInfo(tx: Tx, companyId: string) {
  const [row] = await tx
    .select({ timezone: companies.timezone })
    .from(companies)
    .where(eq(companies.id, companyId));
  return { timeZone: row?.timezone ?? "America/Phoenix" };
}

export type ConnectionRow = {
  id: string;
  companyId: string;
  channel: Channel;
  status: (typeof channelConnections.$inferSelect)["status"];
  provider: "live" | "mock";
};

export async function connections(tx: Tx, companyId: string): Promise<ConnectionRow[]> {
  const rows = await tx
    .select({
      id: channelConnections.id,
      companyId: channelConnections.companyId,
      channel: channelConnections.channel,
      status: channelConnections.status,
      provider: channelConnections.provider,
    })
    .from(channelConnections)
    .where(eq(channelConnections.companyId, companyId));
  return rows;
}

/** A shop's connected channels (API or CSV) for the "list it where it's missing" action. */
export function connectedChannels(conns: ConnectionRow[]): Channel[] {
  return [
    ...new Set(
      conns
        .filter((c) => c.status === "connected" || c.status === "csv_only")
        .map((c) => c.channel),
    ),
  ];
}

/** Current price in cents per design × channel from products (the first product wins). */
export async function currentPrices(
  tx: Tx,
  companyId: string,
  designIds?: string[],
): Promise<Map<string, Map<Channel, number>>> {
  const rows = await tx
    .select({ designId: products.designId, prices: products.prices, styleCode: products.styleCode })
    .from(products)
    .where(
      and(
        eq(products.companyId, companyId),
        eq(products.status, "active"),
        designIds?.length ? inArray(products.designId, designIds) : undefined,
      ),
    )
    .orderBy(products.createdAt);
  const out = new Map<string, Map<Channel, number>>();
  for (const r of rows) {
    const m = getOrSet(out, r.designId, () => new Map<Channel, number>());
    for (const p of r.prices) {
      const ch = p.channel as Channel;
      // `ProductPrice.price` is integer cents (contracts `Cents`).
      if (!m.has(ch) && Number.isFinite(p.price)) m.set(ch, Math.round(p.price));
    }
  }
  return out;
}

/** Active listings: channels per design, with the channel listing ids (own ASIN / item id). */
export async function activeListings(
  tx: Tx,
  companyId: string,
  designIds?: string[],
): Promise<{ designId: string; channel: Channel; ref: string; createdAt: Date }[]> {
  const rows = await tx
    .select({
      designId: listings.designId,
      channel: listings.channel,
      ref: listings.channelListingId,
      createdAt: listings.createdAt,
    })
    .from(listings)
    .where(
      and(
        eq(listings.companyId, companyId),
        eq(listings.state, "active"),
        isNotNull(listings.designId),
        designIds?.length ? inArray(listings.designId, designIds) : undefined,
      ),
    );
  return rows.flatMap((r) => (r.designId ? [{ ...r, designId: r.designId }] : []));
}

export type BlankInfo = {
  id: string;
  name: string;
  styleName: string | null;
  style: string;
  belowReorderPoint: boolean;
};

/**
 * The blank each design is pressed on (its most used blank variant in orders), with whether it is
 * below its reorder point now (available < stock level's point, else the variant's point).
 */
export async function designBlanks(
  tx: Tx,
  companyId: string,
  from: Date,
  designIds?: string[],
): Promise<Map<string, BlankInfo>> {
  const used = await tx
    .select({
      designId: orderItems.designId,
      blankId: orderItems.blankVariantId,
      n: sql<number>`count(*)::int`,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(
      and(
        eq(orderItems.companyId, companyId),
        isNotNull(orderItems.designId),
        isNotNull(orderItems.blankVariantId),
        gte(orders.placedAt, from),
        designIds?.length ? inArray(orderItems.designId, designIds) : undefined,
      ),
    )
    .groupBy(orderItems.designId, orderItems.blankVariantId);
  const best = new Map<string, { blankId: string; n: number }>();
  for (const u of used) {
    if (!u.designId || !u.blankId) continue;
    const cur = best.get(u.designId);
    if (!cur || u.n > cur.n) best.set(u.designId, { blankId: u.blankId, n: u.n });
  }
  const blankIds = [...new Set([...best.values()].map((b) => b.blankId))];
  if (!blankIds.length) return new Map();
  const blanks = await tx
    .select({
      id: blankVariants.id,
      brand: blankVariants.brand,
      styleCode: blankVariants.styleCode,
      styleName: blankVariants.styleName,
      style: blankVariants.style,
      color: blankVariants.color,
      size: blankVariants.size,
      reorderPoint: blankVariants.reorderPoint,
    })
    .from(blankVariants)
    .where(and(eq(blankVariants.companyId, companyId), inArray(blankVariants.id, blankIds)));
  const stock = await tx
    .select({
      blankId: stockLevels.blankVariantId,
      available: sql<number>`sum(${stockLevels.available})::int`,
      point: sql<number | null>`max(${stockLevels.reorderPoint})`,
    })
    .from(stockLevels)
    .where(and(eq(stockLevels.companyId, companyId), inArray(stockLevels.blankVariantId, blankIds)))
    .groupBy(stockLevels.blankVariantId);
  const stockBy = new Map(stock.map((s) => [s.blankId, s]));
  const infoBy = new Map<string, BlankInfo>();
  for (const b of blanks) {
    const s = stockBy.get(b.id);
    const point = s?.point ?? b.reorderPoint;
    infoBy.set(b.id, {
      id: b.id,
      name: `${b.brand} ${b.styleCode}${b.styleName ? ` ${b.styleName}` : ""} ${b.color} ${b.size}`,
      styleName: b.styleName,
      style: b.style,
      belowReorderPoint:
        s !== undefined && point !== null && point !== undefined && s.available < point,
    });
  }
  const out = new Map<string, BlankInfo>();
  for (const [designId, b] of best) {
    const info = infoBy.get(b.blankId);
    if (info) out.set(designId, info);
  }
  return out;
}

/** The garment class of a blank from its style name (spec step 1.1). */
export function garmentClass(
  blank: { styleName: string | null; style: string } | undefined,
): string {
  const s = `${blank?.styleName ?? ""} ${blank?.style ?? ""}`.toLowerCase();
  if (!s.trim()) return "other";
  if (/\b(youth|kid|kids|toddler|infant|onesie|baby)\b/.test(s)) return "kids";
  if (/hood/.test(s)) return "hoodie";
  if (/(crew|sweat)/.test(s)) return "sweatshirt";
  if (/tank/.test(s)) return "tank";
  if (/(tee|t-shirt|shirt|softstyle|jersey)/.test(s)) return "tee";
  return "other";
}

/**
 * ISO weeks (shop time zone) in which a blank was out of stock: end-of-week on hand ≤ 0,
 * rebuilt backwards from today's on hand through the movement ledger. Blanks without any
 * movement aren't tracked, so they never mark a week out of stock.
 */
export async function outOfStockWeeks(
  tx: Tx,
  companyId: string,
  blankIds: string[],
  weekKeys: string[],
  from: Date,
  timeZone: string,
): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  if (!blankIds.length || !weekKeys.length) return out;
  const onHand = await tx
    .select({
      blankId: stockLevels.blankVariantId,
      onHand: sql<number>`sum(${stockLevels.onHand})::int`,
    })
    .from(stockLevels)
    .where(and(eq(stockLevels.companyId, companyId), inArray(stockLevels.blankVariantId, blankIds)))
    .groupBy(stockLevels.blankVariantId);
  const moves = await tx
    .select({
      blankId: inventoryMovements.blankVariantId,
      week: sql<string>`to_char(${inventoryMovements.createdAt} at time zone ${timeZone}, 'IYYY-"W"IW')`,
      qty: sql<number>`sum(${inventoryMovements.qty})::int`,
    })
    .from(inventoryMovements)
    .where(
      and(
        eq(inventoryMovements.companyId, companyId),
        inArray(inventoryMovements.blankVariantId, blankIds),
        gte(inventoryMovements.createdAt, from),
      ),
    )
    .groupBy(sql`1`, sql`2`);
  const movesBy = new Map<string, Map<string, number>>();
  for (const m of moves) {
    getOrSet(movesBy, m.blankId, () => new Map<string, number>()).set(m.week, m.qty);
  }
  for (const h of onHand) {
    const w = movesBy.get(h.blankId);
    if (!w?.size) continue;
    // Walk back from now: end of week k = on hand now − movements after week k.
    let level = h.onHand;
    const after = [...w.entries()].filter(([k]) => k > (weekKeys[weekKeys.length - 1] ?? ""));
    for (const [, q] of after) level -= q;
    const set = new Set<string>();
    for (let i = weekKeys.length - 1; i >= 0; i--) {
      const key = weekKeys[i] as string;
      if (level <= 0) set.add(key);
      level -= w.get(key) ?? 0;
    }
    if (set.size) out.set(h.blankId, set);
  }
  return out;
}
