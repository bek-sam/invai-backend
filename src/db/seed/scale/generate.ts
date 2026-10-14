import { randomUUID } from "node:crypto";
import { CHANNEL_RULES, deriveOrderStatus, type OrderItemState } from "@invai/contracts";
import type {
  buyerPii,
  gangSheetBatches,
  gangSheets,
  orderItems,
  orderItemTransitions,
  orders,
  profitLines,
  reprints,
  shipments,
  transfers,
} from "../../schema";
import { DEFAULT_SHEET_SPEC } from "../../schema";
import { ffdPack } from "../builder";
import { CITIES, FIRST_NAMES, LAST_NAMES, type rng, STREETS } from "../data";
import type { SkuRef } from "./catalog";
import type { ScaleProfile } from "./profiles";

type Rng = ReturnType<typeof rng>;
type Channel = "etsy" | "shopify" | "amazon" | "tiktok" | "walmart";

/*
 * Generates one calendar day of orders for a profile as plain rows: orders, one order_items
 * row per physical unit, state-machine-valid transitions, gang sheets (first-fit-decreasing
 * packing from the builder, never imaging), transfers, reprints and profit lines. Pure apart
 * from the injected rng and ids; nothing here touches the database. Every date derives from
 * the one `now` in the context.
 */
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const CHANNEL_MIX: [Channel, number][] = [
  ["etsy", 0.35],
  ["shopify", 0.25],
  ["amazon", 0.2],
  ["tiktok", 0.12],
  ["walmart", 0.08],
];
const BASE_PRICE_CENTS: Record<Channel, number> = {
  etsy: 2499,
  shopify: 2800,
  amazon: 2699,
  tiktok: 2299,
  walmart: 2499,
};
const REPRINT_REASONS = ["misprint", "ghosting", "wrong_placement", "peel"] as const;

export const CANCEL_RATE = 0.035;
export const LATE_RATE = 0.052;
export const REPRINT_RATE = 0.03;
export const DELIVERED_RATE = 0.9;

type OrderInsert = typeof orders.$inferInsert;
type ItemInsert = typeof orderItems.$inferInsert;
type TransitionInsert = typeof orderItemTransitions.$inferInsert;
type BatchInsert = typeof gangSheetBatches.$inferInsert;
type SheetInsert = typeof gangSheets.$inferInsert;
type TransferInsert = typeof transfers.$inferInsert;
type ReprintInsert = typeof reprints.$inferInsert;
type ProfitInsert = typeof profitLines.$inferInsert;
type ShipmentInsert = typeof shipments.$inferInsert;
type BuyerPiiInsert = typeof buyerPii.$inferInsert;

/** Days a delivered order's buyer data is kept (`PII_RETENTION_DAYS`, privacy purge). */
const PII_RETENTION_MS = 30 * DAY;

export type GenContext = {
  profile: ScaleProfile;
  now: number;
  random: Rng;
  companyId: string;
  connections: Record<Channel, string>;
  vendorConnectionIds: string[];
  pressStationIds: string[];
  skus: SkuRef[];
  sheetKeys: { png: string[]; preview: string[] };
  counters: { order: number; sheet: number; reprint: number };
};

export type DayRows = {
  orders: OrderInsert[];
  items: ItemInsert[];
  transitions: TransitionInsert[];
  batches: BatchInsert[];
  sheets: SheetInsert[];
  transfers: TransferInsert[];
  reprints: ReprintInsert[];
  profit: ProfitInsert[];
  /** One per order with a shipped or delivered unit (A3.3). No label rows, no label keys. */
  shipments: ShipmentInsert[];
  /** Fake buyer data for open and recently delivered orders (A3.4); encrypted at insert. */
  buyerPii: BuyerPiiInsert[];
};

type Fate =
  | "normal"
  | "cancelled"
  | "cancel_on_sheet"
  | "stuck"
  | "hold"
  | "needs_mapping"
  | "needs_artwork"
  | "reprint";

