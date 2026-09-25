import type {
  BatchBuyResult as BatchBuyResultSchema,
  RatesInput as RatesInputSchema,
  RatesResult as RatesResultSchema,
  Shipment,
  ShippingSettings,
  ShippingSettingsInput as ShippingSettingsInputSchema,
  ShipQueueEntry,
  TrackingPushStatus as TrackingPushStatusSchema,
} from "@invai/contracts";
import { and, asc, desc, eq, gte, ilike, inArray, lte, or, type SQL, sql } from "drizzle-orm";
import { PDFDocument } from "pdf-lib";
import type { z } from "zod";
import type { TenantContext } from "../../api/context";
import { afterCommit, type Tx, withTenant } from "../../db/client";
import type { Address, RateQuote, ShipmentState } from "../../db/schema";
import {
  bins,
  blankVariants,
  buyerPii,
  labels,
  orderItems,
  orders,
  packagePresets,
  shipments,
  shippingSettings,
} from "../../db/schema";
import {
  type BuyRequest,
  CarrierError,
  type CarrierRate,
  carrierAdapter,
  type Parcel,
  type PurchasedLabel,
  type VoidResult,
} from "../../integrations/carriers";
import { type Actor, audit } from "../../lib/audit";
import { badRequest, conflict, notFound, ORPCError, upstream } from "../../lib/errors";
import { logger } from "../../lib/log";
import { emit } from "../../lib/outbox";
import { keyset, type PageInput } from "../../lib/pagination";
import { publish } from "../../lib/realtime";
import { getObject, objectKey, presignGet, putObject } from "../../lib/s3";
import { assertPaidActionAllowed } from "../billing/service";
import { pushTrackingForShipment } from "../channels/service";
import { transitionItem } from "../orders/state-machine";
import { createJobRow, updateJobRow } from "../production/service";

const log = logger("shipping");

/*
 * Shipping: rate-shop packed orders, buy labels (EasyPost or the mock carrier), merge 4x6 label
 * PDFs, push tracking to the channel and follow the package to delivery. Items move
 * packed -> shipped once tracking is pushed, or on the carrier's first scan when the channel
 * gets no push (CSV-only, manual upload, push off), so a label can be voided until then. Every
 * carrier and channel call runs with no transaction open, after a committed intent (R8).
 */

type ShipmentRow = typeof shipments.$inferSelect;
type SettingsRow = typeof shippingSettings.$inferSelect;
type PresetRow = typeof packagePresets.$inferSelect;
type RatesInput = z.infer<typeof RatesInputSchema>;
type RatesResult = z.infer<typeof RatesResultSchema>;
type BatchBuyResult = z.infer<typeof BatchBuyResultSchema>;
type TrackingPushStatus = z.infer<typeof TrackingPushStatusSchema>;
type SettingsInput = z.infer<typeof ShippingSettingsInputSchema>;
type Strategy = "cheapest" | "fastest" | "cheapest_on_time";

/** Platform per-label fee (billing), in cents. */
export const LABEL_FEE_CENTS = 4;
/** Quotes older than this must be fetched again before buying. */
const RATE_TTL_MS = 24 * 3600_000;
/** Days after delivery before buyer PII is purged. */
const PII_RETENTION_DAYS = 30;
/** Mock carrier: hours from label to "in transit" and to "delivered". */
export const MOCK_TRANSIT_HOURS = Number(process.env.MOCK_CARRIER_TRANSIT_HOURS ?? 2);
export const MOCK_DELIVERY_HOURS = Number(process.env.MOCK_CARRIER_DELIVERY_HOURS ?? 72);

const LIVE_LABEL: ShipmentState[] = ["labeled", "in_transit", "delivered", "exception", "returned"];
/** A carrier call is in flight or its outcome is unknown: no new rate, buy or push for it. */
const BUSY: ShipmentState[] = ["buying", "voiding"];

/** The API shows the internal intent states as the state they started from. */
function apiStatus(status: ShipmentState): Shipment["status"] {
  if (status === "buying") return "rated";
  if (status === "voiding") return "labeled";
  return status;
}

/* --------------------------------- settings -------------------------------- */

async function settingsRow(tx: Tx, ctx: TenantContext): Promise<SettingsRow> {
  const [row] = await tx.select().from(shippingSettings).limit(1);
  if (row) return row;
  const [created] = await tx
    .insert(shippingSettings)
    .values({ companyId: ctx.companyId })
    .onConflictDoNothing()
    .returning();
  if (created) return created;
  const [again] = await tx.select().from(shippingSettings).limit(1);
  if (!again) throw new Error("shipping settings missing");
  return again;
}

async function presetRows(tx: Tx) {
  return tx
    .select()
    .from(packagePresets)
    .orderBy(desc(packagePresets.isDefault), asc(packagePresets.maxUnits));
}

function toSettings(row: SettingsRow, presets: PresetRow[]): ShippingSettings {
  return {
    fromAddress: row.fromAddress
      ? { ...row.fromAddress, country: row.fromAddress.country || "US" }
      : null,
    packagePresets: presets.map((p) => ({
      id: p.id,
      name: p.name,
      lengthIn: p.lengthIn,
      widthIn: p.widthIn,
      heightIn: p.heightIn,
      tareOz: p.tareOz,
      maxUnits: p.maxUnits,
      isDefault: p.isDefault,
    })),
    weightPerStyle: row.weightPerStyle,
    defaultStrategy: row.defaultStrategy,
    allowedCarriers: row.allowedCarriers as ShippingSettings["allowedCarriers"],
    labelFormat: row.labelFormat,
    trackingPushEnabled: row.trackingPushEnabled,
    carrierProvider: carrierAdapter().provider,
  };
}

export async function getSettings(tx: Tx, ctx: TenantContext) {
  return toSettings(await settingsRow(tx, ctx), await presetRows(tx));
}

export async function updateSettings(tx: Tx, ctx: TenantContext, input: SettingsInput) {
  const row = await settingsRow(tx, ctx);
  await tx
    .update(shippingSettings)
    .set({
      fromAddress: input.fromAddress === undefined ? row.fromAddress : input.fromAddress,
      weightPerStyle: input.weightPerStyle ?? row.weightPerStyle,
      defaultStrategy: input.defaultStrategy ?? row.defaultStrategy,
      allowedCarriers: input.allowedCarriers ?? row.allowedCarriers,
      labelFormat: input.labelFormat ?? row.labelFormat,
      trackingPushEnabled: input.trackingPushEnabled ?? row.trackingPushEnabled,
    })
    .where(eq(shippingSettings.id, row.id));
  if (input.packagePresets) {
    if (input.packagePresets.filter((p) => p.isDefault).length > 1)
      throw badRequest("Only one package preset can be the default");
    const existing = await presetRows(tx);
    const keep = new Set(input.packagePresets.map((p) => p.id).filter((id): id is string => !!id));
    const drop = existing.filter((p) => !keep.has(p.id)).map((p) => p.id);
    if (drop.length) await tx.delete(packagePresets).where(inArray(packagePresets.id, drop));
    for (const p of input.packagePresets) {
      const values = {
        name: p.name,
        lengthIn: p.lengthIn,
        widthIn: p.widthIn,
        heightIn: p.heightIn,
        tareOz: p.tareOz,
        maxUnits: p.maxUnits,
        isDefault: p.isDefault,
      };
      if (p.id && existing.some((e) => e.id === p.id))
        await tx.update(packagePresets).set(values).where(eq(packagePresets.id, p.id));
      else await tx.insert(packagePresets).values({ companyId: ctx.companyId, ...values });
    }
  }
  await audit(tx, {
    companyId: ctx.companyId,
    actor: ctx.actor,
    action: "settings.changed",
    entityType: "shipping_settings",
    entityId: row.id,
    summary: "Shipping settings updated",
  });
  return getSettings(tx, ctx);
}

/* ---------------------------------- parcels -------------------------------- */

export function choosePreset(presets: PresetRow[], units: number): PresetRow | null {
  const fitting = presets
    .filter((p) => p.maxUnits == null || p.maxUnits >= units)
    .sort((a, b) => (a.maxUnits ?? 1e9) - (b.maxUnits ?? 1e9));
  return fitting[0] ?? presets.find((p) => p.isDefault) ?? presets[0] ?? null;
}

