import {
  CHANNEL_RULES,
  CHANNELS,
  type ChannelPerformance,
  ITEM_FLAG_CODES,
  ORDER_STATUSES,
  type Order,
  type OrderItem,
  type OrderItemState,
  type OrderWithItems,
  PRE_SHIPPED_STATES,
  STATIONS,
  type TimelineEntry,
} from "@invai/contracts";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  lt,
  lte,
  ne,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { TenantContext } from "../../api/context";
import { afterCommit, type Tx } from "../../db/client";
import {
  auditLog,
  bins,
  blankVariants,
  buyerPii,
  channelConnections,
  companies,
  designs,
  type ItemFlag,
  orderItems,
  orderItemTransitions,
  orders,
  products,
  stations,
  users,
} from "../../db/schema";
import { imaging } from "../../integrations/imaging/client";
import { audit } from "../../lib/audit";
import { sha256Hex } from "../../lib/crypto";
import { badRequest, conflict, notFound } from "../../lib/errors";
import { logger } from "../../lib/log";
import { emit } from "../../lib/outbox";
import { publish } from "../../lib/realtime";
import { releaseForItems } from "../inventory/service";
import { ARTWORK_ITEM_FLAGS, withFlags } from "./flags";
import { todayRange } from "./shipby";
import { transitionItem } from "./state-machine";

const log = logger("orders");

type OrderRow = typeof orders.$inferSelect;
type ItemRow = typeof orderItems.$inferSelect;
type ItemFlagCode = (typeof ITEM_FLAG_CODES)[number];

/* ------------------------------------ SQL helpers ------------------------------------ */

const labeledSql = sql`exists (select 1 from shipments s where s.order_id = ${orders.id} and s.labeled_at is not null and s.voided_at is null)`;
const riskHoursSql = sql`coalesce((${channelConnections.settings}->>'riskWindowHours')::int, 24)`;
const openSql = sql`${orders.status} not in ('shipped', 'delivered', 'cancelled')`;
export const atRiskSql = sql<boolean>`(${openSql} and not ${labeledSql} and ${orders.shipBy} <= now() + make_interval(hours => ${riskHoursSql}))`;
export const overdueSql = sql<boolean>`(${openSql} and not ${labeledSql} and ${orders.shipBy} < now())`;

/** Non-identifying buyer reference: a company-scoped hash of the normalized name. */
export function buyerRefOf(companyId: string, name: string) {
  return sha256Hex(`buyer:${companyId}:${name.trim().toLowerCase().replace(/\s+/g, " ")}`);
}

/* ------------------------------------ mapping ------------------------------------ */

const orderSelect = {
  o: orders,
  binCode: bins.code,
  atRisk: atRiskSql.mapWith(Boolean),
  isOverdue: overdueSql.mapWith(Boolean),
  pii: {
    id: buyerPii.id,
    name: buyerPii.name,
    email: buyerPii.email,
    phone: buyerPii.phone,
    company: buyerPii.company,
    street1: buyerPii.street1,
    street2: buyerPii.street2,
    city: buyerPii.city,
    state: buyerPii.state,
    zip: buyerPii.zip,
    country: buyerPii.country,
  },
};

type OrderJoin = {
  o: OrderRow;
  binCode: string | null;
  atRisk: boolean;
  isOverdue: boolean;
  pii: {
    id: string | null;
    name: string | null;
    email: string | null;
    phone: string | null;
    company: string | null;
    street1: string | null;
    street2: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
    country: string | null;
  } | null;
};

function orderQuery(tx: Tx) {
  return tx
    .select(orderSelect)
    .from(orders)
    .innerJoin(channelConnections, eq(channelConnections.id, orders.connectionId))
    .leftJoin(bins, eq(bins.id, orders.binId))
    .leftJoin(buyerPii, eq(buyerPii.orderId, orders.id));
}

function toOrder(r: OrderJoin, ctx: TenantContext): Order {
  const o = r.o;
  const pii = r.pii?.id ? r.pii : null;
  const canSeeAddress = ctx.permissions.has("orders.manage");
  return {
    id: o.id,
    channel: o.channel,
    connectionId: o.connectionId,
    channelOrderId: o.channelOrderId,
    orderNo: o.orderNo,
    status: o.status,
    placedAt: o.placedAt.toISOString(),
    shipBy: o.shipBy.toISOString(),
    shippedAt: o.shippedAt?.toISOString() ?? null,
    deliveredAt: o.deliveredAt?.toISOString() ?? null,
    isRush: o.isRush,
    atRisk: r.atRisk,
    isOverdue: r.isOverdue,
    hasPersonalization: o.hasPersonalization,
    hold:
      o.holdReason && o.heldAt
        ? { reason: o.holdReason, note: o.holdNote, at: o.heldAt.toISOString() }
        : null,
    cancel:
      o.cancelReason && o.cancelledAt
        ? { reason: o.cancelReason, note: o.cancelNote, at: o.cancelledAt.toISOString() }
        : null,
    buyerName: pii?.name ?? "Buyer (data purged)",
    shipTo:
      pii && canSeeAddress && pii.street1
        ? {
            name: pii.name ?? "",
            company: pii.company,
            street1: pii.street1,
            street2: pii.street2,
            city: pii.city ?? "",
            state: pii.state ?? "",
            zip: pii.zip ?? "",
            country: (pii.country ?? "US").slice(0, 2),
            phone: pii.phone,
            email: pii.email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(pii.email) ? pii.email : null,
          }
        : null,
    shippingMethod: o.shippingMethod,
    buyerNote: o.buyerNote,
    totals: {
      subtotal: o.subtotalCents,
      shipping: o.shippingCents,
      tax: o.taxCents,
      discount: o.discountCents,
      total: o.totalCents,
    },
    itemCount: o.itemCount,
    binCode: r.binCode,
    tags: o.tags,
    createdAt: o.createdAt.toISOString(),
    updatedAt: o.updatedAt.toISOString(),
  };
}