type Hop = { state: OrderItemState; at: number; reason?: string };

function utcStartOfDay(ms: number): number {
  return Math.floor(ms / DAY) * DAY;
}

function pickChannel(random: Rng): Channel {
  let u = random.next();
  for (const [c, w] of CHANNEL_MIX) {
    if (u < w) return c;
    u -= w;
  }
  return "etsy";
}

function pickItemCount(profile: ScaleProfile, random: Rng): number {
  let u = random.next();
  for (let i = 0; i < profile.itemsMix.length; i++) {
    const w = profile.itemsMix[i] as number;
    if (u < w) return i + 1;
    u -= w;
  }
  return 1;
}

/** Top-heavy pick: a few SKUs sell a lot, most sell rarely. */
function pickSku(ctx: GenContext): SkuRef {
  const i = Math.floor(ctx.skus.length * ctx.random.next() ** 2.2);
  return ctx.skus[Math.min(i, ctx.skus.length - 1)] as SkuRef;
}

function orderNumber(channel: Channel, i: number): string {
  return channel === "shopify"
    ? `#${9000 + i}`
    : channel === "etsy"
      ? String(5104000000 + i * 37)
      : channel === "amazon"
        ? `114-${String(3000000 + i * 911).padStart(7, "0")}-${String(2000000 + (i % 7_000_000)).padStart(7, "0")}`
        : `6763${String(200000000 + i * 7)}`;
}

/** Hop fractions of the span placed -> shipped. `loop` adds one QC fail and a second press. */
function standardHops(placed: number, shipped: number, loop: boolean): Hop[] {
  const span = shipped - placed;
  const at = (f: number) => Math.round(placed + f * span);
  if (loop) {
    return [
      { state: "ready", at: at(0.04) },
      { state: "on_sheet", at: at(0.15) },
      { state: "transfer_in", at: at(0.4) },
      { state: "pressed", at: at(0.55) },
      { state: "ready", at: at(0.6), reason: "qc_fail" },
      { state: "on_sheet", at: at(0.66) },
      { state: "transfer_in", at: at(0.74) },
      { state: "pressed", at: at(0.82) },
      { state: "packed", at: at(0.92) },
      { state: "shipped", at: shipped },
    ];
  }
  return [
    { state: "ready", at: at(0.04) },
    { state: "on_sheet", at: at(0.2) },
    { state: "transfer_in", at: at(0.58) },
    { state: "pressed", at: at(0.78) },
    { state: "packed", at: at(0.9) },
    { state: "shipped", at: shipped },
  ];
}

type Planned = {
  channel: Channel;
  placedAt: number;
  shipBy: number;
  fate: Fate;
  hopsFor: (unit: number) => Hop[]; // already cut at now
  holdReason: boolean;
};

function fateFor(ctx: GenContext, d: number, k: number, ageDays: number): Fate {
  if (d === 2 && k < 4)
    return (["cancel_on_sheet", "hold", "needs_mapping", "needs_artwork"] as const)[k] as Fate;
  if (d === 8 && k === 0) return "reprint";
  const f = ctx.profile.floors.openPastShipBy;
  if (k === 4 && d >= 7 && d < 7 + f) return "stuck";
  const u = ctx.random.next();
  if (d >= 1 && d <= 4) {
    if (u < 0.006) return "hold";
    if (u < 0.012) return "needs_mapping";
    if (u < 0.017) return "needs_artwork";
  }
  if (ctx.random.next() < CANCEL_RATE) {
    return ctx.random.chance(0.2) ? "cancel_on_sheet" : "cancelled";
  }
  if (ageDays >= 6 && ctx.random.next() < ctx.profile.stuckPct) return "stuck";
  if (ageDays >= 6 && ctx.random.next() < REPRINT_RATE) return "reprint";
  return "normal";
}