/** Garment weight per unit (style override > blank variant weight) plus the package tare. */
export function parcelWeight(
  blanks: { styleCode: string; weightOz: number }[],
  weightPerStyle: { styleCode: string; weightOz: number }[],
  tareOz: number,
) {
  const override = new Map(weightPerStyle.map((w) => [w.styleCode.toLowerCase(), w.weightOz]));
  const garments = blanks.reduce(
    (s, b) => s + (override.get(b.styleCode.toLowerCase()) ?? b.weightOz),
    0,
  );
  return Math.max(1, Math.round((garments + tareOz) * 10) / 10);
}

type OrderPack = {
  order: typeof orders.$inferSelect;
  itemIds: string[];
  blanks: { styleCode: string; weightOz: number }[];
  allPacked: boolean;
  packedAt: Date | null;
};

async function orderPacks(tx: Tx, orderIds: string[]): Promise<Map<string, OrderPack>> {
  const out = new Map<string, OrderPack>();
  if (!orderIds.length) return out;
  const os = await tx.select().from(orders).where(inArray(orders.id, orderIds));
  const items = await tx
    .select({
      id: orderItems.id,
      orderId: orderItems.orderId,
      state: orderItems.state,
      changed: orderItems.stateChangedAt,
      styleCode: blankVariants.styleCode,
      weightOz: blankVariants.weightOz,
    })
    .from(orderItems)
    .leftJoin(blankVariants, eq(blankVariants.id, orderItems.blankVariantId))
    .where(inArray(orderItems.orderId, orderIds));
  for (const o of os) {
    const live = items.filter((i) => i.orderId === o.id && i.state !== "cancelled");
    const packed = live.filter((i) => i.state === "packed");
    out.set(o.id, {
      order: o,
      itemIds: live.filter((i) => i.state === "packed" || i.state === "shipped").map((i) => i.id),
      blanks: live.map((i) => ({ styleCode: i.styleCode ?? "", weightOz: i.weightOz ?? 6 })),
      allPacked: live.length > 0 && packed.length === live.length,
      packedAt: packed.length
        ? new Date(Math.max(...packed.map((i) => i.changed.getTime())))
        : null,
    });
  }
  return out;
}

async function shipTo(tx: Tx, orderId: string): Promise<Address | null> {
  const [p] = await tx.select().from(buyerPii).where(eq(buyerPii.orderId, orderId)).limit(1);
  if (!p) return null;
  return {
    name: p.name,
    company: p.company ?? null,
    street1: p.street1 ?? "",
    street2: p.street2 ?? null,
    city: p.city ?? "",
    state: p.state ?? "",
    zip: p.zip ?? "",
    country: p.country || "US",
    phone: p.phone ?? null,
    email: p.email ?? null,
  };
}

const addressValid = (a: Address | null) =>
  !!a && !!a.street1.trim() && !!a.city.trim() && /^\d{5}(-\d{4})?$/.test(a.zip.trim());

/* ---------------------------------- mapping -------------------------------- */