const itemSelect = {
  i: orderItems,
  orderNo: orders.orderNo,
  designName: designs.name,
  productName: products.name,
  blank: {
    id: blankVariants.id,
    brand: blankVariants.brand,
    style: blankVariants.style,
    color: blankVariants.color,
    size: blankVariants.size,
  },
  binCode: bins.code,
};

type ItemJoin = {
  i: ItemRow;
  orderNo: string;
  designName: string | null;
  productName: string | null;
  blank: {
    id: string | null;
    brand: string | null;
    style: string | null;
    color: string | null;
    size: string | null;
  } | null;
  binCode: string | null;
};

function itemQuery(tx: Tx) {
  return tx
    .select(itemSelect)
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .leftJoin(designs, eq(designs.id, orderItems.designId))
    .leftJoin(products, eq(products.id, orderItems.productId))
    .leftJoin(blankVariants, eq(blankVariants.id, orderItems.blankVariantId))
    .leftJoin(bins, eq(bins.id, orderItems.binId));
}

const FLAG_CODE_SET = new Set<string>(ITEM_FLAG_CODES);

export function toOrderItem(r: ItemJoin): OrderItem {
  const i = r.i;
  return {
    id: i.id,
    orderId: i.orderId,
    orderNo: r.orderNo,
    lineNo: i.lineNo,
    unitNo: i.unitNo,
    unitsInLine: i.unitsInLine,
    channelSku: i.channelSku,
    channelListingId: i.channelListingId,
    title: i.title,
    variantTitle: i.variantTitle,
    unitPrice: i.unitPriceCents,
    personalization: i.personalization.map((p) => ({
      question: p.question,
      answer: p.answer ?? null,
      fileUrl: p.fileUrl && /^https?:\/\//.test(p.fileUrl) ? p.fileUrl : null,
    })),
    state: i.state,
    heldFromState: i.heldFromState,
    design: i.designId ? { id: i.designId, name: r.designName ?? "" } : null,
    product: i.productId ? { id: i.productId, name: r.productName ?? "" } : null,
    blank:
      r.blank?.id && r.blank.brand
        ? {
            variantId: r.blank.id,
            brand: r.blank.brand,
            style: r.blank.style ?? "",
            color: r.blank.color ?? "",
            size: r.blank.size ?? "",
          }
        : null,
    placement: i.placement,
    artwork: { status: i.artworkStatus, fileKey: i.artworkKey, previewKey: i.artworkPreviewKey },
    flags: i.flags
      .filter((f) => FLAG_CODE_SET.has(f.code))
      .map((f) => ({ ...f, code: f.code as ItemFlagCode })),
    isRush: i.isRush,
    isReprint: i.isReprint,
    transferId: i.transferId,
    sheetId: i.gangSheetId,
    binCode: r.binCode,
    shipmentId: i.shipmentId,
    shipBy: i.shipBy.toISOString(),
    updatedAt: i.updatedAt.toISOString(),
  };
}

/* ------------------------------------ cursors ------------------------------------ */

type SortCursor = { v: string; id: string };
const encodeSort = (c: SortCursor) => Buffer.from(JSON.stringify(c)).toString("base64url");
function decodeSort(cursor: string): SortCursor {
  try {
    const c = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as SortCursor;
    if (typeof c.v !== "string" || typeof c.id !== "string") throw new Error("bad");
    return c;
  } catch {
    throw badRequest("Invalid cursor");
  }
}

function sortKeyset(col: PgColumn, idCol: PgColumn, dir: "asc" | "desc", cursor?: string) {
  const c = cursor ? decodeSort(cursor) : null;
  const cmp = dir === "asc" ? gt : lt;
  const where = c
    ? or(cmp(col, new Date(c.v)), and(eq(col, new Date(c.v)), cmp(idCol, c.id)))
    : undefined;
  const orderBy = dir === "asc" ? [asc(col), asc(idCol)] : [desc(col), desc(idCol)];
  return { where, orderBy };
}

