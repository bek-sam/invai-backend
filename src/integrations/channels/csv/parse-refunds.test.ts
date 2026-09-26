import { describe, expect, it } from "vitest";
import { gqlRefundsToChannel } from "../shopify/refunds";
import { parseOrdersCsv } from "./parse";

describe("refund columns in order exports (T-7-2)", () => {
  it("reads a generic refund_amount with its date", () => {
    const csv = [
      "order_id,placed_at,sku,quantity,unit_price,shipping,tax,total,refund_amount,refunded_at",
      "R-1,2026-09-01 10:00,SKU-A,1,30.00,0,0,30.00,12.50,2026-09-20",
      "R-2,2026-09-01 10:00,SKU-B,1,30.00,0,0,30.00,,",
    ].join("\n");
    const p = parseOrdersCsv("generic", csv, "csv");
    expect(p.orders).toHaveLength(2);
    expect(p.refunds).toHaveLength(1);
    expect(p.refunds?.[0]).toMatchObject({
      channelOrderId: "R-1",
      channelRefundId: "R-1:csv-refund",
      channelLineId: null,
      amountCents: 1250,
    });
    expect(p.refunds?.[0]?.refundedAt?.startsWith("2026-09-20")).toBe(true);
  });

  it("takes sales tax out of Shopify's Refunded Amount and has no date", () => {
    const csv = [
      "Name,Id,Created at,Subtotal,Shipping,Taxes,Total,Refunded Amount,Lineitem quantity,Lineitem name,Lineitem price,Lineitem sku",
      "#9001,9001,2026-09-01 10:00:00 -0700,50.00,0.00,5.00,55.00,55.00,1,Tee A,25.00,SKU-A",
      "#9001,,,,,,,,1,Tee B,25.00,SKU-B",
    ].join("\n");
    const p = parseOrdersCsv("shopify", csv);
    expect(p.orders).toHaveLength(1);
    expect(p.refunds).toEqual([
      {
        channelOrderId: "9001",
        channelRefundId: "9001:csv-refund",
        channelLineId: null,
        quantity: 1,
        amountCents: 5000,
        refundedAt: null,
        note: "From the order export",
      },
    ]);
  });
});

describe("Shopify refunds from the order's refunds (T-7-2)", () => {
  const money = (amount: string) => ({ shopMoney: { amount } });
  it("maps line and shipping refunds before tax and skips pre-fulfilment cancels", () => {
    const out = gqlRefundsToChannel("6200000001", [
      {
        id: "gid://shopify/Refund/77",
        createdAt: "2026-09-20T15:00:00Z",
        note: "damaged",
        refundLineItems: {
          nodes: [
            {
              lineItem: { id: "gid://shopify/LineItem/14000000011" },
              quantity: 1,
              restockType: "RETURN",
              subtotalSet: money("28.00"),
            },
            {
              lineItem: { id: "gid://shopify/LineItem/14000000012" },
              quantity: 1,
              restockType: "CANCEL",
              subtotalSet: money("20.00"),
            },
          ],
        },
        refundShippingLines: { nodes: [{ subtotalAmountSet: money("5.99") }] },
      },
    ]);
    expect(out).toEqual([
      {
        channelOrderId: "6200000001",
        channelRefundId: "77:14000000011",
        channelLineId: "14000000011",
        quantity: 1,
        amountCents: 2800,
        refundedAt: "2026-09-20T15:00:00.000Z",
        note: "damaged",
      },
      {
        channelOrderId: "6200000001",
        channelRefundId: "77:shipping",
        channelLineId: null,
        quantity: 1,
        amountCents: 599,
        refundedAt: "2026-09-20T15:00:00.000Z",
        note: "damaged",
      },
    ]);
  });
});