function toShipment(
  row: ShipmentRow,
  order: { orderNo: string; channel: Shipment["channel"]; shipBy: Date },
  address: Address | null,
): Shipment {
  return {
    id: row.id,
    orderId: row.orderId,
    orderNo: order.orderNo,
    channel: order.channel,
    status: apiStatus(row.status),
    orderItemIds: row.orderItemIds,
    carrier: row.carrier,
    service: row.service,
    trackingCode: row.trackingCode,
    trackingUrl: row.trackingUrl,
    labelKey: row.labelKey,
    labelFormat: row.labelFormat,
    postage: row.postageCents,
    labelFee: row.labelFeeCents,
    parcel: {
      lengthIn: row.lengthIn,
      widthIn: row.widthIn,
      heightIn: row.heightIn,
      weightOz: row.weightOz,
    },
    packagePresetId: row.packagePresetId,
    shipTo: address
      ? { ...address, email: address.email && /@/.test(address.email) ? address.email : null }
      : null,
    shipBy: order.shipBy.toISOString(),
    trackingPush: {
      status: row.trackingPushStatus === "pushing" ? "pending" : row.trackingPushStatus,
      pushedAt: row.trackingPushedAt?.toISOString() ?? null,
      attempts: row.trackingPushAttempts,
      error: row.trackingPushError,
    },
    labeledAt: row.labeledAt?.toISOString() ?? null,
    deliveredAt: row.deliveredAt?.toISOString() ?? null,
    voidedAt: row.voidedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function getShipment(tx: Tx, _ctx: TenantContext, id: string): Promise<Shipment> {
  const [row] = await tx
    .select({
      s: shipments,
      orderNo: orders.orderNo,
      channel: orders.channel,
      shipBy: orders.shipBy,
    })
    .from(shipments)
    .innerJoin(orders, eq(orders.id, shipments.orderId))
    .where(eq(shipments.id, id))
    .limit(1);
  if (!row) throw notFound("shipment", id);
  return toShipment(row.s, row, await shipTo(tx, row.s.orderId));
}

export type ShipmentListInput = PageInput & {
  status?: ShipmentState[] | undefined;
  channel?: Shipment["channel"] | undefined;
  orderId?: string | undefined;
  search?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
};

export async function listShipments(tx: Tx, _ctx: TenantContext, input: ShipmentListInput) {
  const page = keyset(shipments.createdAt, shipments.id, input);
  const f: (SQL | undefined)[] = [page.where];
  if (input.status?.length) {
    const wanted: ShipmentState[] = [...input.status];
    if (wanted.includes("rated")) wanted.push("buying");
    if (wanted.includes("labeled")) wanted.push("voiding");
    f.push(inArray(shipments.status, wanted));
  }
  if (input.channel) f.push(eq(orders.channel, input.channel));
  if (input.orderId) f.push(eq(shipments.orderId, input.orderId));
  if (input.search) {
    const q = `%${input.search.trim()}%`;
    f.push(or(ilike(orders.orderNo, q), ilike(shipments.trackingCode, q)));
  }
  if (input.from) f.push(gte(shipments.createdAt, new Date(input.from)));
  if (input.to) f.push(lte(shipments.createdAt, new Date(input.to)));
  const rows = await tx
    .select({
      s: shipments,
      orderNo: orders.orderNo,
      channel: orders.channel,
      shipBy: orders.shipBy,
    })
    .from(shipments)
    .innerJoin(orders, eq(orders.id, shipments.orderId))
    .where(and(...f))
    .orderBy(...page.orderBy)
    .limit(page.limit + 1);
  const pii = rows.length
    ? await tx
        .select()
        .from(buyerPii)
        .where(
          inArray(
            buyerPii.orderId,
            rows.map((r) => r.s.orderId),
          ),
        )
    : [];
  const addr = new Map(pii.map((p) => [p.orderId, p]));
  return page.result(
    rows.map((r) => ({ ...r, createdAt: r.s.createdAt, id: r.s.id })),
    (r) => {
      const p = addr.get(r.s.orderId);
      return toShipment(
        r.s,
        r,
        p
          ? {
              name: p.name,
              company: p.company ?? null,
              street1: p.street1 ?? "",
              street2: p.street2 ?? null,
              city: p.city ?? "",
              state: p.state ?? "",
              zip: p.zip ?? "",
              country: p.country || "US",
              phone: p.phone ?? null,
              email: p.email ?? null,
            }
          : null,
      );
    },
  );
}

/* ----------------------------------- queue --------------------------------- */

/** Orders whose open units are all packed and that have no live label, by ship-by. */
async function shippableOrderIds(tx: Tx, channel?: string) {
  const rows = await tx
    .select({ orderId: orderItems.orderId })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(
      and(
        channel ? eq(orders.channel, channel as Shipment["channel"]) : undefined,
        sql`not exists (select 1 from shipments s where s.order_id = ${orderItems.orderId} and s.status in ('labeled','in_transit','delivered','exception','returned','buying','voiding'))`,
      ),
    )
    .groupBy(orderItems.orderId, orders.shipBy)
    .having(
      sql`bool_and(${orderItems.state} in ('packed','cancelled')) and bool_or(${orderItems.state} = 'packed')`,
    )
    .orderBy(asc(orders.shipBy));
  return rows.map((r) => r.orderId);
}

export async function shipQueue(
  tx: Tx,
  ctx: TenantContext,
  input: PageInput & { channel?: Shipment["channel"] | undefined; atRisk?: boolean | undefined },
) {
  const settings = await settingsRow(tx, ctx);
  const presets = await presetRows(tx);
  const ids = await shippableOrderIds(tx, input.channel);
  const packs = await orderPacks(tx, ids);
  const riskBy = Date.now() + 24 * 3600_000;
  let entries = ids
    .map((id) => packs.get(id))
    .filter((p): p is OrderPack => !!p)
    .map((p) => ({ p, atRisk: p.order.shipBy.getTime() <= riskBy }));
  if (input.atRisk !== undefined) entries = entries.filter((e) => e.atRisk === input.atRisk);
  entries.sort(
    (a, b) =>
      Number(b.p.order.isRush) - Number(a.p.order.isRush) ||
      a.p.order.shipBy.getTime() - b.p.order.shipBy.getTime(),
  );
  const offset = input.cursor
    ? Number.parseInt(Buffer.from(input.cursor, "base64url").toString(), 10) || 0
    : 0;
  const page = entries.slice(offset, offset + input.limit);
  const pageIds = page.map((e) => e.p.order.id);
  const binRows = pageIds.length
    ? await tx
        .select({ code: bins.code, orderId: bins.orderId })
        .from(bins)
        .where(inArray(bins.orderId, pageIds))
    : [];
  const pii = pageIds.length
    ? await tx.select().from(buyerPii).where(inArray(buyerPii.orderId, pageIds))
    : [];
  const items: ShipQueueEntry[] = page.map(({ p, atRisk }) => {
    const units = p.itemIds.length || 1;
    const preset = choosePreset(presets, units);
    const a = pii.find((x) => x.orderId === p.order.id);
    return {
      orderId: p.order.id,
      orderNo: p.order.orderNo,
      channel: p.order.channel,
      shipBy: p.order.shipBy.toISOString(),
      isRush: p.order.isRush,
      atRisk,
      unitCount: units,
      estimatedWeightOz: parcelWeight(p.blanks, settings.weightPerStyle, preset?.tareOz ?? 0),
      suggestedPresetId: preset?.id ?? null,
      binCode: binRows.find((b) => b.orderId === p.order.id)?.code ?? null,
      packedAt: (p.packedAt ?? p.order.updatedAt).toISOString(),
      shippingMethod: p.order.shippingMethod,
      addressValid: !!a && !!a.street1?.trim() && /^\d{5}(-\d{4})?$/.test((a.zip ?? "").trim()),
    };
  });
  return {
    items,
    nextCursor:
      offset + page.length < entries.length
        ? Buffer.from(String(offset + page.length)).toString("base64url")
        : null,
    total: entries.length,
  };
}

/* ----------------------------------- rates --------------------------------- */

function markRates(rates: CarrierRate[]): RatesResult["rates"] {
  const cheapest = Math.min(...rates.map((r) => r.rateCents));
  const fastest = Math.min(...rates.map((r) => r.deliveryDays ?? 99));
  return rates
    .map((r) => ({
      rateId: r.rateId,
      carrier: r.carrier,
      service: r.service,
      serviceLabel: r.serviceLabel,
      rate: r.rateCents,
      deliveryDays: r.deliveryDays,
      estimatedDeliveryAt: r.estimatedDeliveryAt,
      cheapest: r.rateCents === cheapest,
      fastest: (r.deliveryDays ?? 99) === fastest,
    }))
    .sort((a, b) => a.rate - b.rate);
}

const orderNotPacked = () =>
  new ORPCError("ORDER_NOT_PACKED", { status: 409, message: "Every unit must be packed first" });
const addressInvalid = (detail: string) =>
  new ORPCError("ADDRESS_INVALID", {
    status: 422,
    message: "Ship-to address is not deliverable",
    data: { detail },
  });

function carrierFailure(err: unknown): never {
  if (err instanceof CarrierError) {
    if (err.code === "address_invalid") throw addressInvalid(err.message);
    if (err.code === "rate_expired") throw rateExpired();
    throw upstream(`carrier (${err.provider})`, err.message);
  }
  throw err;
}

const rateExpired = () =>
  new ORPCError("RATE_EXPIRED", { status: 409, message: "Rates expired; fetch them again" });

/**
 * Rate-shop an order: creates or reuses its open shipment and stores the quotes on it. The
 * carrier is called with no transaction open and no row locked: tx 1 checks the order and picks
 * the shipment, tx 2 stores the quotes if the shipment is still open.
 */
export async function rateOrder(ctx: TenantContext, input: RatesInput): Promise<RatesResult> {
  const plan = await withTenant(ctx.companyId, async (tx) => {
    const [order] = await tx
      .select()
      .from(orders)
      .where(eq(orders.id, input.orderId))
      .for("update");
    if (!order) throw notFound("order", input.orderId);
    const [taken] = await tx
      .select({ status: shipments.status })
      .from(shipments)
      .where(
        and(eq(shipments.orderId, order.id), inArray(shipments.status, [...BUSY, ...LIVE_LABEL])),
      )
      .limit(1);
    if (taken && BUSY.includes(taken.status))
      throw conflict(
        "A label for this order is being bought or voided right now. Try again in a minute.",
      );
    if (taken) throw conflict("This order already has a label. Void it first to buy a new one.");
    const pack = (await orderPacks(tx, [order.id])).get(order.id);
    if (!pack?.allPacked) throw orderNotPacked();
    const settings = await settingsRow(tx, ctx);
    if (!settings.fromAddress)
      throw badRequest("Set a ship-from address in shipping settings first");
    const to = await shipTo(tx, order.id);
    if (!addressValid(to))
      throw addressInvalid(
        to ? "street, city and a 5-digit ZIP are required" : "no ship-to address on the order",
      );

    const presets = await presetRows(tx);
    const preset = input.packagePresetId
      ? presets.find((p) => p.id === input.packagePresetId)
      : choosePreset(presets, pack.itemIds.length);
    if (input.packagePresetId && !preset) throw notFound("package preset", input.packagePresetId);
    const parcel: Parcel = {
      lengthIn: input.parcel?.lengthIn ?? preset?.lengthIn ?? 10,
      widthIn: input.parcel?.widthIn ?? preset?.widthIn ?? 13,
      heightIn: input.parcel?.heightIn ?? preset?.heightIn ?? 1,
      weightOz:
        input.parcel?.weightOz ??
        parcelWeight(pack.blanks, settings.weightPerStyle, preset?.tareOz ?? 0),
    };

    let [shipment] = await tx
      .select()
      .from(shipments)
      .where(and(eq(shipments.orderId, order.id), inArray(shipments.status, ["pending", "rated"])))
      .orderBy(desc(shipments.createdAt))
      .limit(1);
    if (!shipment) {
      [shipment] = await tx
        .insert(shipments)
        .values({
          companyId: ctx.companyId,
          orderId: order.id,
          orderItemIds: pack.itemIds,
          status: "pending",
        })
        .returning();
    }
    if (!shipment) throw new Error("shipment insert failed");
    return {
      shipmentId: shipment.id,
      itemIds: pack.itemIds,
      presetId: preset?.id ?? null,
      parcel,
      from: settings.fromAddress,
      to: to as Address,
      allowedCarriers: settings.allowedCarriers,
    };
  });

  // No transaction and no row lock while the carrier is called.
  let quote: Awaited<ReturnType<ReturnType<typeof carrierAdapter>["rate"]>>;
  try {
    quote = await carrierAdapter().rate({
      companyId: ctx.companyId,
      shipmentId: plan.shipmentId,
      from: plan.from,
      to: plan.to,
      parcel: plan.parcel,
    });
  } catch (err) {
    carrierFailure(err);
  }
  const allowed = new Set(plan.allowedCarriers);
  const rates = quote.rates.filter((r) => allowed.has(r.carrier));
  if (!rates.length) throw upstream("carrier", "no rates for the allowed carriers");
  const ratedAt = new Date();
  await withTenant(ctx.companyId, async (tx) => {
    const [s] = await tx
      .select({ status: shipments.status })
      .from(shipments)
      .where(eq(shipments.id, plan.shipmentId))
      .for("update");
    // A buy started meanwhile: its carrier shipment and quotes must stay as they are.
    if (!s || (s.status !== "pending" && s.status !== "rated"))
      throw conflict("The shipment changed while rates were fetched. Fetch rates again.");
    await tx
      .update(shipments)
      .set({
        status: "rated",
        orderItemIds: plan.itemIds,
        packagePresetId: plan.presetId,
        lengthIn: plan.parcel.lengthIn,
        widthIn: plan.parcel.widthIn,
        heightIn: plan.parcel.heightIn,
        weightOz: plan.parcel.weightOz,
        rateQuotes: rates.map((r) => ({
          rateId: r.rateId,
          carrier: r.carrier,
          service: r.service,
          serviceLabel: r.serviceLabel,
          rate: r.rateCents,
          deliveryDays: r.deliveryDays,
          estimatedDeliveryAt: r.estimatedDeliveryAt,
        })),
        ratedAt,
        carrierShipmentId: quote.carrierShipmentId,
      })
      .where(eq(shipments.id, plan.shipmentId));
  });
  return {
    shipmentId: plan.shipmentId,
    parcel: plan.parcel,
    rates: markRates(rates),
    ratedAt: ratedAt.toISOString(),
  };
}

/* ------------------------------------ buy ---------------------------------- */

/** Channels with no API to push tracking to. */
const NO_PUSH_CHANNELS = new Set(["csv"]);

/** A `buying` shipment whose carrier call started this recently may still be in flight. */
export const BUY_IN_FLIGHT_MS = 2 * 60_000;

type BuyPlan =
  | { kind: "done" }
  | { kind: "call"; resume: boolean; expired: boolean; quote: RateQuote; req: BuyRequest };

/** Ends a buy that bought nothing (`not_done`, back to `rated`) or whose outcome is unknown. */
async function settleBuy(ctx: TenantContext, shipmentId: string, outcome: "not_done" | "unknown") {
  await withTenant(ctx.companyId, (tx) =>
    tx
      .update(shipments)
      .set(
        outcome === "unknown"
          ? { buyAttemptedAt: null }
          : { status: "rated", buyAttemptedAt: null },
      )
      .where(and(eq(shipments.id, shipmentId), eq(shipments.status, "buying"))),
  );
}

/**
 * Buy the chosen rate, never twice (research 10 R8). Tx 1 records the intent on the shipment
 * (`buying`, the rate, the attempt time) and commits. The carrier buys with no transaction open,
 * on the carrier shipment created at rating (our shipment id is its reference). Tx 2 records the
 * label. A retry of a `buying` shipment reads the carrier back before buying again, and a
 * repeat on a bought shipment returns it. Tracking push is queued via `shipment.labeled`.
 */
export async function buyLabel(
  ctx: TenantContext,
  input: { shipmentId: string; rateId: string },
  /** `readBackOnly`: finish a pending buy from the carrier's records, never buy (cancel job). */
  opts: { readBackOnly?: boolean } = {},
): Promise<Shipment> {
  const plan = await withTenant(ctx.companyId, async (tx): Promise<BuyPlan> => {
    const [s] = await tx
      .select()
      .from(shipments)
      .where(eq(shipments.id, input.shipmentId))
      .for("update");
    if (!s) throw notFound("shipment", input.shipmentId);
    if (LIVE_LABEL.includes(s.status)) return { kind: "done" };
    if (s.status === "voided" || s.status === "voiding")
      throw conflict("Shipment was voided; rate the order again");
    const resume = s.status === "buying";
    if (opts.readBackOnly && !resume) return { kind: "done" };
    if (resume) {
      if (s.selectedRateId !== input.rateId)
        throw conflict(
          "A label for a different rate is already being bought for this order. Buy that rate again to finish it.",
        );
      const since = s.buyAttemptedAt ? Date.now() - s.buyAttemptedAt.getTime() : null;
      if (since !== null && since < BUY_IN_FLIGHT_MS)
        throw conflict("This label is being bought right now. Check again in a minute.");
    }
    // A new purchase needs a paid plan (or a live trial). Finishing one already made doesn't.
    if (!resume) await assertPaidActionAllowed(tx, ctx);
    const quote = s.rateQuotes.find((q) => q.rateId === input.rateId);
    if (!quote || !s.ratedAt || !s.carrierShipmentId) throw rateExpired();
    const expired = Date.now() - s.ratedAt.getTime() > RATE_TTL_MS;
    if (expired && !resume) throw rateExpired();
    const [order] = await tx.select().from(orders).where(eq(orders.id, s.orderId)).limit(1);
    if (!order) throw notFound("order", s.orderId);
    if (!resume) {
      const pack = (await orderPacks(tx, [order.id])).get(order.id);
      if (!pack?.allPacked) throw orderNotPacked();
    }
    const settings = await settingsRow(tx, ctx);
    const to = await shipTo(tx, order.id);
    if (!settings.fromAddress || !to || !addressValid(to))
      throw addressInvalid("ship-to address incomplete");
    await tx
      .update(shipments)
      .set({ status: "buying", selectedRateId: quote.rateId, buyAttemptedAt: new Date() })
      .where(eq(shipments.id, s.id));
    return {
      kind: "call",
      resume,
      expired,
      quote,
      req: {
        companyId: ctx.companyId,
        shipmentId: s.id,
        carrierShipmentId: s.carrierShipmentId,
        from: settings.fromAddress,
        to,
        parcel: {
          lengthIn: s.lengthIn,
          widthIn: s.widthIn,
          heightIn: s.heightIn,
          weightOz: s.weightOz,
        },
        rate: {
          rateId: quote.rateId,
          carrier: quote.carrier,
          service: quote.service,
          serviceLabel: quote.serviceLabel,
          rateCents: quote.rate,
          deliveryDays: quote.deliveryDays,
          estimatedDeliveryAt: quote.estimatedDeliveryAt,
        },
      },
    };
  });
  if (plan.kind === "done")
    return withTenant(ctx.companyId, (tx) => getShipment(tx, ctx, input.shipmentId));

  // No transaction and no row lock while the carrier is called.
  const adapter = carrierAdapter();
  let label: PurchasedLabel;
  try {
    const found = plan.resume
      ? (
          await adapter.lookup({
            companyId: ctx.companyId,
            shipmentId: input.shipmentId,
            carrierShipmentId: plan.req.carrierShipmentId,
          })
        ).label
      : null;
    if (!found && (plan.expired || opts.readBackOnly)) {
      await settleBuy(ctx, input.shipmentId, "not_done");
      if (opts.readBackOnly)
        return withTenant(ctx.companyId, (tx) => getShipment(tx, ctx, input.shipmentId));
      throw rateExpired();
    }
    label = found ?? (await adapter.buy(plan.req));
  } catch (err) {
    if (err instanceof ORPCError) throw err;
    const unknown = !(err instanceof CarrierError) || err.outcome === "unknown";
    // Not bought: back to rated. Unknown: stay `buying` with no call in flight, so the next
    // buy reads the carrier back before buying.
    await settleBuy(ctx, input.shipmentId, unknown ? "unknown" : "not_done");
    const detail = err instanceof Error ? err.message : String(err);
    log.warn("label buy failed", { shipmentId: input.shipmentId, unknown, detail });
    if (unknown)
      throw new ORPCError("UPSTREAM_FAILED", {
        status: 502,
        message:
          "We couldn't confirm the label with the carrier. Buy again to check; you won't be charged twice.",
        data: { service: "carrier", detail },
      });
    carrierFailure(err);
  }

  try {
    return await withTenant(ctx.companyId, async (tx) => {
      const [s] = await tx
        .select()
        .from(shipments)
        .where(eq(shipments.id, input.shipmentId))
        .for("update");
      if (s?.status === "buying") await recordLabel(tx, ctx, s, plan.quote, label);
      return getShipment(tx, ctx, input.shipmentId);
    });
  } catch (err) {
    // The carrier sold the label but we couldn't record it: clear the in-flight mark so the next
    // buy reads it back instead of waiting out BUY_IN_FLIGHT_MS.
    log.error("carrier sold the label but saving it failed", {
      shipmentId: input.shipmentId,
      carrierLabelId: label.carrierLabelId,
      error: err instanceof Error ? err.message : String(err),
    });
    await withTenant(ctx.companyId, (tx) =>
      tx
        .update(shipments)
        .set({ buyAttemptedAt: null })
        .where(and(eq(shipments.id, input.shipmentId), eq(shipments.status, "buying"))),
    ).catch(() => {});
    throw err;
  }
}

/** Tx 2 of a buy: the label row, the labeled shipment, its items, audit and events. */
async function recordLabel(
  tx: Tx,
  ctx: TenantContext,
  s: ShipmentRow,
  quote: RateQuote,
  label: PurchasedLabel,
) {
  const [order] = await tx.select().from(orders).where(eq(orders.id, s.orderId)).limit(1);
  if (!order) throw notFound("order", s.orderId);
  const pack = (await orderPacks(tx, [order.id])).get(order.id);
  const itemIds = pack?.itemIds ?? s.orderItemIds;
  const settings = await settingsRow(tx, ctx);
  // A unit of this package was cancelled while the label was being bought: never push it, the
  // `order.cancelled` job voids it.
  const cancelled = s.orderItemIds.length
    ? await tx
        .select({ id: orderItems.id })
        .from(orderItems)
        .where(and(inArray(orderItems.id, s.orderItemIds), eq(orderItems.state, "cancelled")))
    : [];
  const needsPush =
    settings.trackingPushEnabled && !NO_PUSH_CHANNELS.has(order.channel) && !cancelled.length;
  const now = new Date();
  await tx
    .insert(labels)
    .values({
      companyId: ctx.companyId,
      shipmentId: s.id,
      carrier: quote.carrier,
      service: quote.service,
      trackingCode: label.trackingCode,
      labelKey: label.labelKey,
      format: "pdf",
      postageCents: label.postageCents,
      labelFeeCents: LABEL_FEE_CENTS,
      carrierLabelId: label.carrierLabelId,
    })
    .onConflictDoNothing();
  await tx
    .update(shipments)
    .set({
      status: "labeled",
      buyAttemptedAt: null,
      carrier: quote.carrier,
      service: quote.service,
      trackingCode: label.trackingCode,
      trackingUrl: label.trackingUrl,
      trackingStatus: "pre_transit",
      labelKey: label.labelKey,
      labelFormat: "pdf",
      postageCents: label.postageCents,
      labelFeeCents: LABEL_FEE_CENTS,
      selectedRateId: quote.rateId,
      carrierLabelId: label.carrierLabelId,
      orderItemIds: itemIds,
      trackingPushStatus: needsPush ? "pending" : "not_required",
      trackingPushAttempts: 0,
      trackingPushError: cancelled.length ? "Cancelled: the label is being voided" : null,
      labeledAt: now,
      voidedAt: null,
    })
    .where(eq(shipments.id, s.id));
  if (itemIds.length)
    await tx.update(orderItems).set({ shipmentId: s.id }).where(inArray(orderItems.id, itemIds));
  await audit(tx, {
    companyId: ctx.companyId,
    actor: ctx.actor,
    action: "label.purchased",
    entityType: "shipment",
    entityId: s.id,
    summary: `${quote.serviceLabel} ${label.trackingCode} for ${order.orderNo} ($${(label.postageCents / 100).toFixed(2)})`,
  });
  await emit(tx, ctx.companyId, "shipment.status_changed", {
    shipmentId: s.id,
    from: "rated",
    to: "labeled",
  });
  await emit(tx, ctx.companyId, "shipment.labeled", {
    shipmentId: s.id,
    orderId: order.id,
    trackingCode: label.trackingCode,
    carrier: quote.carrier,
  });
  // Units stay packed until tracking is pushed or the carrier scans the package (R11).
  afterCommit(tx, () =>
    publish(ctx.companyId, {
      type: "shipment.updated",
      data: { shipmentId: s.id, orderId: order.id, status: "labeled" },
    }).then(() => undefined),
  );
}

async function shipItems(tx: Tx, actor: Actor, itemIds: string[], reason: string) {
  const rows = itemIds.length
    ? await tx
        .select({ id: orderItems.id, state: orderItems.state })
        .from(orderItems)
        .where(inArray(orderItems.id, itemIds))
    : [];
  for (const r of rows)
    if (r.state === "packed") await transitionItem(tx, r.id, "shipped", { actor, reason });
}

/* --------------------------------- batch buy ------------------------------- */

/** Pick a rate: cheapest, fastest, or the cheapest that still arrives within 3 days of ship-by. */
export function pickRate(
  rates: RatesResult["rates"],
  strategy: Strategy,
  shipBy: Date,
  now = new Date(),
): RatesResult["rates"][number] | null {
  if (!rates.length) return null;
  const byPrice = [...rates].sort(
    (a, b) => a.rate - b.rate || (a.deliveryDays ?? 99) - (b.deliveryDays ?? 99),
  );
  const byDays = [...rates].sort(
    (a, b) => (a.deliveryDays ?? 99) - (b.deliveryDays ?? 99) || a.rate - b.rate,
  );
  if (strategy === "cheapest") return byPrice[0] ?? null;
  if (strategy === "fastest") return byDays[0] ?? null;
  const deliverBy = Math.max(shipBy.getTime(), now.getTime()) + 3 * 86400_000;
  const onTime = byPrice.filter(
    (r) => now.getTime() + (r.deliveryDays ?? 99) * 86400_000 <= deliverBy,
  );
  return onTime[0] ?? byDays[0] ?? null;
}

export async function batchBuy(
  ctx: TenantContext,
  input: {
    orderIds: string[];
    strategy?: Strategy | undefined;
    packagePresetId?: string | undefined;
  },
): Promise<BatchBuyResult> {
  const { job, strategy } = await withTenant(ctx.companyId, async (tx) => {
    await assertPaidActionAllowed(tx, ctx);
    const settings = await settingsRow(tx, ctx);
    const job = await createJobRow(tx, ctx, "batch_labels", { orderIds: input.orderIds });
    return { job, strategy: input.strategy ?? settings.defaultStrategy };
  });
  await updateJobRow(ctx.companyId, job.id, {
    status: "running",
    progress: 0,
    message: `Buying ${input.orderIds.length} labels`,
  });
  const results: BatchBuyResult["results"] = [];
  let totalPostage = 0;
  for (const [i, orderId] of input.orderIds.entries()) {
    try {
      const live = await withTenant(ctx.companyId, async (tx) => {
        const [row] = await tx
          .select({ id: shipments.id })
          .from(shipments)
          .where(and(eq(shipments.orderId, orderId), inArray(shipments.status, LIVE_LABEL)))
          .limit(1);
        const [order] = await tx
          .select({ shipBy: orders.shipBy })
          .from(orders)
          .where(eq(orders.id, orderId));
        if (!order) throw notFound("order", orderId);
        return { id: row?.id ?? null, shipBy: order.shipBy };
      });
      // Rate and buy each run their own short transactions around the carrier calls.
      const shipment = live.id
        ? { skipped: true as const, id: live.id }
        : await (async () => {
            const quote = await rateOrder(ctx, {
              orderId,
              packagePresetId: input.packagePresetId,
            });
            const rate = pickRate(quote.rates, strategy, live.shipBy);
            if (!rate) throw upstream("carrier", "no rate");
            return {
              skipped: false as const,
              shipment: await buyLabel(ctx, { shipmentId: quote.shipmentId, rateId: rate.rateId }),
            };
          })();
      if (shipment.skipped) {
        results.push({
          orderId,
          shipmentId: shipment.id,
          status: "skipped",
          error: "already labeled",
        });
      } else {
        totalPostage += shipment.shipment.postage;
        results.push({ orderId, shipmentId: shipment.shipment.id, status: "labeled", error: null });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ orderId, shipmentId: null, status: "failed", error: message });
    }
    if (i % 5 === 4 || i === input.orderIds.length - 1)
      await updateJobRow(ctx.companyId, job.id, { progress: (i + 1) / input.orderIds.length });
  }
  const labeled = results.filter((r) => r.status === "labeled").length;
  const failed = results.filter((r) => r.status === "failed").length;
  await updateJobRow(ctx.companyId, job.id, {
    status: "done",
    progress: 1,
    message: `${labeled} labeled, ${failed} failed`,
    resultIds: results.map((r) => r.shipmentId).filter((x): x is string => !!x),
  });
  return { jobId: job.id, results, labeled, failed, totalPostage };
}

/* ------------------------------- label PDFs -------------------------------- */

/** One PDF of every label, in pack (bin) order, ship-by or creation order. */
export async function batchLabelPdf(
  tx: Tx,
  ctx: TenantContext,
  input: { shipmentIds: string[]; order: "bin" | "shipBy" | "created" },
) {
  const rows = await tx
    .select({
      id: shipments.id,
      labelKey: shipments.labelKey,
      status: shipments.status,
      createdAt: shipments.createdAt,
      shipBy: orders.shipBy,
      orderNo: orders.orderNo,
      bin: sql<
        string | null
      >`(select b.code from bins b where b.order_id = ${shipments.orderId} limit 1)`,
    })
    .from(shipments)
    .innerJoin(orders, eq(orders.id, shipments.orderId))
    .where(inArray(shipments.id, input.shipmentIds));
  const usable = rows.filter((r) => r.labelKey && r.status !== "voided");
  if (!usable.length) throw badRequest("None of these shipments has a label");
  usable.sort((a, b) => {
    if (input.order === "bin")
      return (
        (a.bin ?? "￿").localeCompare(b.bin ?? "￿", undefined, { numeric: true }) ||
        a.orderNo.localeCompare(b.orderNo)
      );
    if (input.order === "shipBy") return a.shipBy.getTime() - b.shipBy.getTime();
    return a.createdAt.getTime() - b.createdAt.getTime();
  });
  const merged = await PDFDocument.create();
  for (const r of usable) {
    try {
      const src = await PDFDocument.load(await getObject(r.labelKey as string));
      const pages = await merged.copyPages(src, src.getPageIndices());
      for (const p of pages) merged.addPage(p);
    } catch (err) {
      log.warn("label pdf unreadable, skipped", { shipmentId: r.id, error: String(err) });
    }
  }
  const pages = merged.getPageCount();
  if (!pages) throw badRequest("No readable label PDFs");
  const key = objectKey(ctx.companyId, "label", "pdf");
  await putObject(key, await merged.save(), "application/pdf");
  const ttl = 3600;
  return {
    fileKey: key,
    url: await presignGet(key, ttl),
    pages,
    expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
  };
}

/* ----------------------------------- void ---------------------------------- */

/** A `voiding` shipment whose refund call started this recently may still be in flight. */
export const VOID_IN_FLIGHT_MS = 2 * 60_000;

const voidRejected = (detail: string) =>
  new ORPCError("VOID_REJECTED", {
    status: 409,
    message: "Carrier refused the void",
    data: { detail },
  });

type VoidPlan =
  | { kind: "done" }
  | {
      kind: "call";
      resume: boolean;
      carrierShipmentId: string | null;
      trackingCode: string | null;
    };

/**
 * Void a label (refund through the carrier), once. Works until the package ships: while its
 * units are packed and no tracking was sent to the channel. Tx 1 records the intent
 * (`voiding`), the carrier refund runs with no transaction open, and tx 2 records the void. A
 * retry of a `voiding` shipment reads the carrier back first. A shipment being voided is never
 * pushed.
 */
export async function voidShipment(
  ctx: TenantContext,
  input: { id: string; reason?: string | undefined },
): Promise<Shipment> {
  const plan = await withTenant(ctx.companyId, async (tx): Promise<VoidPlan> => {
    const [s] = await tx.select().from(shipments).where(eq(shipments.id, input.id)).for("update");
    if (!s) throw notFound("shipment", input.id);
    if (s.status === "voided") return { kind: "done" };
    const resume = s.status === "voiding";
    if (resume) {
      const since = s.voidAttemptedAt ? Date.now() - s.voidAttemptedAt.getTime() : null;
      if (since !== null && since < VOID_IN_FLIGHT_MS)
        throw conflict("This label is being voided right now. Check again in a minute.");
    } else {
      if (s.status === "buying")
        throw conflict("A label is being bought for this order right now. Try again in a minute.");
      if (s.status !== "labeled")
        throw voidRejected(`a ${apiStatus(s.status)} shipment can't be voided`);
      if (s.trackingPushStatus === "pushed")
        throw voidRejected("tracking was already sent to the channel");
      if (s.trackingPushStatus === "pushing")
        throw conflict("Tracking is being sent to the channel right now. Try again in a minute.");
      const shipped = s.orderItemIds.length
        ? await tx
            .select({ id: orderItems.id })
            .from(orderItems)
            .where(
              and(
                inArray(orderItems.id, s.orderItemIds),
                inArray(orderItems.state, ["shipped", "delivered"]),
              ),
            )
        : [];
      if (shipped.length) throw voidRejected("the package already shipped");
    }
    await tx
      .update(shipments)
      .set({ status: "voiding", voidAttemptedAt: new Date() })
      .where(eq(shipments.id, s.id));
    return {
      kind: "call",
      resume,
      carrierShipmentId: s.carrierShipmentId,
      trackingCode: s.trackingCode,
    };
  });
  if (plan.kind === "done")
    return withTenant(ctx.companyId, (tx) => getShipment(tx, ctx, input.id));

  // Back to labeled when nothing was refunded; unknown stays `voiding` for a read-back.
  const settle = (outcome: "not_done" | "unknown") =>
    withTenant(ctx.companyId, (tx) =>
      tx
        .update(shipments)
        .set(
          outcome === "unknown"
            ? { voidAttemptedAt: null }
            : { status: "labeled", voidAttemptedAt: null },
        )
        .where(and(eq(shipments.id, input.id), eq(shipments.status, "voiding"))),
    );

  // No transaction and no row lock while the carrier is called.
  let pending = false;
  if (plan.carrierShipmentId && plan.trackingCode) {
    const adapter = carrierAdapter();
    let res: VoidResult;
    try {
      const back = plan.resume
        ? await adapter.lookup({
            companyId: ctx.companyId,
            shipmentId: input.id,
            carrierShipmentId: plan.carrierShipmentId,
          })
        : null;
      const asked = back?.refundStatus;
      res =
        asked && asked !== "rejected" && asked !== "not_applicable"
          ? { ok: true, pending: asked !== "refunded" }
          : await adapter.void({
              companyId: ctx.companyId,
              carrierShipmentId: plan.carrierShipmentId,
              trackingCode: plan.trackingCode,
            });
    } catch (err) {
      const unknown = !(err instanceof CarrierError) || err.outcome === "unknown";
      await settle(unknown ? "unknown" : "not_done");
      const detail = err instanceof Error ? err.message : String(err);
      log.warn("label void failed", { shipmentId: input.id, unknown, detail });
      if (unknown)
        throw new ORPCError("UPSTREAM_FAILED", {
          status: 502,
          message: "We couldn't confirm the void with the carrier. Void again to check.",
          data: { service: "carrier", detail },
        });
      throw voidRejected(detail);
    }
    if (!res.ok) {
      await settle("not_done");
      throw voidRejected(res.detail);
    }
    pending = res.pending;
  }

  return withTenant(ctx.companyId, async (tx) => {
    const [s] = await tx.select().from(shipments).where(eq(shipments.id, input.id)).for("update");
    if (s?.status === "voiding") await recordVoid(tx, ctx, s, pending, input.reason);
    return getShipment(tx, ctx, input.id);
  });
}

async function recordVoid(
  tx: Tx,
  ctx: TenantContext,
  s: ShipmentRow,
  pending: boolean,
  reason: string | undefined,
) {
  const now = new Date();
  await tx
    .update(labels)
    .set({ status: pending ? "refund_pending" : "voided", voidedAt: now })
    .where(and(eq(labels.shipmentId, s.id), eq(labels.status, "purchased")));
  await tx
    .update(shipments)
    .set({
      status: "voided",
      voidedAt: now,
      voidAttemptedAt: null,
      trackingPushStatus: "not_required",
      trackingCode: null,
    })
    .where(eq(shipments.id, s.id));
  await tx.update(orderItems).set({ shipmentId: null }).where(eq(orderItems.shipmentId, s.id));
  await audit(tx, {
    companyId: ctx.companyId,
    actor: ctx.actor,
    action: "label.voided",
    entityType: "shipment",
    entityId: s.id,
    summary: `Label ${s.trackingCode} voided${pending ? " (refund pending)" : ""}${reason ? `: ${reason}` : ""}`,
  });
  await emit(tx, ctx.companyId, "shipment.status_changed", {
    shipmentId: s.id,
    from: "labeled",
    to: "voided",
  });
  await emit(tx, ctx.companyId, "shipment.voided", { shipmentId: s.id, orderId: s.orderId });
  afterCommit(tx, () =>
    publish(ctx.companyId, {
      type: "shipment.updated",
      data: { shipmentId: s.id, orderId: s.orderId, status: "voided" },
    }).then(() => undefined),
  );
}

/* ------------------------- cancel and hold after a label --------------------- */

/**
 * Called by orders inside a cancel or hold transaction, before the units move. Locks the
 * shipments that carry these units, so a tracking push can't start in between:
 *   - cancel: refused when tracking was already sent or is being sent (a channel cancel is not
 *     refused, the channel already cancelled). Otherwise the push is blocked and a quote is
 *     dropped; the `order.cancelled` job voids the label outside the transaction.
 *   - hold: refused while a push is in flight. The push checks holds when it runs and waits for
 *     the release (`order.released` job).
 */
export async function guardShipmentsForItems(
  tx: Tx,
  _ctx: TenantContext,
  itemIds: string[],
  action: "cancel" | "channel_cancel" | "hold",
) {
  if (!itemIds.length) return;
  const rows = await tx
    .select()
    .from(shipments)
    .where(
      and(
        sql`${shipments.orderItemIds} && ${sql`array[${sql.join(
          itemIds.map((id) => sql`${id}`),
          sql`, `,
        )}]::uuid[]`}`,
        inArray(shipments.status, ["pending", "rated", "buying", "labeled", "voiding"]),
      ),
    )
    .for("update");
  for (const s of rows) {
    const sending = s.trackingPushStatus === "pushing" || s.trackingPushStatus === "pushed";
    if (action === "hold") {
      if (s.trackingPushStatus === "pushing")
        throw conflict(
          "Tracking for this package is being sent to the channel right now. Try again in a minute.",
        );
      if (s.status === "labeled" && s.trackingPushStatus === "pending")
        await tx
          .update(shipments)
          .set({ trackingPushError: "On hold: tracking is sent when the hold is released" })
          .where(eq(shipments.id, s.id));
      continue;
    }
    if (action === "cancel" && sending && s.status === "labeled")
      throw conflict(
        s.trackingPushStatus === "pushed"
          ? "Tracking for this package was already sent to the channel, so it can't be cancelled here. Cancel or refund it on the channel."
          : "Tracking for this package is being sent to the channel right now. Try again in a minute.",
      );
    if (s.status === "pending" || s.status === "rated") {
      // The package changed: its quotes are stale.
      await tx
        .update(shipments)
        .set({ status: "pending", rateQuotes: [], ratedAt: null })
        .where(eq(shipments.id, s.id));
    } else if (s.status === "labeled" && !sending) {
      await tx
        .update(shipments)
        .set({
          trackingPushStatus: "not_required",
          trackingPushError: "Cancelled: the label is being voided",
        })
        .where(eq(shipments.id, s.id));
    }
  }
}

/**
 * The `order.cancelled` job: void every label of the order that hasn't shipped. A buy still in
 * flight is waited for ("retry"); a buy whose outcome is unknown is read back (never bought
 * again) and voided if the carrier sold it.
 */
export async function voidCancelledLabels(
  ctx: TenantContext,
  orderId: string,
): Promise<{ voided: number; failed: number; retry: boolean }> {
  const rows = await withTenant(ctx.companyId, (tx) =>
    tx
      .select()
      .from(shipments)
      .where(
        and(
          eq(shipments.orderId, orderId),
          inArray(shipments.status, ["buying", "labeled", "voiding"]),
        ),
      ),
  );
  const out = { voided: 0, failed: 0, retry: false };
  for (const s of rows) {
    try {
      if (s.status === "buying") {
        const since = s.buyAttemptedAt ? Date.now() - s.buyAttemptedAt.getTime() : null;
        if (since !== null && since < BUY_IN_FLIGHT_MS) {
          out.retry = true;
          continue;
        }
        const resolved = await buyLabel(
          ctx,
          { shipmentId: s.id, rateId: s.selectedRateId ?? "" },
          { readBackOnly: true },
        );
        if (resolved.status !== "labeled") continue;
      }
      await voidShipment(ctx, { id: s.id, reason: "order cancelled" });
      out.voided += 1;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "CONFLICT" || code === "UPSTREAM_FAILED") {
        out.retry = true;
        continue;
      }
      out.failed += 1;
      const detail = err instanceof Error ? err.message : String(err);
      log.warn("label of a cancelled order not voided", { shipmentId: s.id, detail });
      await withTenant(ctx.companyId, (tx) =>
        audit(tx, {
          companyId: ctx.companyId,
          actor: ctx.actor,
          action: "label.void_failed",
          entityType: "shipment",
          entityId: s.id,
          summary: `The order was cancelled but its label couldn't be voided: ${detail}`,
        }),
      );
    }
  }
  return out;
}