/* ------------------------------------ orders.list / counts ------------------------------------ */

export type OrderFilters = {
  status?: OrderRow["status"][];
  channel?: OrderRow["channel"][];
  itemState?: OrderItemState[];
  connectionId?: string;
  atRisk?: boolean;
  overdue?: boolean;
  hasPersonalization?: boolean;
  isRush?: boolean;
  search?: string;
  shipByFrom?: string;
  shipByTo?: string;
  placedFrom?: string;
  placedTo?: string;
  tag?: string;
};

function orderFilters(ctx: TenantContext, f: OrderFilters): (SQL | undefined)[] {
  const out: (SQL | undefined)[] = [];
  if (f.status?.length) out.push(inArray(orders.status, f.status));
  if (f.channel?.length) out.push(inArray(orders.channel, f.channel));
  if (f.itemState?.length)
    out.push(
      sql`exists (select 1 from order_items oi where oi.order_id = ${orders.id} and oi.state in (${sql.join(
        f.itemState.map((s) => sql`${s}`),
        sql`, `,
      )}))`,
    );
  if (f.connectionId) out.push(eq(orders.connectionId, f.connectionId));
  if (f.atRisk !== undefined) out.push(f.atRisk ? atRiskSql : sql`not ${atRiskSql}`);
  if (f.overdue !== undefined) out.push(f.overdue ? overdueSql : sql`not ${overdueSql}`);
  if (f.hasPersonalization !== undefined)
    out.push(eq(orders.hasPersonalization, f.hasPersonalization));
  if (f.isRush !== undefined) out.push(eq(orders.isRush, f.isRush));
  if (f.shipByFrom) out.push(gte(orders.shipBy, new Date(f.shipByFrom)));
  if (f.shipByTo) out.push(lte(orders.shipBy, new Date(f.shipByTo)));
  if (f.placedFrom) out.push(gte(orders.placedAt, new Date(f.placedFrom)));
  if (f.placedTo) out.push(lte(orders.placedAt, new Date(f.placedTo)));
  if (f.tag) out.push(sql`${f.tag} = any(${orders.tags})`);
  if (f.search?.trim()) {
    const q = f.search.trim();
    const like = `%${q}%`;
    out.push(
      or(
        ilike(orders.orderNo, like),
        ilike(orders.channelOrderId, like),
        eq(orders.buyerRef, buyerRefOf(ctx.companyId, q)),
        sql`exists (select 1 from order_items oi where oi.order_id = ${orders.id} and oi.channel_sku ilike ${like})`,
      ),
    );
  }
  return out;
}

export async function listOrders(
  tx: Tx,
  ctx: TenantContext,
  input: OrderFilters & {
    cursor?: string;
    limit: number;
    sort: "shipBy" | "placedAt" | "updatedAt";
    dir: "asc" | "desc";
  },
) {
  const col = { shipBy: orders.shipBy, placedAt: orders.placedAt, updatedAt: orders.updatedAt }[
    input.sort
  ];
  const page = sortKeyset(col, orders.id, input.dir, input.cursor);
  const rows = await orderQuery(tx)
    .where(and(...orderFilters(ctx, input), page.where))
    .orderBy(...page.orderBy)
    .limit(input.limit + 1);
  const pageRows = rows.slice(0, input.limit);
  const last = pageRows[pageRows.length - 1];
  return {
    items: pageRows.map((r) => toOrder(r, ctx)),
    nextCursor:
      rows.length > input.limit && last
        ? encodeSort({ v: (last.o[input.sort] as Date).toISOString(), id: last.o.id })
        : null,
  };
}

async function companyTimezone(tx: Tx, companyId: string) {
  const [c] = await tx
    .select({ tz: companies.timezone })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  return c?.tz ?? "America/Phoenix";
}

export async function countOrders(tx: Tx, ctx: TenantContext, input: OrderFilters) {
  const where = and(...orderFilters(ctx, input));
  const base = () =>
    tx
      .select({ n: sql<number>`count(*)`.mapWith(Number) })
      .from(orders)
      .innerJoin(channelConnections, eq(channelConnections.id, orders.connectionId));
  const byStatusRows = await tx
    .select({ k: orders.status, n: sql<number>`count(*)`.mapWith(Number) })
    .from(orders)
    .innerJoin(channelConnections, eq(channelConnections.id, orders.connectionId))
    .where(where)
    .groupBy(orders.status);
  const byChannelRows = await tx
    .select({ k: orders.channel, n: sql<number>`count(*)`.mapWith(Number) })
    .from(orders)
    .innerJoin(channelConnections, eq(channelConnections.id, orders.connectionId))
    .where(where)
    .groupBy(orders.channel);
  const [atRisk] = await base().where(and(where, atRiskSql));
  const [overdue] = await base().where(and(where, overdueSql));
  const today = todayRange(await companyTimezone(tx, ctx.companyId));
  const [dueToday] = await base().where(
    and(where, openSql, gte(orders.shipBy, today.start), lte(orders.shipBy, today.end)),
  );
  const byStatus = Object.fromEntries(ORDER_STATUSES.map((s) => [s, 0])) as Record<
    OrderRow["status"],
    number
  >;
  for (const r of byStatusRows) byStatus[r.k] = r.n;
  const byChannel = Object.fromEntries(CHANNELS.map((c) => [c, 0])) as Record<
    OrderRow["channel"],
    number
  >;
  for (const r of byChannelRows) byChannel[r.k] = r.n;
  return {
    byStatus,
    byChannel,
    atRisk: atRisk?.n ?? 0,
    overdue: overdue?.n ?? 0,
    dueToday: dueToday?.n ?? 0,
  };
}