function planOrder(ctx: GenContext, d: number, k: number, placedAt: number): Planned {
  const { random, now } = ctx;
  const channel = pickChannel(random);
  const defaultDays = CHANNEL_RULES[channel].shipBy.defaultDays;
  const shipBy = placedAt + defaultDays * DAY;
  const ageDays = (now - placedAt) / DAY;
  let fate = fateFor(ctx, d, k, ageDays);
  // A stuck order must really be past its ship-by; otherwise it is an ordinary order.
  if (fate === "stuck" && ageDays < defaultDays + 2) fate = "normal";
  const cut = (hops: Hop[]) => hops.filter((h) => h.at <= now);

  if (fate === "cancelled") {
    const at = placedAt + 8 * HOUR;
    return {
      channel,
      placedAt,
      shipBy,
      fate,
      hopsFor: () => cut([{ state: "cancelled", at }]),
      holdReason: false,
    };
  }
  if (fate === "cancel_on_sheet") {
    const hops: Hop[] = [
      { state: "ready", at: placedAt + 2 * HOUR },
      { state: "on_sheet", at: placedAt + 6 * HOUR },
      { state: "cancelled", at: placedAt + 9 * HOUR },
    ];
    return { channel, placedAt, shipBy, fate, hopsFor: () => cut(hops), holdReason: false };
  }
  if (fate === "hold") {
    const hops: Hop[] = [
      { state: "ready", at: placedAt + 2 * HOUR },
      { state: "on_hold", at: placedAt + 5 * HOUR, reason: "address_check" },
    ];
    return { channel, placedAt, shipBy, fate, hopsFor: () => cut(hops), holdReason: true };
  }
  if (fate === "needs_mapping") {
    return {
      channel,
      placedAt,
      shipBy,
      fate,
      hopsFor: () => [{ state: "needs_mapping", at: placedAt }],
      holdReason: false,
    };
  }
  if (fate === "needs_artwork") {
    const hops: Hop[] = [
      { state: "ready", at: placedAt + 2 * HOUR },
      { state: "needs_artwork", at: placedAt + 3 * HOUR },
    ];
    return { channel, placedAt, shipBy, fate, hopsFor: () => cut(hops), holdReason: false };
  }
  if (fate === "stuck") {
    // Never ships: stops at ready, on_sheet, transfer_in or pressed, days past its ship-by.
    const stopAt = random.pick(["ready", "on_sheet", "transfer_in", "pressed"] as const);
    const span = (shipBy - placedAt) * 0.7;
    const hops = standardHops(placedAt, placedAt + span / 0.9, false);
    const upTo = hops.findIndex((h) => h.state === stopAt);
    return {
      channel,
      placedAt,
      shipBy,
      fate,
      hopsFor: () => cut(hops.slice(0, upTo + 1)),
      holdReason: false,
    };
  }

  // normal / reprint: ships on time, or late once the order is old enough to know.
  const canBeLate = ageDays >= defaultDays + 3;
  const late = canBeLate && random.next() < LATE_RATE;
  const shippedAt = Math.round(
    late
      ? shipBy + (4 + 32 * random.next()) * HOUR
      : placedAt + (shipBy - placedAt) * (0.45 + 0.48 * random.next()),
  );
  const willDeliver = random.next() < DELIVERED_RATE;
  const deliveredAt = shippedAt + (2 + 2 * random.next()) * DAY;
  const tail: Hop[] = willDeliver ? [{ state: "delivered", at: Math.round(deliveredAt) }] : [];
  const plain = [...standardHops(placedAt, shippedAt, false), ...tail];
  const looped = [...standardHops(placedAt, shippedAt, true), ...tail];
  const isReprint = fate === "reprint";
  return {
    channel,
    placedAt,
    shipBy,
    fate,
    hopsFor: (unit) => cut(isReprint && unit === 1 ? looped : plain),
    holdReason: false,
  };
}

type Draft = {
  item: ItemInsert;
  hops: Hop[];
  sku: SkuRef;
  orderNo: string;
  channel: Channel;
  itemsInOrder: number;
  loop: boolean;
};

