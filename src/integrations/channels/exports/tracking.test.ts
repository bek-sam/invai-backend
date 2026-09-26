import { describe, expect, it } from "vitest";
import { buildTrackingExport, isTrackingExportChannel, type TrackingExportRow } from "./tracking";

const row = (over: Partial<TrackingExportRow> = {}): TrackingExportRow => ({
  channelOrderId: "3021456789",
  orderNo: "3021456789",
  carrier: "usps",
  service: "Priority",
  trackingCode: "9400111899223197428490",
  trackingUrl: "https://tools.usps.com/go/TrackConfirmAction?tLabels=9400111899223197428490",
  labeledAt: new Date("2026-09-24T15:00:00Z"),
  lines: [{ channelLineId: "line-1", quantity: 2 }],
  ...over,
});

describe("isTrackingExportChannel", () => {
  it("accepts only the four CSV-only (pendingApproval) channels", () => {
    expect(isTrackingExportChannel("etsy")).toBe(true);
    expect(isTrackingExportChannel("amazon")).toBe(true);
    expect(isTrackingExportChannel("tiktok")).toBe(true);
    expect(isTrackingExportChannel("walmart")).toBe(true);
    expect(isTrackingExportChannel("shopify")).toBe(false);
    expect(isTrackingExportChannel("csv")).toBe(false);
    expect(isTrackingExportChannel("ebay")).toBe(false);
  });
});

describe("buildTrackingExport", () => {
  it("Etsy: receipt_id, tracking_code, carrier_name (createReceiptShipment field names)", () => {
    const file = buildTrackingExport("etsy", [row()]);
    expect(file.contentType).toBe("text/csv");
    const [header, data] = file.body.split("\r\n");
    expect(header).toBe("receipt_id,tracking_code,carrier_name,note_to_buyer,send_bcc");
    expect(data).toBe("3021456789,9400111899223197428490,usps,,false");
  });

  it("Etsy: maps the mock/sandbox carrier to Etsy's 'other'", () => {
    const file = buildTrackingExport("etsy", [row({ carrier: "mock" })]);
    expect(file.body.split("\r\n")[1]).toContain(",other,");
  });

  it("Amazon: tab-delimited, one row per order-item line, carrier-code USPS/UPS/Other", () => {
    const file = buildTrackingExport("amazon", [
      row({
        lines: [
          { channelLineId: "111-1", quantity: 1 },
          { channelLineId: "111-2", quantity: 2 },
        ],
      }),
    ]);
    expect(file.contentType).toBe("text/tab-separated-values");
    expect(file.filename).toMatch(/\.txt$/);
    const [header, ...rows] = file.body.split("\r\n");
    expect(header).toBe(
      "order-id\torder-item-id\tquantity\tship-date\tcarrier-code\tcarrier-name\ttracking-number\tship-method",
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toBe(
      "3021456789\t111-1\t1\t2026-09-24T15:00:00.000Z\tUSPS\t\t9400111899223197428490\tPriority",
    );
    expect(rows[1]?.split("\t")[1]).toBe("111-2");
    expect(rows[1]?.split("\t")[2]).toBe("2");
  });

  it("Amazon: carrier-name is only filled when carrier-code is Other (mock carrier)", () => {
    const file = buildTrackingExport("amazon", [row({ carrier: "mock" })]);
    const cols = file.body.split("\r\n")[1]?.split("\t") ?? [];
    expect(cols[4]).toBe("Other");
    expect(cols[5]).toBe("Other (sandbox)");
  });

  it("TikTok: Order ID, Shipping Provider Name, Tracking ID", () => {
    const file = buildTrackingExport("tiktok", [row({ carrier: "ups" })]);
    const [header, data] = file.body.split("\r\n");
    expect(header).toBe("Order ID,Shipping Provider Name,Tracking ID");
    expect(data).toBe("3021456789,UPS,9400111899223197428490");
  });

  it("Walmart: PO#/Line# rows with Update Status, Carrier from the supported-names list, and a tracking URL", () => {
    const file = buildTrackingExport("walmart", [
      row({ lines: [{ channelLineId: "1", quantity: 3 }] }),
    ]);
    const [header, data] = file.body.split("\r\n");
    expect(header).toBe("PO#,Line#,Update Status,Update Qty,Carrier,Tracking Number,Tracking Url");
    expect(data).toBe(
      "3021456789,1,Shipped,3,USPS,9400111899223197428490,https://tools.usps.com/go/TrackConfirmAction?tLabels=9400111899223197428490",
    );
  });

  it("produces a header-only file when there is nothing to export", () => {
    for (const channel of ["etsy", "amazon", "tiktok", "walmart"] as const) {
      const file = buildTrackingExport(channel, []);
      expect(file.body.split("\r\n")).toHaveLength(1);
    }
  });

  it("neutralizes CSV formula injection in tracking codes (OWASP)", () => {
    const file = buildTrackingExport("etsy", [row({ trackingCode: "=cmd|' /C calc'!A1" })]);
    expect(file.body).toContain("'=cmd");
  });
});