/** The `order.released` job: push the tracking a hold was holding back. */
export async function pushReleasedShipments(ctx: TenantContext, orderId: string) {
  const rows = await withTenant(ctx.companyId, (tx) =>
    tx
      .select({ id: shipments.id })
      .from(shipments)
      .where(
        and(
          eq(shipments.orderId, orderId),
          inArray(shipments.status, LIVE_LABEL),
          inArray(shipments.trackingPushStatus, ["pending", "pushing"]),
        ),
      ),
  );
  const outcomes = [];
  for (const r of rows) outcomes.push(await pushTracking(ctx.companyId, ctx, r.id));
  return outcomes;
}

/* ------------------------------- tracking push ------------------------------ */

export const PUSH_MAX_ATTEMPTS = 5;
/** A `pushing` shipment whose channel call started this recently may still be in flight. */
export const PUSH_IN_FLIGHT_MS = 60_000;

export type PushOutcome = "pushed" | "skipped" | "held" | "busy" | "retry" | "failed";

/**
 * Push one shipment's tracking to its channel, once per shipment and tracking code. Tx 1 checks
 * the units at push time (cancelled units are left out, a held unit waits for its release) and
 * records the intent (`pushing`); the channel is called with no transaction open; tx 2 records
 * the result. Items move packed -> shipped only on a real push; for channels with no push
 * (CSV-only, manual upload, push off) they ship on the carrier's first scan (`markInTransit`).
 * "busy" and "retry" mean the caller should try again later.
 */