export function generateDay(ctx: GenContext, d: number): DayRows {
  const { profile, now, random, companyId } = ctx;
  const dayStart = utcStartOfDay(now) - d * DAY;
  const avail = d === 0 ? Math.max(HOUR, now - dayStart) : DAY;
  const count = Math.max(
    1,
    Math.round(profile.ordersPerDay * (0.88 + 0.24 * random.next()) * (avail / DAY)),
  );

  const out: DayRows = {
    orders: [],
    items: [],
    transitions: [],
    batches: [],
    sheets: [],
    transfers: [],
    reprints: [],
    profit: [],
    shipments: [],
    buyerPii: [],
  };
  const drafts: Draft[] = [];

  for (let k = 0; k < count; k++) {
    const placedAt = dayStart + Math.floor(random.next() * avail);
    const plan = planOrder(ctx, d, k, Math.min(placedAt, now - 60_000));
    const seq = ctx.counters.order++;
    const orderId = randomUUID();
    const orderNo = orderNumber(plan.channel, seq);
    const nItems = pickItemCount(profile, random);
    const oneLine = nItems >= 2 && random.next() < 0.15;
    const lines = oneLine ? 1 : nItems;
    const unitsPerLine = oneLine ? nItems : 1;

    const shipping = plan.channel === "amazon" ? 0 : random.pick([0, 0, 499, 599]);
    let subtotal = 0;
    const orderDrafts: Draft[] = [];
    for (let line = 1; line <= lines; line++) {
      const sku = pickSku(ctx);
      const price = BASE_PRICE_CENTS[plan.channel] + sku.priceExtraCents;
      for (let unit = 1; unit <= unitsPerLine; unit++) {
        const hops = plan.hopsFor(unit);
        const last = hops[hops.length - 1];
        const state: OrderItemState = last?.state ?? "imported";
        const stateAt = last?.at ?? plan.placedAt;
        const held = hops.find((h) => h.state === "on_hold");
        const loop =
          hops.filter((h) => h.state === "pressed").length > 1 ||
          hops.some((h) => h.reason === "qc_fail");
        subtotal += price;
        orderDrafts.push({
          hops,
          sku,
          orderNo,
          channel: plan.channel,
          itemsInOrder: lines * unitsPerLine,
          loop,
          item: {
            id: randomUUID(),
            companyId,
            orderId,
            lineNo: line,
            unitNo: unit,
            unitsInLine: unitsPerLine,
            channelLineId: `${orderNo}-${line}`,
            channelSku: sku.sku,
            channelListingId: String(1400000000 + Number.parseInt(sku.design.code.slice(2), 10)),
            title: `${sku.design.name} Shirt`,
            variantTitle: `${sku.blank.color} / ${sku.blank.size}`,
            unitPriceCents: price,
            state,
            heldFromState: held ? "ready" : null,
            stateChangedAt: new Date(stateAt),
            shipBy: new Date(plan.shipBy),
            designId: sku.design.id,
            blankVariantId: sku.blank.id,
            placement: sku.design.size.placement,
            printWidthIn: sku.design.size.widthIn,
            printHeightIn: sku.design.size.heightIn,
            artworkStatus: state === "needs_artwork" ? "pending" : "none",
            createdAt: new Date(plan.placedAt),
            updatedAt: new Date(stateAt),
          },
        });
      }
    }

    const states = orderDrafts.map((x) => x.item.state as OrderItemState);
    const status = deriveOrderStatus(states);
    const tax = Math.round(subtotal * 0.072);
    const lastAt = Math.max(plan.placedAt, ...orderDrafts.flatMap((x) => x.hops.map((h) => h.at)));
    const hopAt = (s: OrderItemState) => {
      const times = orderDrafts.flatMap((x) =>
        x.hops.filter((h) => h.state === s).map((h) => h.at),
      );
      return times.length ? new Date(Math.max(...times)) : null;
    };
    out.orders.push({
      id: orderId,
      companyId,
      connectionId: ctx.connections[plan.channel],
      channel: plan.channel,
      channelOrderId: `${plan.channel}-scale-${seq}`,
      orderNo,
      status,
      placedAt: new Date(plan.placedAt),
      shipBy: new Date(plan.shipBy),
      shippingMethod: shipping
        ? "Standard"
        : plan.channel === "amazon"
          ? "Standard"
          : "Free shipping",
      buyerRef: `buyer-sc-${seq}`,
      subtotalCents: subtotal,
      shippingCents: shipping,
      taxCents: tax,
      discountCents: 0,
      totalCents: subtotal + shipping + tax,
      itemCount: orderDrafts.length,
      holdReason: plan.holdReason ? "address_check" : null,
      heldAt: plan.holdReason ? hopAt("on_hold") : null,
      cancelReason: status === "cancelled" ? "buyer_request" : null,
      cancelledAt: status === "cancelled" ? hopAt("cancelled") : null,
      shippedAt: hopAt("shipped"),
      deliveredAt: hopAt("delivered"),
      createdAt: new Date(plan.placedAt),
      updatedAt: new Date(lastAt),
    });
    shipDraft(ctx, seq, orderId, orderDrafts, out);
    piiDraft(ctx, seq, orderId, out.orders[out.orders.length - 1] as OrderInsert, out);
    for (const x of orderDrafts) {
      let from: OrderItemState = "imported";
      for (const hop of x.hops) {
        out.transitions.push({
          companyId,
          orderItemId: x.item.id as string,
          orderId,
          fromState: from,
          toState: hop.state,
          actorKind: "system",
          reason: hop.reason ?? null,
          createdAt: new Date(hop.at),
        });
        from = hop.state;
      }
      out.items.push(x.item);
      drafts.push(x);
    }
  }

  sheetDay(ctx, d, drafts, out);
  profitDay(ctx, drafts, out);
  return out;
}

