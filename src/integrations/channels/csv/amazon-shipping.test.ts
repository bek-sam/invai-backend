import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NormalizedOrder } from "@invai/contracts";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem, withTenant } from "../../../db/client";
import { companies, orders } from "../../../db/schema";
import { ensureBucket, objectKey, putObject } from "../../../lib/s3";
import { importCsv } from "../../../modules/channels/sync";
import {
  createCompany,
  createConnection,
  createLocation,
  createUser,
  tenantContext,
} from "../../../test/fixtures";
import { parseOrdersCsv } from "./parse";

/*
 * B-183: `orders.shipping_cents` was 0 for every Amazon order in the metrics. Amazon has two
 * order flat files with the ship-to (column lists from developer-docs.amazon, checked
 * 2026-09-29): the Order Report carries `shipping-price` per line, the Unshipped Orders report
 * carries no price columns at all. Both fixtures are synthetic, built from those exact column
 * lists (fake names, example.com emails, 555-01xx phones).
 */

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");

describe("Amazon shipping credit (B-183)", () => {
  it("Order Report: shipping-price per line sums into the order's shipping credit", () => {
    const out = parseOrdersCsv("amazon", fixture("amazon-order-report.txt"));
    expect(out.errors).toEqual([]);
    expect(out.rowsTotal).toBe(4);
    for (const o of out.orders) expect(NormalizedOrder.safeParse(o).success).toBe(true);
    const by = new Map(out.orders.map((o) => [o.channelOrderId, o]));

    expect(by.get("114-3310000-0000101")?.totals).toEqual({
      subtotal: 2499,
      shipping: 499,
      tax: 215 + 43,
      discount: 0,
      total: 2499 + 499 + 258,
    });
    // Two lines, each with its own share of the shipping credit; quantity 2 stays 2 units.
    const multi = by.get("114-3310000-0000102");
    expect(multi?.totals).toMatchObject({ subtotal: 5398 + 2499, shipping: 399 + 200 });
    expect(multi?.items.map((i) => [i.quantity, i.unitPrice])).toEqual([
      [2, 2699],
      [1, 2499],
    ]);
    expect(multi?.shipTo).toMatchObject({ name: "José Núñez", street2: "Apt 4" });
    // latest-ship-date is the ship-by when there is no promise-date.
    expect(multi?.shipBy).toBe("2026-09-23T06:59:59.000Z");
    // Free shipping is a real 0, not a missing value.
    expect(by.get("114-3310000-0000103")?.totals.shipping).toBe(0);
  });

  it("Unshipped Orders report has no price columns, so amounts are 0 (documented, not a bug)", () => {
    const text = fixture("amazon-unshipped-orders-official.txt");
    const header = text.split("\n")[0]?.split("\t") ?? [];
    expect(header).toHaveLength(27);
    expect(header.filter((h) => /-(price|tax)$|promotion/.test(h))).toEqual([]);
    const out = parseOrdersCsv("amazon", text);
    expect(out.errors).toEqual([]);
    expect(out.orders).toHaveLength(3);
    for (const o of out.orders) expect(o.totals).toMatchObject({ subtotal: 0, shipping: 0 });
    expect(out.orders.find((o) => o.channelOrderId === "114-3310000-0000102")?.shipBy).toBe(
      "2026-09-23T06:59:59.000Z",
    );
  });

  describe("import", () => {
    let companyId: string;
    let connId: string;
    let ctx: ReturnType<typeof tenantContext>;

    beforeAll(async () => {
      companyId = (await createCompany()).id;
      await withSystem((tx) =>
        tx.update(companies).set({ plan: "scale" }).where(eq(companies.id, companyId)),
      );
      const owner = await createUser(companyId, "owner");
      ctx = tenantContext(companyId, owner.id, "owner");
      await createLocation(companyId);
      connId = (await createConnection(companyId, "amazon")).id;
      await ensureBucket();
    });

    it("stores the Order Report's shipping credit in orders.shipping_cents", async () => {
      const key = objectKey(companyId, "csv", "txt");
      await putObject(key, fixture("amazon-order-report.txt"), "text/plain");
      const report = await importCsv(ctx, { id: connId, fileKey: key, format: "amazon" });
      expect(report).toMatchObject({ status: "completed", ordersImported: 3, rowsFailed: 0 });
      const rows = await withTenant(companyId, (tx) =>
        tx
          .select({ id: orders.channelOrderId, shipping: orders.shippingCents })
          .from(orders)
          .where(eq(orders.channel, "amazon")),
      );
      expect(Object.fromEntries(rows.map((r) => [r.id, r.shipping]))).toEqual({
        "114-3310000-0000101": 499,
        "114-3310000-0000102": 599,
        "114-3310000-0000103": 0,
      });
    });
  });
});
