import { eq, sql } from "drizzle-orm";
import { withSystem } from "../../src/db/client";
import type { Channel } from "../../src/db/schema";
import {
  companies,
  gangSheetBatches,
  gangSheets,
  orderItems,
  orderItemTransitions,
  orders,
  profitLines,
  refundEvents,
  reprints,
} from "../../src/db/schema";
import { createCompany, createConnection } from "../../src/test/fixtures";

/*
 * Test data for the analytics queries. Everything is written with withSystem in tests only
 * (architect A2.1): the runner and the SQL never use the owner role. Rows are backdated so each
 * test controls its window, and every test company gets a non-UTC time zone.
 */

let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;

export type Shop = { id: string; slug: string; connectionId: string; tz: string };

export async function makeShop(tz: string, slug?: string): Promise<Shop> {
  const co = await createCompany({ name: "Analytics test shop" });
  await withSystem((tx) =>
    tx
      .update(companies)
      .set({ timezone: tz, ...(slug ? { slug } : {}) })
      .where(eq(companies.id, co.id)),
  );
  const conn = await createConnection(co.id, "csv");
  return { id: co.id, slug: slug ?? co.slug, connectionId: conn.id, tz };
}

/** The instant a local date starts in a time zone (the database's own rule, DST-safe). */
export async function localMidnight(date: string, tz: string): Promise<Date> {
  const r = await withSystem((tx) =>
    tx.execute<{ t: Date }>(sql`select (${date}::date::timestamp at time zone ${tz}) as t`),
  );
  const t = r.rows[0]?.t;
  if (!t) throw new Error("no midnight");
  return new Date(t);
}

export const hours = (n: number) => n * 3_600_000;

export type OrderSpec = {
  channel?: Channel;
  placedAt?: Date;
  shipBy?: Date;
  shippedAt?: Date | null;
  status?: (typeof orders.$inferInsert)["status"];
  units?: number;
  rush?: boolean;
  personalized?: boolean;
};

export type MadeOrder = { orderId: string; itemIds: string[] };

export async function makeOrders(shop: Shop, specs: OrderSpec[]): Promise<MadeOrder[]> {
  if (specs.length === 0) return [];
  return withSystem(async (tx) => {
    const now = new Date();
    const inserted = await tx
      .insert(orders)
      .values(
        specs.map((s) => ({
          companyId: shop.id,
          connectionId: shop.connectionId,
          channel: s.channel ?? "csv",
          channelOrderId: `ord-${uniq()}`,
          orderNo: `T-${uniq()}`,
          placedAt: s.placedAt ?? now,
          shipBy: s.shipBy ?? now,
          shippedAt: s.shippedAt ?? null,
          status: s.status ?? (s.shippedAt ? "shipped" : "new"),
          isRush: s.rush ?? false,
          hasPersonalization: s.personalized ?? false,
          itemCount: s.units ?? 1,
        })),
      )
      .returning({ id: orders.id });
    const items = await tx
      .insert(orderItems)
      .values(
        inserted.flatMap((o, i) => {
          const spec = specs[i] ?? {};
          const units = spec.units ?? 1;
          return Array.from({ length: units }, (_, u) => ({
            companyId: shop.id,
            orderId: o.id,
            lineNo: 1,
            unitNo: u + 1,
            unitsInLine: units,
            channelLineId: "L1",
            channelSku: "TEST-SKU",
            title: "Test tee",
            unitPriceCents: 2500,
            shipBy: spec.shipBy ?? now,
          }));
        }),
      )
      .returning({ id: orderItems.id, orderId: orderItems.orderId });
    return inserted.map((o) => ({
      orderId: o.id,
      itemIds: items.filter((it) => it.orderId === o.id).map((it) => it.id),
    }));
  });
}

type ItemState = (typeof orderItemTransitions.$inferInsert)["toState"];

export async function addTransitions(
  shop: Shop,
  rows: Array<{ orderId: string; itemId: string; toState: ItemState; at: Date }>,
) {
  if (rows.length === 0) return;
  await withSystem((tx) =>
    tx.insert(orderItemTransitions).values(
      rows.map((r) => ({
        companyId: shop.id,
        orderId: r.orderId,
        orderItemId: r.itemId,
        toState: r.toState,
        actorKind: "system" as const,
        createdAt: r.at,
      })),
    ),
  );
}

export type SheetSpec = {
  status: (typeof gangSheets.$inferInsert)["status"];
  utilization: number;
  lengthIn: number;
  costCents: number;
  createdAt: Date;
};

export async function addSheets(shop: Shop, specs: SheetSpec[]) {
  if (specs.length === 0) return;
  await withSystem(async (tx) => {
    const [batch] = await tx
      .insert(gangSheetBatches)
      .values({ companyId: shop.id, name: `batch-${uniq()}` })
      .returning({ id: gangSheetBatches.id });
    if (!batch) throw new Error("batch insert failed");
    await tx.insert(gangSheets).values(
      specs.map((s, i) => ({
        companyId: shop.id,
        batchId: batch.id,
        sheetNo: i + 1,
        name: `sheet-${uniq()}`,
        status: s.status,
        utilization: s.utilization,
        lengthIn: s.lengthIn,
        costCents: s.costCents,
        createdAt: s.createdAt,
      })),
    );
  });
}

export async function addReprints(
  shop: Shop,
  rows: Array<{
    itemId: string;
    reason: (typeof reprints.$inferInsert)["reason"];
    status?: (typeof reprints.$inferInsert)["status"];
    blankConsumed: boolean;
    at: Date;
  }>,
) {
  await withSystem((tx) =>
    tx.insert(reprints).values(
      rows.map((r) => ({
        companyId: shop.id,
        orderItemId: r.itemId,
        reason: r.reason,
        status: r.status ?? "requested",
        blankConsumed: r.blankConsumed,
        requestedAt: r.at,
      })),
    ),
  );
}

export type LineSpec = Omit<
  typeof profitLines.$inferInsert,
  "companyId" | "orderId" | "orderItemId" | "channel"
> & { orderId: string; itemId: string; channel: Channel };

export async function addProfitLines(shop: Shop, lines: LineSpec[]) {
  if (lines.length === 0) return;
  await withSystem((tx) =>
    tx.insert(profitLines).values(
      lines.map(({ orderId, itemId, ...rest }) => ({
        ...rest,
        companyId: shop.id,
        orderId,
        orderItemId: itemId,
      })),
    ),
  );
}

export async function addRefunds(
  shop: Shop,
  rows: Array<{
    orderId: string;
    channel: Channel;
    amountCents: number;
    feeRecoveredCents: number;
    at: Date;
    voided?: boolean;
  }>,
) {
  await withSystem((tx) =>
    tx.insert(refundEvents).values(
      rows.map((r) => ({
        companyId: shop.id,
        orderId: r.orderId,
        channel: r.channel,
        source: "manual" as const,
        amountCents: r.amountCents,
        feeRecoveredCents: r.feeRecoveredCents,
        refundedAt: r.at,
        voidedAt: r.voided ? r.at : null,
      })),
    ),
  );
}