export async function pushTracking(
  companyId: string,
  ctx: TenantContext,
  shipmentId: string,
): Promise<PushOutcome> {
  const plan = await withTenant(companyId, async (tx) => {
    const [s] = await tx.select().from(shipments).where(eq(shipments.id, shipmentId)).for("update");
    if (s && BUSY.includes(s.status)) return { kind: "busy" as const };
    if (!s?.trackingCode || !LIVE_LABEL.includes(s.status)) return { kind: "skipped" as const };
    if (s.trackingPushStatus === "pushed" || s.trackingPushStatus === "not_required")
      return { kind: "skipped" as const };
    if (
      s.trackingPushStatus === "pushing" &&
      s.pushAttemptedAt &&
      Date.now() - s.pushAttemptedAt.getTime() < PUSH_IN_FLIGHT_MS
    )
      return { kind: "busy" as const };
    const items = s.orderItemIds.length
      ? await tx
          .select({ id: orderItems.id, state: orderItems.state })
          .from(orderItems)
          .where(inArray(orderItems.id, s.orderItemIds))
      : [];
    const live = items.filter((i) => i.state !== "cancelled");
    if (!live.length) {
      await tx
        .update(shipments)
        .set({
          trackingPushStatus: "not_required",
          pushAttemptedAt: null,
          trackingPushError: "Every unit was cancelled",
        })
        .where(eq(shipments.id, s.id));
      return { kind: "skipped" as const };
    }
    if (live.some((i) => i.state === "on_hold")) {
      await tx
        .update(shipments)
        .set({
          trackingPushStatus: "pending",
          pushAttemptedAt: null,
          trackingPushError: "On hold: tracking is sent when the hold is released",
        })
        .where(eq(shipments.id, s.id));
      return { kind: "held" as const };
    }
    await tx
      .update(shipments)
      .set({ trackingPushStatus: "pushing", pushAttemptedAt: new Date() })
      .where(eq(shipments.id, s.id));
    return { kind: "push" as const, itemIds: live.map((i) => i.id) };
  });
  if (plan.kind !== "push") return plan.kind;

  // No transaction and no row lock while the channel is called.
  let res: Awaited<ReturnType<typeof pushTrackingForShipment>>;
  try {
    res = await pushTrackingForShipment(ctx, shipmentId, plan.itemIds);
  } catch (err) {
    return recordPushFailure(companyId, shipmentId, err);
  }

  try {
    return await withTenant(companyId, async (tx) => {
      const [s] = await tx
        .select()
        .from(shipments)
        .where(eq(shipments.id, shipmentId))
        .for("update");
      if (s?.trackingPushStatus !== "pushing") return "skipped" as const;
      const pushed = res.status === "pushed";
      await tx
        .update(shipments)
        .set({
          trackingPushStatus: pushed ? "pushed" : "not_required",
          trackingPushedAt: pushed ? new Date() : null,
          pushAttemptedAt: null,
          trackingPushAttempts: s.trackingPushAttempts + 1,
          trackingPushError:
            res.status === "manual"
              ? (res.message ?? "Upload tracking on the channel by hand")
              : res.status === "not_required"
                ? res.message
                : null,
        })
        .where(eq(shipments.id, s.id));
      if (pushed) {
        await emit(tx, companyId, "tracking.pushed", {
          shipmentId: s.id,
          connectionId: res.connectionId,
        });
        await shipItems(tx, ctx.actor, plan.itemIds, "tracking pushed");
      }
      afterCommit(tx, () =>
        publish(companyId, {
          type: "shipment.updated",
          data: { shipmentId: s.id, orderId: s.orderId, status: apiStatus(s.status) },
        }).then(() => undefined),
      );
      return pushed ? ("pushed" as const) : ("skipped" as const);
    });
  } catch (err) {
    // The channel has the tracking but we couldn't record it: clear the in-flight mark so the
    // next attempt goes again at once (the channel call is safe to repeat, see above).
    log.error("tracking pushed but saving it failed", {
      shipmentId,
      error: err instanceof Error ? err.message : String(err),
    });
    await withTenant(companyId, (tx) =>
      tx
        .update(shipments)
        .set({ pushAttemptedAt: null })
        .where(and(eq(shipments.id, shipmentId), eq(shipments.trackingPushStatus, "pushing"))),
    ).catch(() => {});
    return "retry";
  }
}