/* ------------------------------------ get / items ------------------------------------ */

export async function getOrderRow(tx: Tx, id: string): Promise<OrderRow> {
  const [row] = await tx.select().from(orders).where(eq(orders.id, id)).limit(1);
  if (!row) throw notFound("order", id);
  return row;
}

export async function getOrder(tx: Tx, ctx: TenantContext, id: string): Promise<OrderWithItems> {
  const [row] = await orderQuery(tx).where(eq(orders.id, id)).limit(1);
  if (!row) throw notFound("order", id);
  const items = await itemQuery(tx)
    .where(eq(orderItems.orderId, id))
    .orderBy(orderItems.lineNo, orderItems.unitNo, orderItems.createdAt);
  return { ...toOrder(row, ctx), items: items.map(toOrderItem) };
}

export async function getOrderSummary(tx: Tx, ctx: TenantContext, id: string): Promise<Order> {
  const [row] = await orderQuery(tx).where(eq(orders.id, id)).limit(1);
  if (!row) throw notFound("order", id);
  return toOrder(row, ctx);
}

export async function getItem(tx: Tx, _ctx: TenantContext, id: string): Promise<OrderItem> {
  const [row] = await itemQuery(tx).where(eq(orderItems.id, id)).limit(1);
  if (!row) throw notFound("order_item", id);
  return toOrderItem(row);
}

export async function getItemRow(tx: Tx, id: string): Promise<ItemRow> {
  const [row] = await tx.select().from(orderItems).where(eq(orderItems.id, id)).limit(1);
  if (!row) throw notFound("order_item", id);
  return row;
}

export async function listItems(
  tx: Tx,
  _ctx: TenantContext,
  input: {
    cursor?: string;
    limit: number;
    state?: OrderItemState[];
    flag?: ItemFlagCode;
    designId?: string;
    blankVariantId?: string;
    sheetId?: string;
    shipByTo?: string;
    search?: string;
  },
) {
  const filters: (SQL | undefined)[] = [];
  if (input.state?.length) filters.push(inArray(orderItems.state, input.state));
  if (input.flag)
    filters.push(sql`${orderItems.flags} @> ${JSON.stringify([{ code: input.flag }])}::jsonb`);
  if (input.designId) filters.push(eq(orderItems.designId, input.designId));
  if (input.blankVariantId) filters.push(eq(orderItems.blankVariantId, input.blankVariantId));
  if (input.sheetId) filters.push(eq(orderItems.gangSheetId, input.sheetId));
  if (input.shipByTo) filters.push(lte(orderItems.shipBy, new Date(input.shipByTo)));
  if (input.search?.trim()) {
    const like = `%${input.search.trim()}%`;
    filters.push(
      or(
        ilike(orderItems.channelSku, like),
        ilike(orderItems.title, like),
        ilike(orders.orderNo, like),
      ),
    );
  }
  const page = sortKeyset(orderItems.shipBy, orderItems.id, "asc", input.cursor);
  const rows = await itemQuery(tx)
    .where(and(...filters, page.where))
    .orderBy(...page.orderBy)
    .limit(input.limit + 1);
  const pageRows = rows.slice(0, input.limit);
  const last = pageRows[pageRows.length - 1];
  return {
    items: pageRows.map(toOrderItem),
    nextCursor:
      rows.length > input.limit && last
        ? encodeSort({ v: last.i.shipBy.toISOString(), id: last.i.id })
        : null,
  };
}

/* ------------------------------------ timeline ------------------------------------ */

const AUDIT_KIND: Record<string, TimelineEntry["kind"]> = {
  "order.imported": "imported",
  "order.synced": "sync",
  "item.mapped": "mapped",
  "artwork.rendered": "artwork",
  "artwork.approved": "artwork",
  "artwork.overridden": "artwork",
  "item.flag": "flag",
  "item.rush": "flag",
  "order.held": "held",
  "order.released": "released",
  "order.cancelled": "cancelled",
  "order.note": "note",
  "order.tags": "note",
  "tracking.pushed": "tracking_pushed",
  "scan.recorded": "scan",
  "sheet.sent": "sheet",
  "label.bought": "shipment",
  "label.voided": "shipment",
  "reprint.requested": "reprint",
  "qc.failed": "qc",
  "qc.passed": "qc",
};