/*
 * Shipments (A3.3): one per order with at least one shipped or delivered unit, mock-carrier
 * shaped like the demo seed's. `label_key` and `label_format` stay NULL on purpose (a documented
 * null): the scale seed writes no `files` rows, so a key would name a missing object (B-403), and
 * no `labels` rows either (`labels.label_key` is NOT NULL). Tracking is unique per order number.
 */
function shipDraft(ctx: GenContext, seq: number, orderId: string, drafts: Draft[], out: DayRows) {
  const shipped = drafts.filter((x) => x.item.state === "shipped" || x.item.state === "delivered");
  if (!shipped.length) return;
  const firstShipped = Math.min(
    ...shipped.map(
      (x) => x.hops.find((h) => h.state === "shipped")?.at ?? Number.POSITIVE_INFINITY,
    ),
  );
  const delivered = shipped.every((x) => x.item.state === "delivered");
  const deliveredAt = delivered
    ? Math.max(...shipped.map((x) => x.hops.find((h) => h.state === "delivered")?.at ?? 0))
    : null;
  const digits = String(seq).padStart(8, "0");
  const tracking = `9400 1000 0000 ${digits.slice(0, 4)} ${digits.slice(4)} ${String(10 + (seq % 90)).padStart(2, "0")}`;
  const weightOz = Math.round((5.5 * shipped.length + 0.4) * 10) / 10;
  const created = new Date(firstShipped - 60_000);
  out.shipments.push({
    companyId: ctx.companyId,
    orderId,
    orderItemIds: shipped.map((x) => x.item.id as string),
    status: delivered ? "delivered" : "in_transit",
    carrier: "usps",
    service: "GroundAdvantage",
    trackingCode: tracking,
    trackingUrl: `https://tools.usps.com/go/TrackConfirmAction?tLabels=${tracking.replace(/\s/g, "")}`,
    trackingStatus: delivered ? "delivered" : "in_transit",
    labelKey: null,
    labelFormat: null,
    postageCents: 450 + Math.round(weightOz * 22),
    labelFeeCents: 4,
    lengthIn: 10,
    widthIn: 13,
    heightIn: 1,
    weightOz,
    ratedAt: created,
    carrierShipmentId: `shp_mock_${seq}`,
    trackingPushStatus: "pushed",
    trackingPushedAt: new Date(firstShipped),
    trackingPushAttempts: 1,
    labeledAt: new Date(firstShipped - 30_000),
    deliveredAt: deliveredAt === null ? null : new Date(deliveredAt),
    createdAt: created,
    updatedAt: new Date(deliveredAt ?? firstShipped),
  });
}