async function recordPushFailure(
  companyId: string,
  shipmentId: string,
  err: unknown,
): Promise<PushOutcome> {
  const error = err instanceof Error ? err.message : String(err);
  return withTenant(companyId, async (tx) => {
    const [s] = await tx.select().from(shipments).where(eq(shipments.id, shipmentId)).for("update");
    if (!s) return "failed" as const;
    const attempts = s.trackingPushAttempts + 1;
    const final = attempts >= PUSH_MAX_ATTEMPTS;
    await tx
      .update(shipments)
      .set({
        trackingPushAttempts: attempts,
        trackingPushError: error,
        trackingPushStatus: final ? "failed" : "pending",
        pushAttemptedAt: null,
      })
      .where(eq(shipments.id, s.id));
    const [o] = await tx
      .select({ connectionId: orders.connectionId })
      .from(orders)
      .where(eq(orders.id, s.orderId));
    if (final && o)
      await emit(tx, companyId, "tracking.push_failed", {
        shipmentId: s.id,
        connectionId: o.connectionId,
        error,
        attempts,
      });
    log.warn("tracking push failed", { shipmentId, attempts, error });
    return final ? ("failed" as const) : ("retry" as const);
  });
}

type PushRow = { s: ShipmentRow; orderNo: string; channel: Shipment["channel"] };

