import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { TenantContext } from "../../api/context";
import { withTenant } from "../../db/client";
import { type channelConnections, orderItems, orders } from "../../db/schema";
import { parseOrdersCsv } from "../../integrations/channels/csv/parse";
import {
  createCompany,
  createConnection,
  createLocation,
  createUser,
  tenantContext,
} from "../../test/fixtures";
import { importNormalizedOrders } from "./import";

/*
 * B-99: concurrent imports of the same orders create each order once (per-connection advisory
 * lock + ON CONFLICT on (company_id, channel, channel_order_id)).
 * B-197: re-importing Amazon's Unshipped Orders report (no price columns) after the Order Report
 * never overwrites the known money with 0.
 * Fixtures: the synthetic Amazon files from T-22-3 (fake names, example.com, 555-01xx).
 */

const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, "../../integrations/channels/csv/fixtures", name), "utf8");
const orderReport = () => parseOrdersCsv("amazon", fixture("amazon-order-report.txt")).orders;
const unshipped = () =>
  parseOrdersCsv("amazon", fixture("amazon-unshipped-orders-official.txt")).orders;

type Conn = typeof channelConnections.$inferSelect;

async function shop(name: string) {
  const companyId = (await createCompany({ name })).id;
  const owner = await createUser(companyId, "owner");
  await createLocation(companyId);
  return { companyId, ctx: tenantContext(companyId, owner.id, "owner") };
}

const money = (companyId: string) =>
  withTenant(companyId, (tx) =>
    tx
      .select({
        no: orders.channelOrderId,
        subtotal: orders.subtotalCents,
        shipping: orders.shippingCents,
        tax: orders.taxCents,
        discount: orders.discountCents,
        total: orders.totalCents,
      })
      .from(orders)
      .orderBy(orders.channelOrderId),
  );

const unitPrices = (companyId: string) =>
  withTenant(companyId, (tx) =>
    tx
      .select({ price: orderItems.unitPriceCents })
      .from(orderItems)
      .orderBy(orderItems.orderId, orderItems.lineNo, orderItems.unitNo),
  ).then((rows) => rows.map((r) => r.price));

describe("import races (B-99)", () => {
  let companyId: string;
  let ctx: TenantContext;
  let csvA: Conn;

  beforeAll(async () => {
    ({ companyId, ctx } = await shop("Race shop"));
    csvA = await createConnection(companyId, "amazon");
  });

  const run = (conn: Conn) =>
    withTenant(companyId, (tx) =>
      importNormalizedOrders(tx, ctx, conn, orderReport(), { source: "csv" }),
    );

  it("two imports of the same file in parallel create each order once", async () => {
    const [a, b] = await Promise.all([run(csvA), run(csvA)]);
    expect(a.imported + b.imported).toBe(3);
    expect(a.errors).toEqual([]);
    expect(b.errors).toEqual([]);
    const rows = await money(companyId);
    expect(rows.map((r) => r.no)).toEqual([
      "114-3310000-0000101",
      "114-3310000-0000102",
      "114-3310000-0000103",
    ]);
    // One unit per ordered shirt, never doubled.
    expect(await unitPrices(companyId)).toHaveLength(5);
  });

  it("an import on another connection waits for the first commit and updates, never duplicates", async () => {
    const { companyId: id2, ctx: ctx2 } = await shop("Race shop 2");
    const a = await createConnection(id2, "amazon");
    const b = await createConnection(id2, "amazon");
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let firstDone: () => void = () => {};
    const firstImported = new Promise<void>((r) => {
      firstDone = r;
    });
    // Tx 1 inserts the orders and holds its transaction open.
    const first = withTenant(id2, async (tx) => {
      const res = await importNormalizedOrders(tx, ctx2, a, orderReport(), { source: "csv" });
      firstDone();
      await gate;
      return res;
    });
    await firstImported;
    // Tx 2 (another connection, so no shared lock) reads nothing yet and hits ON CONFLICT.
    const second = withTenant(id2, (tx) =>
      importNormalizedOrders(tx, ctx2, b, orderReport(), { source: "csv" }),
    );
    await new Promise((r) => setTimeout(r, 200));
    release();
    const [r1, r2] = await Promise.all([first, second]);
    expect(r1.imported).toBe(3);
    expect(r2).toMatchObject({ imported: 0, errors: [] });
    expect(r2.updated + r2.skipped).toBe(3);
    expect(await money(id2)).toHaveLength(3);
    expect(await unitPrices(id2)).toHaveLength(5);
  });
});