const STATION_SET = new Set<string>(STATIONS);

export async function timeline(
  tx: Tx,
  _ctx: TenantContext,
  input: { id: string; cursor?: string; limit: number },
) {
  await getOrderRow(tx, input.id);
  const itemIds = (
    await tx.select({ id: orderItems.id }).from(orderItems).where(eq(orderItems.orderId, input.id))
  ).map((r) => r.id);
  const c = input.cursor ? decodeSort(input.cursor) : null;
  const before = (at: PgColumn, id: PgColumn) =>
    c ? or(lt(at, new Date(c.v)), and(eq(at, new Date(c.v)), lt(id, c.id))) : undefined;

  const tRows = await tx
    .select({
      t: orderItemTransitions,
      userName: users.name,
      stationKind: stations.kind,
    })
    .from(orderItemTransitions)
    .leftJoin(users, eq(users.id, orderItemTransitions.actorUserId))
    .leftJoin(stations, eq(stations.id, orderItemTransitions.stationId))
    .where(
      and(
        eq(orderItemTransitions.orderId, input.id),
        before(orderItemTransitions.createdAt, orderItemTransitions.id),
      ),
    )
    .orderBy(desc(orderItemTransitions.createdAt), desc(orderItemTransitions.id))
    .limit(input.limit + 1);

  const entityMatch = itemIds.length
    ? or(
        and(eq(auditLog.entityType, "order"), eq(auditLog.entityId, input.id)),
        and(eq(auditLog.entityType, "order_item"), inArray(auditLog.entityId, itemIds)),
      )
    : and(eq(auditLog.entityType, "order"), eq(auditLog.entityId, input.id));
  const aRows = await tx
    .select({ a: auditLog, userName: users.name, stationKind: stations.kind })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorUserId))
    .leftJoin(stations, eq(stations.id, auditLog.stationId))
    .where(
      and(
        entityMatch,
        ne(auditLog.action, "item.state_changed"),
        before(auditLog.createdAt, auditLog.id),
      ),
    )
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(input.limit + 1);

  const actorOf = (
    kind: string,
    userId: string | null,
    userName: string | null,
    stationKind: string | null,
  ) => ({
    userId,
    name: userName ?? (kind === "system" ? "InvAI" : kind === "station" ? "Station" : "Unknown"),
    station:
      stationKind && STATION_SET.has(stationKind)
        ? (stationKind as TimelineEntry["actor"]["station"])
        : null,
  });

  const entries: (TimelineEntry & { _at: Date })[] = [
    ...tRows.map(({ t, userName, stationKind }) => ({
      _at: t.createdAt,
      id: t.id,
      at: t.createdAt.toISOString(),
      kind: "state_changed" as const,
      orderItemId: t.orderItemId,
      actor: actorOf(t.actorKind, t.actorUserId, userName, stationKind),
      from: t.fromState,
      to: t.toState,
      message: `${t.fromState ?? "new"} → ${t.toState}${t.reason ? ` (${t.reason})` : ""}`,
      meta: t.data,
    })),
    ...aRows.map(({ a, userName, stationKind }) => ({
      _at: a.createdAt,
      id: a.id,
      at: a.createdAt.toISOString(),
      kind: AUDIT_KIND[a.action] ?? ("note" as const),
      orderItemId: a.entityType === "order_item" ? a.entityId : null,
      actor: actorOf(a.actorKind, a.actorUserId, userName, stationKind),
      from: null,
      to: null,
      message: a.summary,
      meta: { action: a.action, ...a.data },
    })),
  ].sort((x, y) => y._at.getTime() - x._at.getTime() || (y.id > x.id ? 1 : -1));

  const page = entries.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    items: page.map(({ _at, ...e }) => e),
    nextCursor:
      entries.length > input.limit && last ? encodeSort({ v: last.at, id: last.id }) : null,
  };
}

export async function addNote(
  tx: Tx,
  ctx: TenantContext,
  input: { id: string; text: string },
): Promise<TimelineEntry> {
  await getOrderRow(tx, input.id);
  await audit(tx, {
    companyId: ctx.companyId,
    actor: ctx.actor,
    action: "order.note",
    entityType: "order",
    entityId: input.id,
    summary: input.text,
  });
  const [row] = await tx
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.entityId, input.id), eq(auditLog.action, "order.note")))
    .orderBy(desc(auditLog.createdAt))
    .limit(1);
  if (!row) throw new Error("note insert failed");
  return {
    id: row.id,
    at: row.createdAt.toISOString(),
    kind: "note",
    orderItemId: null,
    actor: { userId: ctx.userId, name: ctx.user?.name ?? "Unknown", station: null },
    from: null,
    to: null,
    message: input.text,
    meta: {},
  };
}

