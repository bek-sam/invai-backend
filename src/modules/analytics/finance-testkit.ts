import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Channel } from "@invai/contracts";
import { sql } from "drizzle-orm";
import { withSystem } from "../../db/client";
import {
  designs,
  orderItems,
  orders,
  profitLines,
  refundEvents,
  reprints,
  shipments,
} from "../../db/schema";
import { createConnection } from "../../test/fixtures";

/*
 * Test data for the T-A3 finance analytics tests: profit lines written directly with chosen
 * buckets (so every expected cent is known), plus the metric SQL files run on the same database.
 */

let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;

export type LineSpec = {
  revenue?: number;
  fees?: number;
  blank?: number;
  transfer?: number;
  label?: number;
  packaging?: number;
  labor?: number;
  ads?: number;
  refunds?: number;
  designId?: string | null;
  isReprint?: boolean;
  estimated?: string[];
};

export type OrderSpec = {
  channel?: Channel;
  placedAt: Date;
  subtotal?: number;
  shipping?: number;
  discount?: number;
  status?: "new" | "shipped" | "cancelled";
  /** Omit or empty → an order with one item and no profit line (AC-A7). */
  lines?: LineSpec[];
};

export async function addDesign(companyId: string, name: string) {
  const [d] = await withSystem((tx) =>
    tx
      .insert(designs)
      .values({ companyId, code: `D${uniq()}`, name })
      .returning(),
  );
  return d?.id as string;
}

const connections = new Map<string, string>();
async function connectionFor(companyId: string, channel: Channel) {
  const k = `${companyId}:${channel}`;
  let id = connections.get(k);
  if (!id) {
    id = (await createConnection(companyId, channel)).id;
    connections.set(k, id);
  }
  return id;
}

export async function addOrder(companyId: string, spec: OrderSpec) {
  const channel = spec.channel ?? "etsy";
  const connectionId = await connectionFor(companyId, channel);
  const lines = spec.lines ?? [];
  const units = Math.max(1, lines.length);
  return withSystem(async (tx) => {
    const [order] = await tx
      .insert(orders)
      .values({
        companyId,
        connectionId,
        channel,
        channelOrderId: `ord-${uniq()}`,
        orderNo: `A-${uniq()}`,
        placedAt: spec.placedAt,
        shipBy: new Date(spec.placedAt.getTime() + 2 * 86_400_000),
        itemCount: units,
        subtotalCents: spec.subtotal ?? 2500 * units,
        shippingCents: spec.shipping ?? 0,
        discountCents: spec.discount ?? 0,
        totalCents: spec.subtotal ?? 2500 * units,
        status: spec.status ?? "shipped",
      })
      .returning();
    if (!order) throw new Error("order insert failed");
    const items = await tx
      .insert(orderItems)
      .values(
        Array.from({ length: units }, (_, i) => ({
          companyId,
          orderId: order.id,
          lineNo: 1,
          unitNo: i + 1,
          unitsInLine: units,
          channelLineId: "L1",
          channelSku: "TEST-SKU",
          title: "Test tee",
          unitPriceCents: 2500,
          designId: lines[i]?.designId ?? null,
          shipBy: order.shipBy,
          state: "shipped" as const,
        })),
      )
      .returning();
    if (lines.length)
      await tx.insert(profitLines).values(
        lines.map((l, i) => {
          const b = {
            revenueCents: l.revenue ?? 2500,
            channelFeesCents: l.fees ?? 0,
            blankCostCents: l.blank ?? 0,
            transferCostCents: l.transfer ?? 0,
            labelCostCents: l.label ?? 0,
            packagingCostCents: l.packaging ?? 0,
            laborCostCents: l.labor ?? 0,
            adsCostCents: l.ads ?? 0,
            refundsCents: l.refunds ?? 0,
          };
          const net =
            b.revenueCents -
            b.channelFeesCents -
            b.blankCostCents -
            b.transferCostCents -
            b.labelCostCents -
            b.packagingCostCents -
            b.laborCostCents -
            b.adsCostCents -
            b.refundsCents;
          return {
            companyId,
            orderId: order.id,
            orderItemId: items[i]?.id as string,
            channel,
            designId: l.designId ?? null,
            ...b,
            netCents: net,
            isReprint: l.isReprint ?? false,
            estimated: l.estimated ?? [],
            placedAt: spec.placedAt,
          };
        }),
      );
    return { order, items };
  });
}