describe("Amazon Unshipped after Order Report keeps the money (B-197)", () => {
  it("never replaces known prices, shipping or tax with 0; the Order Report still fills a 0", async () => {
    const { companyId, ctx } = await shop("Money shop");
    const conn = await createConnection(companyId, "amazon");
    const imp = (list: ReturnType<typeof orderReport>) =>
      withTenant(companyId, (tx) => importNormalizedOrders(tx, ctx, conn, list, { source: "csv" }));

    await imp(orderReport());
    const before = await money(companyId);
    const pricesBefore = await unitPrices(companyId);
    expect(before.find((o) => o.no === "114-3310000-0000102")).toMatchObject({
      shipping: 599,
    });
    expect(before.every((o) => o.subtotal > 0 && o.total > 0)).toBe(true);
    // The Unshipped report really has no prices (T-22-3): every total and unit price is 0.
    expect(
      unshipped().every((o) => o.totals.total === 0 && o.items.every((i) => i.unitPrice === 0)),
    ).toBe(true);

    await imp(unshipped());
    expect(await money(companyId)).toEqual(before);
    expect(await unitPrices(companyId)).toEqual(pricesBefore);

    // Reverse order on a fresh shop: Unshipped first (0), then the Order Report fills it in.
    const other = await shop("Money shop 2");
    const conn2 = await createConnection(other.companyId, "amazon");
    await withTenant(other.companyId, (tx) =>
      importNormalizedOrders(tx, other.ctx, conn2, unshipped(), { source: "csv" }),
    );
    expect((await money(other.companyId)).every((o) => o.total === 0)).toBe(true);
    await withTenant(other.companyId, (tx) =>
      importNormalizedOrders(tx, other.ctx, conn2, orderReport(), { source: "csv" }),
    );
    expect(
      (await money(other.companyId)).map(({ subtotal, shipping, tax, total }) => ({
        subtotal,
        shipping,
        tax,
        total,
      })),
    ).toEqual(
      before.map(({ subtotal, shipping, tax, total }) => ({ subtotal, shipping, tax, total })),
    );
  });

  it("a price-less file raising a quantity adds the unit at the line's known price", async () => {
    const { companyId, ctx } = await shop("Money shop 4");
    const conn = await createConnection(companyId, "amazon");
    await withTenant(companyId, (tx) =>
      importNormalizedOrders(tx, ctx, conn, orderReport(), { source: "csv" }),
    );
    const more = unshipped().map((o) =>
      o.channelOrderId === "114-3310000-0000101"
        ? { ...o, items: o.items.map((i) => ({ ...i, quantity: i.quantity + 1 })) }
        : o,
    );
    await withTenant(companyId, (tx) =>
      importNormalizedOrders(tx, ctx, conn, more, { source: "csv" }),
    );
    const units = await withTenant(companyId, (tx) =>
      tx
        .select({ price: orderItems.unitPriceCents, state: orderItems.state })
        .from(orderItems)
        .innerJoin(orders, eq(orders.id, orderItems.orderId))
        .where(eq(orders.channelOrderId, "114-3310000-0000101")),
    );
    expect(units).toHaveLength(2);
    expect(new Set(units.map((u) => u.price)).size).toBe(1);
    expect(units[0]?.price).toBeGreaterThan(0);
  });

  it("a real non-zero change still applies", async () => {
    const { companyId, ctx } = await shop("Money shop 3");
    const conn = await createConnection(companyId, "amazon");
    const list = orderReport();
    await withTenant(companyId, (tx) =>
      importNormalizedOrders(tx, ctx, conn, list, { source: "csv" }),
    );
    const edited = list.map((o) =>
      o.channelOrderId === "114-3310000-0000101"
        ? { ...o, totals: { ...o.totals, shipping: 799, total: o.totals.total + 300 } }
        : o,
    );
    const res = await withTenant(companyId, (tx) =>
      importNormalizedOrders(tx, ctx, conn, edited, { source: "csv" }),
    );
    expect(res.updated).toBe(1);
    const [row] = (await money(companyId)).filter((o) => o.no === "114-3310000-0000101");
    expect(row?.shipping).toBe(799);
    const [stored] = await withTenant(companyId, (tx) =>
      tx.select().from(orders).where(eq(orders.channelOrderId, "114-3310000-0000101")),
    );
    expect(stored?.totalCents).toBe((list[0]?.totals.total ?? 0) + 300);
  });
});