export async function setTags(tx: Tx, ctx: TenantContext, input: { id: string; tags: string[] }) {
  await getOrderRow(tx, input.id);
  const tags = [...new Set(input.tags.map((t) => t.trim()).filter(Boolean))];
  await tx.update(orders).set({ tags }).where(eq(orders.id, input.id));
  await audit(tx, {
    companyId: ctx.companyId,
    actor: ctx.actor,
    action: "order.tags",
    entityType: "order",
    entityId: input.id,
    summary: tags.length ? `Tags: ${tags.join(", ")}` : "Tags cleared",
  });
  await emit(tx, ctx.companyId, "order.updated", { orderId: input.id });
  return getOrderSummary(tx, ctx, input.id);
}

/* ------------------------------------ hold / release / cancel ------------------------------------ */

const PRE_SHIPPED = new Set<string>(PRE_SHIPPED_STATES);

async function orderItemRows(tx: Tx, orderId: string) {
  return tx
    .select()
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId))
    .orderBy(orderItems.lineNo, orderItems.unitNo);
}

function publishOrder(tx: Tx, companyId: string, orderId: string) {
  afterCommit(tx, async () => {
    await publish(companyId, "today.changed", { reason: `order ${orderId} changed` });
  });
}

export async function holdOrder(
  tx: Tx,
  ctx: TenantContext,
  input: { id: string; reason: NonNullable<OrderRow["holdReason"]>; note: string | null },
) {
  const order = await getOrderRow(tx, input.id);
  const items = (await orderItemRows(tx, input.id)).filter((i) => PRE_SHIPPED.has(i.state));
  if (items.length === 0)
    throw conflict("Nothing to hold: every item is shipped, cancelled or already on hold");
  for (const i of items)
    await transitionItem(tx, i.id, "on_hold", {
      actor: ctx.actor,
      reason: input.reason,
      data: { note: input.note },
    });
  await tx
    .update(orders)
    .set({ holdReason: input.reason, holdNote: input.note, heldAt: new Date() })
    .where(eq(orders.id, order.id));
  await audit(tx, {
    companyId: ctx.companyId,
    actor: ctx.actor,
    action: "order.held",
    entityType: "order",
    entityId: order.id,
    summary: `Held (${input.reason.replace(/_/g, " ")})${input.note ? `: ${input.note}` : ""}`,
  });
  await emit(tx, ctx.companyId, "order.held", { orderId: order.id, reason: input.reason });
  publishOrder(tx, ctx.companyId, order.id);
  return getOrder(tx, ctx, order.id);
}

export async function releaseOrder(tx: Tx, ctx: TenantContext, id: string) {
  const order = await getOrderRow(tx, id);
  const items = (await orderItemRows(tx, id)).filter((i) => i.state === "on_hold");
  if (items.length === 0 && !order.holdReason) throw conflict("The order is not on hold");
  for (const i of items) {
    const to = (i.heldFromState ?? "imported") as OrderItemState;
    await transitionItem(tx, i.id, to, { actor: ctx.actor, reason: "released" });
  }
  await tx
    .update(orders)
    .set({ holdReason: null, holdNote: null, heldAt: null })
    .where(eq(orders.id, id));
  await audit(tx, {
    companyId: ctx.companyId,
    actor: ctx.actor,
    action: "order.released",
    entityType: "order",
    entityId: id,
    summary: "Hold released",
  });
  await emit(tx, ctx.companyId, "order.released", { orderId: id });
  publishOrder(tx, ctx.companyId, id);
  return getOrder(tx, ctx, id);
}

/**
 * Cancel every open item (or the given ones). Items whose transfer was already nested are
 * reported in `order.cancelled.scrappedTransferIds` (production marks the transfer scrap);
 * blank reservations are released.
 */
export async function cancelOrder(
  tx: Tx,
  ctx: TenantContext,
  input: {
    id: string;
    reason: NonNullable<OrderRow["cancelReason"]>;
    note: string | null;
    orderItemIds?: string[];
  },
) {
  const order = await getOrderRow(tx, input.id);
  const all = await orderItemRows(tx, input.id);
  let targets: ItemRow[];
  if (input.orderItemIds?.length) {
    const wanted = new Set(input.orderItemIds);
    targets = all.filter((i) => wanted.has(i.id));
    if (targets.length !== wanted.size) throw notFound("order_item");
  } else {
    targets = all.filter((i) => PRE_SHIPPED.has(i.state) || i.state === "on_hold");
  }
  if (targets.length === 0)
    throw conflict("Nothing to cancel: every item is shipped or already cancelled");

  const nested = new Set(["on_sheet", "transfer_in"]);
  const scrappedTransferIds = targets
    .filter(
      (i) =>
        i.transferId &&
        (nested.has(i.state) || (i.state === "on_hold" && nested.has(i.heldFromState ?? ""))),
    )
    .map((i) => i.transferId as string);
  for (const i of targets)
    await transitionItem(tx, i.id, "cancelled", {
      actor: ctx.actor,
      reason: input.reason,
      data: { note: input.note },
    });
  const ids = targets.map((i) => i.id);
  await releaseForItems(tx, ctx, ids);

  const remaining = all.filter((i) => !ids.includes(i.id) && i.state !== "cancelled");
  if (remaining.length === 0) {
    await tx
      .update(orders)
      .set({
        cancelReason: input.reason,
        cancelNote: input.note,
        holdReason: null,
        holdNote: null,
        heldAt: null,
      })
      .where(eq(orders.id, order.id));
  }
  await audit(tx, {
    companyId: ctx.companyId,
    actor: ctx.actor,
    action: "order.cancelled",
    entityType: "order",
    entityId: order.id,
    summary: `${remaining.length === 0 ? "Order" : `${ids.length} item(s)`} cancelled (${input.reason.replace(/_/g, " ")})${
      scrappedTransferIds.length ? `; ${scrappedTransferIds.length} transfer(s) scrapped` : ""
    }${input.note ? `: ${input.note}` : ""}`,
    data: { orderItemIds: ids, scrappedTransferIds },
  });
  await emit(tx, ctx.companyId, "order.cancelled", {
    orderId: order.id,
    orderItemIds: ids,
    scrappedTransferIds,
  });
  publishOrder(tx, ctx.companyId, order.id);
  return getOrder(tx, ctx, order.id);
}