export async function addShipment(
  companyId: string,
  orderId: string,
  s: {
    postage: number;
    fee?: number;
    labeledAt: Date;
    weightOz?: number;
    service?: string;
    voided?: boolean;
  },
) {
  await withSystem((tx) =>
    tx.insert(shipments).values({
      companyId,
      orderId,
      status: s.voided ? "voided" : "labeled",
      carrier: "usps",
      service: s.service ?? "GroundAdvantage",
      postageCents: s.postage,
      labelFeeCents: s.fee ?? 4,
      weightOz: s.weightOz ?? 6,
      labeledAt: s.labeledAt,
      voidedAt: s.voided ? s.labeledAt : null,
    }),
  );
}

export async function addRefund(
  companyId: string,
  orderId: string,
  channel: Channel,
  r: { amount: number; recovered?: number; at: Date },
) {
  await withSystem((tx) =>
    tx.insert(refundEvents).values({
      companyId,
      orderId,
      channel,
      source: "manual",
      amountCents: r.amount,
      feeRecoveredCents: r.recovered ?? 0,
      refundedAt: r.at,
    }),
  );
}

export async function addReprint(companyId: string, orderItemId: string, at: Date) {
  await withSystem((tx) =>
    tx.insert(reprints).values({
      companyId,
      orderItemId,
      reason: "misprint",
      blankConsumed: true,
      requestedAt: at,
    }),
  );
}

/** `[fromYmd, toYmd)` as local midnights in the company's time zone (what the metric SQL uses). */
export async function localPeriod(companyId: string, fromYmd: string, toYmd: string) {
  const r = await withSystem((tx) =>
    tx.execute<{ f: string; t: string }>(sql`
      select ((${fromYmd}::date)::timestamp at time zone c.timezone) as f,
             ((${toYmd}::date)::timestamp at time zone c.timezone) as t
      from companies c where c.id = ${companyId}`),
  );
  const row = r.rows[0];
  if (!row) throw new Error("company not found");
  return { from: new Date(row.f).toISOString(), to: new Date(row.t).toISOString() };
}

/** Runs `invai-docs/metrics/sql/<name>.sql` (psql variables substituted) and keeps one shop's rows. */
export async function runMetricSql(
  name: string,
  companyId: string,
  vars: Record<string, string | number>,
): Promise<Record<string, unknown>[]> {
  const file = resolve(import.meta.dirname, "../../../../invai-docs/metrics/sql", `${name}.sql`);
  let text = readFileSync(file, "utf8");
  for (const [k, v] of Object.entries(vars)) text = text.replaceAll(`:'${k}'`, `'${v}'`);
  text = text.trim().replace(/;$/, "");
  return withSystem(async (tx) => {
    const [c] = (
      await tx.execute<{ slug: string }>(sql`select slug from companies where id = ${companyId}`)
    ).rows;
    const out = await tx.execute<Record<string, unknown>>(sql.raw(text));
    return out.rows.filter((r) => r.slug === c?.slug);
  });
}

const at = (ymd: string, hourUtc: number) =>
  new Date(`${ymd}T${String(hourUtc).padStart(2, "0")}:00:00Z`);
const REG = {
  fees: 200,
  blank: 300,
  transfer: 150,
  label: 450,
  packaging: 45,
  labor: 120,
  ads: 100,
};

/**
 * The shared scenario (company time zone America/Phoenix): base week Aug 3–10 and current week
 * Aug 10–17, 2026. Current week: 20 design-X orders, 14 design-Y orders (7 with an estimated
 * blank), one order that loses money on its label (free shipping), one order with a reprint line,
 * one cancelled order, a dated refund, labeled orders with a voided extra label, and 3 orders with
 * no profit line yet. Base week: 22 design-X orders.
 */
