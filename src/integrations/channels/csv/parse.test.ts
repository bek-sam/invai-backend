import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NormalizedOrder } from "@invai/contracts";
import { describe, expect, it } from "vitest";
import { CsvFormatError, money, parseDate, parseOrdersCsv } from "./parse";

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");

function valid(orders: unknown[]) {
  for (const o of orders) expect(NormalizedOrder.safeParse(o).success).toBe(true);
}

describe("csv value parsing", () => {
  it("reads money in the usual export shapes", () => {
    expect(money("$24.99")).toBe(2499);
    expect(money("1,024.50")).toBe(102450);
    expect(money("USD 5")).toBe(500);
    expect(money("(3.00)")).toBe(-300);
    expect(money("")).toBeNull();
  });

  it("reads dates in the usual export shapes", () => {
    expect(parseDate("09/22/26")?.toISOString()).toBe("2026-09-22T12:00:00.000Z");
    expect(parseDate("09/22/2026 04:02:10 PM")?.toISOString()).toBe("2026-09-22T16:02:10.000Z");
    expect(parseDate("2026-09-22T15:04:11+00:00")?.toISOString()).toBe("2026-09-22T15:04:11.000Z");
    expect(parseDate("2026-09-22 09:12:44 -0700")?.toISOString()).toBe("2026-09-22T16:12:44.000Z");
    expect(parseDate("2026-09-22")?.toISOString()).toBe("2026-09-22T12:00:00.000Z");
    expect(parseDate("Sep 22, 2026")?.toISOString()).toBe("2026-09-22T12:00:00.000Z");
    expect(parseDate("not-a-date")).toBeNull();
  });
});