/*
 * Fake buyer data (A3.4) for every order not delivered, plus delivered orders still inside the
 * 30-day retention window. Names come from the demo seed's lists, addresses are fictional,
 * emails use example.com and phones the 555-01NN range. No rng draw: the pick is arithmetic on
 * the order number, so adding this changes none of the other generated rows.
 */
function piiDraft(ctx: GenContext, seq: number, orderId: string, order: OrderInsert, out: DayRows) {
  const delivered = order.deliveredAt ? order.deliveredAt.getTime() : null;
  if (delivered !== null && delivered + PII_RETENTION_MS <= ctx.now) return;
  const first = FIRST_NAMES[seq % FIRST_NAMES.length] as string;
  const last = LAST_NAMES[(seq * 7 + 3) % LAST_NAMES.length] as string;
  const city = CITIES[seq % CITIES.length] as (typeof CITIES)[number];
  out.buyerPii.push({
    companyId: ctx.companyId,
    orderId,
    name: `${first} ${last}`,
    email: `${first}.${last}${seq}@example.com`.toLowerCase().replace(/[^a-z0-9.@]/g, ""),
    phone: `602-555-01${String(seq % 100).padStart(2, "0")}`,
    company: null,
    street1: `${100 + ((seq * 13) % 8900)} ${STREETS[seq % STREETS.length]}`,
    street2: seq % 5 === 0 ? `Apt ${1 + (seq % 40)}` : null,
    city: city.city,
    state: city.state,
    zip: city.zip,
    country: "US",
    purgeAfter: delivered === null ? null : new Date(delivered + PII_RETENTION_MS),
    createdAt: order.createdAt as Date,
    updatedAt: order.updatedAt as Date,
  });
}