export async function buildScenario(companyId: string) {
  const x = await addDesign(companyId, "Cactus Sunset");
  const y = await addDesign(companyId, "Desert Bloom Logo");
  const base = await localPeriod(companyId, "2026-08-03", "2026-08-10");
  const current = await localPeriod(companyId, "2026-08-10", "2026-08-17");

  for (let i = 0; i < 22; i++)
    await addOrder(companyId, {
      placedAt: at(`2026-08-0${4 + (i % 5)}`, 15 + (i % 6)),
      subtotal: 2500,
      lines: [{ revenue: 2500, ...REG, designId: x }],
    });

  const labeled: string[] = [];
  for (let i = 0; i < 20; i++) {
    const shipping = i < 10 ? 500 : 0;
    const discount = i % 4 === 0 ? 300 : 0;
    const { order } = await addOrder(companyId, {
      channel: i % 2 ? "shopify" : "etsy",
      placedAt: at(`2026-08-1${1 + (i % 5)}`, 15 + (i % 6)),
      subtotal: 2800 + discount - shipping,
      shipping,
      discount,
      lines: [{ revenue: 2800, ...REG, designId: x }],
    });
    if (i < 12) labeled.push(order.id);
  }
  for (let i = 0; i < 14; i++)
    await addOrder(companyId, {
      channel: "etsy",
      placedAt: at(`2026-08-1${1 + (i % 5)}`, 16),
      subtotal: 2400,
      lines: [
        {
          revenue: 2400,
          ...REG,
          designId: y,
          estimated: i % 2 ? ["blankCost"] : ["channelFees"],
        },
      ],
    });
  for (const [i, id] of labeled.entries()) {
    await addShipment(companyId, id, {
      postage: i % 3 ? 450 : 650,
      weightOz: i % 2 ? 5 : 10,
      service: i % 2 ? "GroundAdvantage" : "Priority",
      labeledAt: at("2026-08-15", 17),
    });
  }
  // A voided label never counts.
  await addShipment(companyId, labeled[0] as string, {
    postage: 9999,
    labeledAt: at("2026-08-15", 18),
    voided: true,
  });

  // Loses money on its label: CM2 = 1500 − 120 − 300 − 150 − 2400 − 45 − 120 = −1635.
  const losing = await addOrder(companyId, {
    channel: "etsy",
    placedAt: at("2026-08-12", 18),
    subtotal: 1500,
    shipping: 0,
    lines: [
      {
        revenue: 1500,
        fees: 120,
        blank: 300,
        transfer: 150,
        label: 2400,
        packaging: 45,
        labor: 120,
        ads: 50,
        designId: y,
      },
    ],
  });
  await addShipment(companyId, losing.order.id, {
    postage: 2396,
    labeledAt: at("2026-08-13", 17),
  });

  // Reprint: the second line is the reprint's extra cost.
  const rp = await addOrder(companyId, {
    channel: "etsy",
    placedAt: at("2026-08-13", 19),
    subtotal: 2800,
    lines: [
      { revenue: 2800, ...REG, designId: x },
      { revenue: 0, blank: 300, transfer: 150, designId: x, isReprint: true },
    ],
  });
  await addReprint(companyId, rp.items[0]?.id as string, at("2026-08-14", 17));

  // Cancelled: the reversal sits on the line.
  await addOrder(companyId, {
    channel: "etsy",
    status: "cancelled",
    placedAt: at("2026-08-12", 20),
    subtotal: 2500,
    lines: [{ revenue: 2500, refunds: 2500, designId: x }],
  });

  // A dated refund in the current week on a current-week order.
  await addRefund(companyId, labeled[1] as string, "shopify", {
    amount: 1000,
    recovered: 60,
    at: at("2026-08-14", 20),
  });

  // No profit line yet (AC-A7).
  for (let i = 0; i < 3; i++)
    await addOrder(companyId, { channel: "etsy", placedAt: at("2026-08-16", 18) });

  return { x, y, base, current, losingOrderId: losing.order.id, labeled };
}