function toPushStatus(r: PushRow): TrackingPushStatus {
  return {
    shipmentId: r.s.id,
    orderId: r.s.orderId,
    orderNo: r.orderNo,
    channel: r.channel,
    trackingCode: r.s.trackingCode ?? "",
    status: r.s.trackingPushStatus === "pushing" ? "pending" : r.s.trackingPushStatus,
    attempts: r.s.trackingPushAttempts,
    lastAttemptAt: r.s.trackingPushAttempts > 0 ? r.s.updatedAt.toISOString() : null,
    error: r.s.trackingPushError,
  };
}

export async function listTrackingPush(
  tx: Tx,
  _ctx: TenantContext,
  input: PageInput & { status: ShipmentRow["trackingPushStatus"][] },
) {
  const page = keyset(shipments.createdAt, shipments.id, input);
  const rows = await tx
    .select({ s: shipments, orderNo: orders.orderNo, channel: orders.channel })
    .from(shipments)
    .innerJoin(orders, eq(orders.id, shipments.orderId))
    .where(
      and(
        page.where,
        inArray(shipments.trackingPushStatus, input.status),
        inArray(shipments.status, LIVE_LABEL),
      ),
    )
    .orderBy(...page.orderBy)
    .limit(page.limit + 1);
  return page.result(
    rows.map((r) => ({ ...r, createdAt: r.s.createdAt, id: r.s.id })),
    toPushStatus,
  );
}