/** Sheet the day's items in on-sheet order; one batch per day, equal-sized sheets. */
function sheetDay(ctx: GenContext, d: number, drafts: Draft[], out: DayRows) {
  const { profile, now, companyId } = ctx;
  const sheeted = drafts
    .filter((x) => x.item.state !== "cancelled")
    .map((x) => ({ x, onSheetAt: x.hops.find((h) => h.state === "on_sheet")?.at }))
    .filter((e): e is { x: Draft; onSheetAt: number } => e.onSheetAt !== undefined)
    .sort((a, b) => a.onSheetAt - b.onSheetAt);
  if (!sheeted.length) return;

  const day = new Date(utcStartOfDay(now) - d * DAY).toISOString().slice(0, 10);
  const sheetCount = Math.ceil(sheeted.length / profile.perSheet);
  const size = Math.ceil(sheeted.length / sheetCount);
  const batchId = randomUUID();
  const firstAt = sheeted[0]?.onSheetAt as number;
  const lastOnSheet = sheeted[sheeted.length - 1]?.onSheetAt as number;
  out.batches.push({
    id: batchId,
    companyId,
    name: `${day} build`,
    status: "sent",
    dueBefore: new Date(firstAt + 2 * DAY),
    vendorConnectionId: ctx.vendorConnectionIds[0] ?? null,
    itemCount: sheeted.length,
    sheetCount,
    createdAt: new Date(firstAt),
    updatedAt: new Date(Math.min(now, lastOnSheet)),
  });

  for (let s = 0; s < sheetCount; s++) {
    const chunk = sheeted.slice(s * size, (s + 1) * size);
    if (!chunk.length) continue;
    const sheetSeq = ++ctx.counters.sheet;
    const sheetId = randomUUID();
    const plan = ffdPack(
      chunk.map((e) => ({
        id: e.x.item.id as string,
        widthIn: e.x.sku.design.size.widthIn,
        heightIn: e.x.sku.design.size.heightIn,
        e,
      })),
      DEFAULT_SHEET_SPEC,
    );
    const lastOn = Math.max(...chunk.map((e) => e.onSheetAt));
    const stillOnSheet = chunk.filter((e) => e.x.item.state === "on_sheet");
    const firstIn = Math.min(
      ...chunk.map(
        (e) => e.x.hops.find((h) => h.state === "transfer_in")?.at ?? Number.POSITIVE_INFINITY,
      ),
    );
    const received = stillOnSheet.length === 0 && Number.isFinite(firstIn);
    const sentAt = Math.min(now, lastOn + 30 * 60_000);
    const status = received ? "received" : now - lastOn > 10 * HOUR ? "printed" : "sent";
    const gap = received ? Math.max(0, firstIn - sentAt) : 0;
    const at = (f: number) => new Date(Math.round(sentAt + f * gap));
    const costCents = Math.round(plan.lengthIn * DEFAULT_SHEET_SPEC.pricePerInch);
    out.sheets.push({
      id: sheetId,
      companyId,
      batchId,
      sheetNo: s + 1,
      name: `${day} #${sheetSeq}`,
      vendorConnectionId:
        ctx.vendorConnectionIds[sheetSeq % ctx.vendorConnectionIds.length] ?? null,
      widthIn: DEFAULT_SHEET_SPEC.widthIn,
      lengthIn: plan.lengthIn,
      utilization: plan.utilization,
      status,
      transferCount: plan.placements.length,
      reprintCount: chunk.filter((e) => e.x.loop).length,
      costCents,
      pngKey: received ? null : (ctx.sheetKeys.png[sheetSeq % ctx.sheetKeys.png.length] ?? null),
      previewKey: received
        ? null
        : (ctx.sheetKeys.preview[sheetSeq % ctx.sheetKeys.preview.length] ?? null),
      sentAt: new Date(sentAt),
      acknowledgedAt: received ? at(0.1) : status === "printed" ? new Date(sentAt + HOUR) : null,
      printedAt: received ? at(0.4) : status === "printed" ? new Date(sentAt + 4 * HOUR) : null,
      shippedAt: received ? at(0.7) : null,
      receivedAt: received ? new Date(firstIn) : null,
      createdAt: new Date(chunk[0]?.onSheetAt as number),
      updatedAt: new Date(received ? firstIn : sentAt),
    });
    for (const p of plan.placements) {
      const x = p.item.e.x;
      const transferId = randomUUID();
      const it = x.item;
      it.gangSheetId = sheetId;
      it.transferId = transferId;
      it.isReprint = x.loop;
      const pressedAt = [...x.hops].reverse().find((h) => h.state === "pressed")?.at;
      const state = it.state as OrderItemState;
      out.transfers.push({
        id: transferId,
        companyId,
        gangSheetId: sheetId,
        orderItemId: it.id as string,
        xIn: p.xIn,
        yIn: p.yIn,
        widthIn: x.sku.design.size.widthIn,
        heightIn: x.sku.design.size.heightIn,
        rotated: p.rotated,
        label: {
          order_no: x.orderNo,
          item_no: `${it.lineNo}.${it.unitNo}`,
          size: x.sku.blank.size,
          color: x.sku.blank.color,
          design: x.sku.design.code,
          reprint: x.loop,
        },
        status:
          pressedAt !== undefined && state !== "on_sheet" && state !== "transfer_in"
            ? "pressed"
            : state === "transfer_in"
              ? "received"
              : "placed",
        isReprint: x.loop,
        pressedAt:
          pressedAt !== undefined && state !== "transfer_in" && state !== "on_sheet"
            ? new Date(pressedAt)
            : null,
        createdAt: new Date(p.item.e.onSheetAt),
        updatedAt: new Date(p.item.e.onSheetAt),
      });
      if (x.loop) {
        const reprintAt = x.hops.find((h) => h.reason === "qc_fail")?.at;
        if (reprintAt !== undefined) {
          const idx = ctx.counters.reprint++;
          out.reprints.push({
            companyId,
            orderItemId: it.id as string,
            reason: REPRINT_REASONS[
              idx % REPRINT_REASONS.length
            ] as (typeof REPRINT_REASONS)[number],
            status: "done",
            originalTransferId: transferId,
            stationId: ctx.pressStationIds[idx % Math.max(1, ctx.pressStationIds.length)] ?? null,
            requestedAt: new Date(reprintAt),
            createdAt: new Date(reprintAt),
            updatedAt: new Date(reprintAt),
          });
        }
      }
    }
  }
  const mine = out.sheets.filter((sh) => sh.batchId === batchId);
  if (mine.length && mine.every((sh) => sh.status === "received")) {
    const b = out.batches.find((x) => x.id === batchId);
    if (b) b.status = "complete";
  }
}