describe("marketplace CSV formats", () => {
  it("etsy: Sold Order Items, grouped by Order ID, personalization from Variations", () => {
    const out = parseOrdersCsv("etsy", fixture("etsy-sold-order-items.csv"));
    expect(out.rowsTotal).toBe(6);
    expect(out.orders).toHaveLength(4);
    valid(out.orders);
    const first = out.orders.find((o) => o.channelOrderId === "3310000001");
    expect(first?.items).toHaveLength(2);
    expect(first?.items[1]).toMatchObject({
      channelSku: "DB019-G64000-SND-L",
      quantity: 2,
      unitPrice: 2499,
    });
    expect(first?.totals).toMatchObject({ subtotal: 7497, shipping: 499, discount: 500 });
    expect(first?.shipTo).toMatchObject({
      city: "Phoenix",
      state: "AZ",
      zip: "85014",
      country: "US",
    });
    const bride = out.orders.find((o) => o.channelOrderId === "3310000002");
    expect(bride?.items[0]?.personalization).toEqual([
      { question: "Personalization", answer: "Ashley", fileUrl: null },
    ]);
    expect(bride?.items[0]?.variantTitle).toBe("White / S");
    expect(out.errors).toEqual([{ row: 7, message: "Missing quantity" }]);
  });

  it("etsy: rejects the order-level Sold Orders file with a hint", () => {
    expect(() =>
      parseOrdersCsv(
        "etsy",
        "Sale Date,Order ID,Buyer User ID,Full Name,Number of Items\n09/22/26,1,x,y,1\n",
      ),
    ).toThrow(/Sold Order Items/);
  });

  it("amazon: tab-delimited Unshipped Orders with promise-date as ship-by", () => {
    const out = parseOrdersCsv("amazon", fixture("amazon-unshipped-orders.txt"));
    expect(out.rowsTotal).toBe(4);
    expect(out.orders).toHaveLength(3);
    valid(out.orders);
    const multi = out.orders.find((o) => o.channelOrderId === "113-4521987-1234502");
    expect(multi).toMatchObject({ shipBy: "2026-09-23T06:59:59.000Z", isRush: true });
    expect(multi?.items[0]).toMatchObject({
      quantity: 3,
      unitPrice: 2699,
      channelSku: "DB008-G64000-SGR-XL",
    });
    expect(multi?.totals).toMatchObject({ shipping: 599, tax: 696 });
    expect(multi?.shipTo?.street2).toBe("Suite 4");
    expect(out.errors[0]).toMatchObject({ row: 5 });
    expect(out.errors[0]?.message).toMatch(/purchase-date/);
  });

  it("tiktok: skips the description row, cancelled orders and bad quantities", () => {
    const out = parseOrdersCsv("tiktok", fixture("tiktok-orders.csv"));
    expect(out.orders.map((o) => o.channelOrderId)).toEqual([
      "576912345678901001",
      "576912345678901002",
    ]);
    valid(out.orders);
    expect(out.cancelledChannelOrderIds).toEqual(["576912345678901003"]);
    expect(out.orders[1]?.items[0]).toMatchObject({
      quantity: 2,
      unitPrice: 2069,
      variantTitle: "Heather Military Green, M",
    });
    expect(out.orders[0]?.placedAt).toBe("2026-09-22T10:15:45.000Z");
    expect(out.orders[0]?.buyerNote).toBe("Love this!");
    expect(out.errors).toEqual([{ row: 6, message: 'Invalid quantity "abc"' }]);
  });

  it("walmart: one order per PO with Ship By, cancelled lines", () => {
    const out = parseOrdersCsv("walmart", fixture("walmart-orders.csv"));
    expect(out.orders).toHaveLength(2);
    valid(out.orders);
    const po = out.orders.find((o) => o.channelOrderId === "4792210001234");
    expect(po).toMatchObject({ orderNo: "200012345678901", shipBy: "2026-09-23T12:00:00.000Z" });
    expect(po?.items).toHaveLength(2);
    expect(po?.items[1]).toMatchObject({ quantity: 2, unitPrice: 2399 });
    expect(po?.totals.tax).toBe(594);
    expect(out.cancelledChannelOrderIds).toEqual(["4792210001235"]);
    expect(out.orders.find((o) => o.channelOrderId === "4792210001236")?.isRush).toBe(true);
  });

  it("walmart: a cancelled line cancels only that line (T-7-4)", () => {
    const [header, l1, l2, ...rest] = fixture("walmart-orders.csv").split("\n");
    const cancelledL2 = (l2 as string).replace(",Acknowledged,", ",Cancelled,");
    const out = parseOrdersCsv("walmart", [header, l1, cancelledL2, ...rest].join("\n"));
    const po = out.orders.find((o) => o.channelOrderId === "4792210001234");
    expect(po?.items.map((i) => i.channelLineId)).toEqual(["4792210001234-1"]);
    expect(out.cancelledLines).toEqual([
      { channelOrderId: "4792210001234", channelLineId: "4792210001234-2" },
    ]);
    expect(out.cancelledChannelOrderIds).toEqual(["4792210001235"]);
    // Every line cancelled: the whole PO is cancelled, no line cancels.
    const both = [header, (l1 as string).replace(",Acknowledged,", ",Cancelled,"), cancelledL2];
    const all = parseOrdersCsv("walmart", both.join("\n"));
    expect(all.orders).toHaveLength(0);
    expect(all.cancelledChannelOrderIds).toEqual(["4792210001234"]);
    expect(all.cancelledLines).toEqual([]);
  });

  it("tiktok On hold and amazon buyer-requested cancellation become holds (T-7-4)", () => {
    const tt = fixture("tiktok-orders.csv").replace(
      "576912345678901002,To ship",
      "576912345678901002,On hold",
    );
    const out = parseOrdersCsv("tiktok", tt);
    expect(out.orders.map((o) => o.channelOrderId)).toContain("576912345678901002");
    expect(out.holds).toEqual([
      { channelOrderId: "576912345678901002", signal: "channel_on_hold" },
    ]);
    const [h, first, ...more] = fixture("amazon-unshipped-orders.txt").split("\n");
    const amazon = [
      `${h}\tis-buyer-requested-cancellation`,
      `${first}\ttrue`,
      ...more.filter(Boolean).map((l) => `${l}\tfalse`),
    ].join("\n");
    const az = parseOrdersCsv("amazon", amazon);
    expect(az.holds).toEqual([
      { channelOrderId: "113-4521987-1234501", signal: "buyer_cancel_request" },
    ]);
    expect(parseOrdersCsv("tiktok", fixture("tiktok-orders.csv")).holds).toEqual([]);
  });

  it("shopify: order columns from the first row, cancelled orders separated", () => {
    const out = parseOrdersCsv("shopify", fixture("shopify-orders-export.csv"));
    expect(out.orders).toHaveLength(2);
    valid(out.orders);
    const o = out.orders[0];
    expect(o).toMatchObject({
      channelOrderId: "6201000005001",
      orderNo: "#5001",
      buyerNote: "Please gift wrap",
    });
    expect(o?.items.map((i) => [i.title, i.variantTitle, i.channelSku])).toEqual([
      ["Golden Hour Tee", "Mustard / M", "DB024-BC3001-MST-M"],
      ["Wildflower Meadow Tee", "Heather Mauve / L", "DB023-BC3001-HMV-L"],
    ]);
    expect(o?.totals).toEqual({ subtotal: 6400, shipping: 0, tax: 550, discount: 0, total: 6950 });
    expect(o?.shipTo?.zip).toBe("85003");
    expect(o?.placedAt).toBe("2026-09-22T16:12:40.000Z");
    expect(out.orders[1]?.isRush).toBe(true);
    expect(out.cancelledChannelOrderIds).toEqual(["6201000005003"]);
  });

  it("generic: template columns, key/value personalization", () => {
    const out = parseOrdersCsv("generic", fixture("generic-orders.csv"), "csv");
    expect(out.orders).toHaveLength(3);
    valid(out.orders);
    const fam = out.orders.find((o) => o.channelOrderId === "POP-1002");
    expect(fam?.isRush).toBe(true);
    expect(fam?.items[0]?.personalization).toEqual([
      { question: "family name", answer: "Ford", fileUrl: null },
      { question: "year", answer: "2026", fileUrl: null },
    ]);
    expect(out.orders.find((o) => o.channelOrderId === "POP-1001")?.shipBy).toBe(
      "2026-09-25T12:00:00.000Z",
    );
  });

  it("rejects a file in the wrong format with the missing columns", () => {
    expect(() => parseOrdersCsv("amazon", fixture("shopify-orders-export.csv"))).toThrow(
      CsvFormatError,
    );
    expect(() => parseOrdersCsv("walmart", "")).toThrow(/empty/);
  });
});