/** Reset a failed push to pending; the router enqueues the job after commit. */
export async function resetTrackingPush(tx: Tx, _ctx: TenantContext, shipmentId: string) {
  const [s] = await tx.select().from(shipments).where(eq(shipments.id, shipmentId)).for("update");
  if (!s) throw notFound("shipment", shipmentId);
  if (!s.trackingCode || !LIVE_LABEL.includes(s.status))
    throw conflict("Shipment has no live label");
  // A `pushing` shipment keeps its state: the next attempt resumes it (or waits while in flight).
  if (s.trackingPushStatus === "pushing")
    await tx
      .update(shipments)
      .set({ trackingPushAttempts: 0, trackingPushError: null })
      .where(eq(shipments.id, s.id));
  else if (s.trackingPushStatus !== "pushed")
    await tx
      .update(shipments)
      .set({ trackingPushStatus: "pending", trackingPushAttempts: 0, trackingPushError: null })
      .where(eq(shipments.id, s.id));
  const [row] = await tx
    .select({ s: shipments, orderNo: orders.orderNo, channel: orders.channel })
    .from(shipments)
    .innerJoin(orders, eq(orders.id, shipments.orderId))
    .where(eq(shipments.id, shipmentId));
  return toPushStatus(row as PushRow);
}

/* ------------------------------ tracking events ----------------------------- */

/** Carrier says the package moved (mock timer or a carrier webhook). */
export async function markInTransit(tx: Tx, ctx: TenantContext, shipmentId: string) {
  const [s] = await tx.select().from(shipments).where(eq(shipments.id, shipmentId)).for("update");
  if (s?.status !== "labeled") return;
  await tx
    .update(shipments)
    .set({ status: "in_transit", trackingStatus: "in_transit" })
    .where(eq(shipments.id, s.id));
  // The carrier's first scan ships the units even when no tracking was pushed (CSV-only and
  // manual-upload channels, push off): marketplace clocks run on the scan (research 10 R11).
  await shipItems(tx, ctx.actor, s.orderItemIds, "carrier accepted the package");
  await emit(tx, ctx.companyId, "shipment.status_changed", {
    shipmentId: s.id,
    from: "labeled",
    to: "in_transit",
  });
  afterCommit(tx, () =>
    publish(ctx.companyId, {
      type: "shipment.updated",
      data: { shipmentId: s.id, orderId: s.orderId, status: "in_transit" },
    }).then(() => undefined),
  );
}

/**
 * Delivered: the shipment and its shipped items move to delivered, and the order's buyer PII
 * is scheduled for purge 30 days later.
 */
export async function markDelivered(
  tx: Tx,
  ctx: TenantContext,
  shipmentId: string,
  at = new Date(),
) {
  const [s] = await tx.select().from(shipments).where(eq(shipments.id, shipmentId)).for("update");
  if (!s || !["labeled", "in_transit", "exception"].includes(s.status)) return false;
  await tx
    .update(shipments)
    .set({ status: "delivered", trackingStatus: "delivered", deliveredAt: at })
    .where(eq(shipments.id, s.id));
  await shipItems(tx, ctx.actor, s.orderItemIds, "carrier delivered");
  const items = s.orderItemIds.length
    ? await tx
        .select({ id: orderItems.id, state: orderItems.state })
        .from(orderItems)
        .where(inArray(orderItems.id, s.orderItemIds))
    : [];
  for (const i of items)
    if (i.state === "shipped")
      await transitionItem(tx, i.id, "delivered", {
        actor: ctx.actor,
        reason: "carrier delivered",
      });
  // buyer_pii belongs to orders; the retention date is set here because delivery is known here.
  await tx
    .update(buyerPii)
    .set({ purgeAfter: new Date(at.getTime() + PII_RETENTION_DAYS * 86400_000) })
    .where(eq(buyerPii.orderId, s.orderId));
  await emit(tx, ctx.companyId, "shipment.status_changed", {
    shipmentId: s.id,
    from: s.status,
    to: "delivered",
  });
  await emit(tx, ctx.companyId, "shipment.delivered", {
    shipmentId: s.id,
    orderId: s.orderId,
    deliveredAt: at.toISOString(),
  });
  afterCommit(tx, () =>
    publish(ctx.companyId, {
      type: "shipment.updated",
      data: { shipmentId: s.id, orderId: s.orderId, status: "delivered" },
    }).then(() => undefined),
  );
  return true;
}

export const isMockCarrier = () => carrierAdapter().provider === "mock";