/** One profit line per shipped or delivered item, from the same buckets `getProfit` reads. */
function profitDay(ctx: GenContext, drafts: Draft[], out: DayRows) {
  const { companyId, now } = ctx;
  const sheetById = new Map(out.sheets.map((s) => [s.id as string, s]));
  const orderById = new Map(out.orders.map((o) => [o.id as string, o]));
  for (const x of drafts) {
    const it = x.item;
    if (it.state !== "shipped" && it.state !== "delivered") continue;
    const order = orderById.get(it.orderId as string) as OrderInsert;
    const fees = CHANNEL_RULES[x.channel].fees;
    const revenue = it.unitPriceCents as number;
    const channelFees = Math.round(
      (revenue * (fees.transactionPct + fees.paymentPct)) / 100 +
        (fees.perOrderCents + fees.paymentFixedCents) / x.itemsInOrder,
    );
    const sheet = sheetById.get(it.gangSheetId as string);
    const area = x.sku.design.size.widthIn * x.sku.design.size.heightIn;
    const sheetArea = sheet ? (sheet.widthIn as number) * (sheet.lengthIn as number) : 0;
    const transferCost =
      sheet && sheetArea > 0
        ? Math.round(((sheet.costCents as number) * area) / sheetArea)
        : Math.round(area * 3);
    const estimated = ["channelFees", "adsCost", "labelCost"];
    if (!sheet || x.loop) estimated.push("transferCost");
    const blankCost = x.sku.blank.costCents;
    const labelCost = 450;
    const packagingCost = Math.round(45 / x.itemsInOrder);
    const laborCost = Math.round((4 * 1800) / 60);
    const net =
      revenue - channelFees - blankCost - transferCost - labelCost - packagingCost - laborCost;
    out.profit.push({
      companyId,
      orderId: it.orderId as string,
      orderItemId: it.id as string,
      channel: x.channel,
      designId: it.designId ?? null,
      blankVariantId: it.blankVariantId ?? null,
      styleCode: x.sku.blank.styleCode,
      revenueCents: revenue,
      channelFeesCents: channelFees,
      blankCostCents: blankCost,
      transferCostCents: transferCost,
      labelCostCents: labelCost,
      packagingCostCents: packagingCost,
      laborCostCents: laborCost,
      adsCostCents: 0,
      refundsCents: 0,
      netCents: net,
      marginPct: revenue > 0 ? net / revenue : null,
      printAreaSqIn: area,
      laborMinutes: 4,
      isReprint: x.loop,
      estimated,
      placedAt: order.placedAt as Date,
      computedAt: new Date(now),
    });
  }
}