/* ------------------------------------ item actions ------------------------------------ */

const FLAG_SEVERITY: Record<string, ItemFlag["severity"]> = {
  needs_mapping: "error",
  personalization_missing: "error",
  artwork_overflow: "error",
  artwork_typo: "warn",
  artwork_suspicious_chars: "warn",
  artwork_low_dpi: "warn",
  artwork_qa_failed: "error",
  blank_oversold: "warn",
  address_invalid: "error",
  reprint: "info",
  manual_review: "warn",
};

export async function setItemFlag(
  tx: Tx,
  ctx: TenantContext,
  input: { id: string; code: ItemFlagCode; active: boolean; note: string | null },
) {
  const item = await getItemRow(tx, input.id);
  const message = input.note ?? input.code.replace(/_/g, " ");
  const flags = input.active
    ? withFlags(item.flags, [
        { code: input.code, severity: FLAG_SEVERITY[input.code] ?? "warn", message },
      ])
    : withFlags(item.flags, [], [input.code]);
  await tx.update(orderItems).set({ flags }).where(eq(orderItems.id, input.id));
  await audit(tx, {
    companyId: ctx.companyId,
    actor: ctx.actor,
    action: "item.flag",
    entityType: "order_item",
    entityId: input.id,
    summary: `${input.active ? "Flagged" : "Cleared"} ${input.code.replace(/_/g, " ")}${input.note ? `: ${input.note}` : ""}`,
    data: { orderId: item.orderId, code: input.code, active: input.active },
  });
  if (input.active)
    afterCommit(tx, async () => {
      await publish(ctx.companyId, "item.flagged", {
        orderItemId: item.id,
        orderId: item.orderId,
        codes: [input.code],
      });
    });
  return getItem(tx, ctx, input.id);
}

export async function setItemRush(
  tx: Tx,
  ctx: TenantContext,
  input: { id: string; isRush: boolean },
) {
  const item = await getItemRow(tx, input.id);
  await tx.update(orderItems).set({ isRush: input.isRush }).where(eq(orderItems.id, input.id));
  const [any] = await tx
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(orderItems)
    .where(and(eq(orderItems.orderId, item.orderId), eq(orderItems.isRush, true)));
  await tx
    .update(orders)
    .set({ isRush: (any?.n ?? 0) > 0 })
    .where(eq(orders.id, item.orderId));
  await audit(tx, {
    companyId: ctx.companyId,
    actor: ctx.actor,
    action: "item.rush",
    entityType: "order_item",
    entityId: input.id,
    summary: input.isRush ? "Marked rush" : "Rush removed",
    data: { orderId: item.orderId },
  });
  await emit(tx, ctx.companyId, "order.updated", { orderId: item.orderId });
  return getItem(tx, ctx, input.id);
}

/** Override a unit's artwork with an uploaded file; the item stops waiting on personalization. */
export async function setItemArtwork(
  tx: Tx,
  ctx: TenantContext,
  input: { id: string; fileKey: string; widthIn?: number; heightIn?: number },
) {
  if (!input.fileKey.startsWith(`${ctx.companyId}/`)) throw notFound("file");
  const item = await getItemRow(tx, input.id);
  if (
    !PRE_SHIPPED.has(item.state) ||
    !["imported", "needs_mapping", "ready", "needs_artwork", "on_hold"].includes(item.state)
  )
    throw conflict(`Artwork cannot change once the item is ${item.state.replace(/_/g, " ")}`);
  const qaFlags: { code: string; severity: ItemFlag["severity"]; message: string }[] = [];
  if (await imaging.isUp()) {
    try {
      const qa = await imaging.qaCheck({
        file_key: input.fileKey,
        target_width_in: input.widthIn ?? item.printWidthIn ?? undefined,
        target_height_in: input.heightIn ?? item.printHeightIn ?? undefined,
      });
      for (const issue of qa.issues) {
        qaFlags.push({
          code: issue.code === "low_dpi" ? "artwork_low_dpi" : "artwork_qa_failed",
          severity: issue.severity === "error" ? "error" : "warn",
          message: issue.message,
        });
      }
    } catch (err) {
      log.warn("artwork QA failed", { itemId: item.id, error: String(err) });
    }
  }
  const unique = qaFlags.filter((f, idx) => qaFlags.findIndex((x) => x.code === f.code) === idx);
  await tx
    .update(orderItems)
    .set({
      artworkKey: input.fileKey,
      artworkPreviewKey: input.fileKey,
      artworkStatus: "approved",
      printWidthIn: input.widthIn !== undefined ? Math.round(input.widthIn) : item.printWidthIn,
      printHeightIn: input.heightIn !== undefined ? Math.round(input.heightIn) : item.printHeightIn,
      flags: withFlags(item.flags, unique, [...ARTWORK_ITEM_FLAGS, "artwork_low_dpi"]),
    })
    .where(eq(orderItems.id, input.id));
  await audit(tx, {
    companyId: ctx.companyId,
    actor: ctx.actor,
    action: "artwork.overridden",
    entityType: "order_item",
    entityId: input.id,
    summary: `Artwork replaced with an uploaded file${unique.length ? ` (${unique.map((f) => f.code).join(", ")})` : ""}`,
    data: { orderId: item.orderId, fileKey: input.fileKey },
  });
  if (item.state === "needs_artwork")
    await transitionItem(tx, item.id, "ready", { actor: ctx.actor, reason: "artwork_uploaded" });
  return getItem(tx, ctx, input.id);
}

/* ------------------------------------ channel performance ------------------------------------ */

export async function channelPerformance(
  tx: Tx,
  _ctx: TenantContext,
  input: { period: { from: string; to: string } },
) {
  const from = new Date(input.period.from);
  const to = new Date(input.period.to);
  const firstLabel = sql`(select min(s.labeled_at) from shipments s where s.order_id = ${orders.id} and s.voided_at is null)`;
  const shippedAt = sql`coalesce(${firstLabel}, ${orders.shippedAt})`;
  const validTracking = sql`exists (select 1 from shipments s where s.order_id = ${orders.id} and s.voided_at is null and s.tracking_code is not null and s.tracking_push_status <> 'failed')`;
  const rows = await tx
    .select({
      channel: orders.channel,
      connectionId: orders.connectionId,
      orders: sql<number>`count(*)`.mapWith(Number),
      shipped: sql<number>`count(*) filter (where ${shippedAt} is not null)`.mapWith(Number),
      due: sql<number>`count(*) filter (where ${shippedAt} is not null or ${orders.shipBy} < now())`.mapWith(
        Number,
      ),
      late: sql<number>`count(*) filter (where (${shippedAt} is not null and ${shippedAt} > ${orders.shipBy}) or (${shippedAt} is null and ${orders.shipBy} < now()))`.mapWith(
        Number,
      ),
      tracked:
        sql<number>`count(*) filter (where ${shippedAt} is not null and ${validTracking})`.mapWith(
          Number,
        ),
      avgHours: sql<
        number | null
      >`avg(extract(epoch from (${shippedAt} - ${orders.placedAt})) / 3600) filter (where ${shippedAt} is not null)`,
    })
    .from(orders)
    .where(
      and(gte(orders.placedAt, from), lte(orders.placedAt, to), ne(orders.status, "cancelled")),
    )
    .groupBy(orders.channel, orders.connectionId);
  const items: ChannelPerformance[] = rows.map((r) => {
    const rules = CHANNEL_RULES[r.channel].shipBy;
    const lateRate = r.due ? r.late / r.due : 0;
    const validTrackingRate = r.shipped ? r.tracked / r.shipped : 0;
    const meetsTargets =
      (rules.onTimeTarget === null || 1 - lateRate >= rules.onTimeTarget) &&
      (rules.validTrackingTarget === null ||
        r.shipped === 0 ||
        validTrackingRate >= rules.validTrackingTarget);
    return {
      channel: r.channel,
      connectionId: r.connectionId,
      orders: r.orders,
      shipped: r.shipped,
      late: r.late,
      lateRate: Math.min(1, Math.round(lateRate * 10000) / 10000),
      validTrackingRate: Math.min(1, Math.round(validTrackingRate * 10000) / 10000),
      onTimeTarget: rules.onTimeTarget,
      validTrackingTarget: rules.validTrackingTarget,
      meetsTargets,
      avgHoursToShip:
        r.avgHours === null ? null : Math.max(0, Math.round(Number(r.avgHours) * 10) / 10),
    };
  });
  return { period: input.period, items };
}

/** Used by shipping to know which channel line ids a shipment covers (read helper). */
export async function itemsForOrder(tx: Tx, orderId: string) {
  return orderItemRows(tx, orderId);
}
