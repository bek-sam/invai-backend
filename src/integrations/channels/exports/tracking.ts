import type { Channel } from "@invai/contracts";
import type { Carrier } from "../../../db/schema";
import { neutralizeFormula, toCsv } from "../../../lib/csv";

/*
 * One file per CSV-only channel (Etsy, Amazon, TikTok Shop, Walmart), in that marketplace's own
 * upload format, built from shipments already labeled here. Every format below was checked
 * against the marketplace's current public documentation on 2026-09-25; sources are cited next
 * to each builder. Etsy, TikTok and Walmart have no publicly downloadable blank template (the
 * real one lives behind a Seller Center / Shop Manager login), so the column names here are
 * taken from the clearest public source for each and should be diffed against the live template
 * the first time a shop uses this export.
 */

/** One shipment's tracking, already resolved to plain values (dates, not DB rows). */
export type TrackingExportRow = {
  channelOrderId: string;
  orderNo: string;
  carrier: Carrier;
  service: string | null;
  trackingCode: string;
  trackingUrl: string | null;
  labeledAt: Date;
  /** This shipment's channel order lines, each with the unit count it covers. */
  lines: { channelLineId: string; quantity: number }[];
};

export type TrackingExportFile = {
  filename: string;
  contentType: string;
  ext: string;
  body: string;
};

const dateOnly = (d: Date) => d.toISOString().slice(0, 10);
const today = () => dateOnly(new Date());

/* --------------------------------- Etsy ---------------------------------- */
/**
 * Etsy Shop Manager has no native "upload a CSV of tracking numbers" screen; sellers add
 * tracking one receipt at a time, or through an app built on Open API v3's
 * `POST /v3/application/shops/{shop_id}/receipts/{receipt_id}/tracking`, whose body is
 * `tracking_code` (string) and `carrier_name` (string, from Etsy's fixed carrier list) —
 * https://developer.etsy.com/documentation/reference/#operation/createReceiptShipment
 * (checked 2026-09-25). Bulk-upload connector apps built on that endpoint use a CSV with those
 * same field names, e.g. 3Dsellers'
 * https://help.3dsellers.com/en/articles/4808805-how-to-upload-tracking-information-via-csv-file
 * (checked 2026-09-25): `receipt_id, tracking_code, carrier_name, note_to_buyer, send_bcc`. We
 * generate that shape so the file can be replayed through such a connector, or re-typed by hand
 * from the receipt id.
 */
const ETSY_CARRIER_NAME: Record<Carrier, string> = { usps: "usps", ups: "ups", mock: "other" };
const ETSY_HEADERS = ["receipt_id", "tracking_code", "carrier_name", "note_to_buyer", "send_bcc"];

function buildEtsyExport(rows: TrackingExportRow[]): TrackingExportFile {
  const body = toCsv(
    rows.map((r) => ({
      receipt_id: r.channelOrderId,
      tracking_code: r.trackingCode,
      carrier_name: ETSY_CARRIER_NAME[r.carrier],
      note_to_buyer: "",
      send_bcc: "false",
    })),
    ETSY_HEADERS,
  );
  return { filename: `etsy-tracking-${today()}.csv`, contentType: "text/csv", ext: "csv", body };
}

/* -------------------------------- Amazon --------------------------------- */
/**
 * Amazon's "Shipping Confirmation" flat file (Seller Central > Orders > Upload Order Related
 * Files) is a tab-delimited text file for the `POST_FLAT_FILE_FULFILLMENT_DATA` feed. Its
 * documented columns are order-id, order-item-id, quantity, ship-date, carrier-code,
 * carrier-name, ship-method and tracking-number — carrier-code and ship-method are required,
 * carrier-name only when carrier-code is "Other" (Seller Central forum, "Starting April 15,
 * 2021, we will only accept shipment confirmation that includes a CarrierCode and
 * ShippingMethod", https://sellercentral-europe.amazon.com/seller-forums/discussions/t/5719ec46c42ae4a901b3441e8772a1cc;
 * feed columns cross-checked against https://developer-docs.amazon.com/sp-api/docs/order-feed-type-values
 * and the "Confirm multiple shipments with feeds" help page,
 * https://sellercentral.amazon.com/help/hub/reference/external/G641 — all checked 2026-09-25).
 * One row per order item (line), so a multi-SKU shipment produces one row per SKU with that
 * line's shipped quantity.
 */
const AMAZON_CARRIER_CODE: Record<Carrier, string> = { usps: "USPS", ups: "UPS", mock: "Other" };
const AMAZON_CARRIER_NAME: Record<Carrier, string> = { usps: "", ups: "", mock: "Other (sandbox)" };
const AMAZON_HEADERS = [
  "order-id",
  "order-item-id",
  "quantity",
  "ship-date",
  "carrier-code",
  "carrier-name",
  "tracking-number",
  "ship-method",
];

function toTsv(rows: Record<string, unknown>[], headers: string[]): string {
  const esc = (v: unknown) => neutralizeFormula(v).replace(/\t/g, " ").replace(/\r?\n/g, " ");
  return [headers.join("\t"), ...rows.map((r) => headers.map((h) => esc(r[h])).join("\t"))].join(
    "\r\n",
  );
}

function buildAmazonExport(rows: TrackingExportRow[]): TrackingExportFile {
  const lines = rows.flatMap((r) =>
    (r.lines.length ? r.lines : [{ channelLineId: r.channelOrderId, quantity: 1 }]).map((l) => ({
      "order-id": r.channelOrderId,
      "order-item-id": l.channelLineId,
      quantity: l.quantity,
      "ship-date": r.labeledAt.toISOString(),
      "carrier-code": AMAZON_CARRIER_CODE[r.carrier],
      "carrier-name": AMAZON_CARRIER_NAME[r.carrier],
      "tracking-number": r.trackingCode,
      "ship-method": r.service || "Standard",
    })),
  );
  return {
    filename: `amazon-shipping-confirmation-${today()}.txt`,
    contentType: "text/tab-separated-values",
    ext: "txt",
    body: toTsv(lines, AMAZON_HEADERS),
  };
}

/* ------------------------------ TikTok Shop ------------------------------ */
/**
 * TikTok Shop Seller Center's bulk tracking upload (Manage Orders > Upload > pick the shipping
 * template) needs "Shipping Provider Name and Tracking ID" added to its downloaded template,
 * keyed by Order ID — https://seller-us.tiktok.com/university/essay?knowledge_id=8693445092050690
 * ("How to Process 'Shipped by Seller' Orders?", checked 2026-09-25). The live template's exact
 * column order can only be seen after downloading it from Seller Center (it sits behind login),
 * so this file carries the three columns the guide names explicitly; extra columns from the
 * downloaded template can be added back before upload if TikTok rejects a narrower file.
 */
const TIKTOK_PROVIDER_NAME: Record<Carrier, string> = { usps: "USPS", ups: "UPS", mock: "Other" };
const TIKTOK_HEADERS = ["Order ID", "Shipping Provider Name", "Tracking ID"];

function buildTiktokExport(rows: TrackingExportRow[]): TrackingExportFile {
  const body = toCsv(
    rows.map((r) => ({
      "Order ID": r.channelOrderId,
      "Shipping Provider Name": TIKTOK_PROVIDER_NAME[r.carrier],
      "Tracking ID": r.trackingCode,
    })),
    TIKTOK_HEADERS,
  );
  return { filename: `tiktok-tracking-${today()}.csv`, contentType: "text/csv", ext: "csv", body };
}

/* -------------------------------- Walmart --------------------------------- */
/**
 * Walmart Seller Center's order file has re-upload columns for exactly this: "Update Status"
 * (set to Shipped), "Update Qty", "Carrier", "Tracking Number" and "Tracking Url" against each
 * PO#/Line# — https://marketplacelearn.walmart.com/ca/guides/Order%20management/Order%20status/manage-order-status--bulk-order-updates
 * and https://marketplacelearn.walmart.com/guides/Order%20management/Order%20status/Update-tracking-numbers-in-Seller-Center
 * (checked 2026-09-25). `Carrier` must be an exact name from Walmart's supported list
 * (https://developer.walmart.com/us-marketplace/docs/supported-carrier-names, checked
 * 2026-09-25); a carrier outside that list uses "Other" and must then also carry the tracking
 * URL, which we always include. One row per PO#/Line#.
 */
const WALMART_CARRIER: Record<Carrier, string> = { usps: "USPS", ups: "UPS", mock: "Other" };
const WALMART_HEADERS = [
  "PO#",
  "Line#",
  "Update Status",
  "Update Qty",
  "Carrier",
  "Tracking Number",
  "Tracking Url",
];

function buildWalmartExport(rows: TrackingExportRow[]): TrackingExportFile {
  const lines = rows.flatMap((r) =>
    (r.lines.length ? r.lines : [{ channelLineId: "1", quantity: 1 }]).map((l) => ({
      "PO#": r.channelOrderId,
      "Line#": l.channelLineId,
      "Update Status": "Shipped",
      "Update Qty": l.quantity,
      Carrier: WALMART_CARRIER[r.carrier],
      "Tracking Number": r.trackingCode,
      "Tracking Url": r.trackingUrl ?? "",
    })),
  );
  return {
    filename: `walmart-shipment-update-${today()}.csv`,
    contentType: "text/csv",
    ext: "csv",
    body: toCsv(lines, WALMART_HEADERS),
  };
}

/** CSV-only channels this export supports (the pendingApproval adapters). */
export const TRACKING_EXPORT_CHANNELS = ["etsy", "amazon", "tiktok", "walmart"] as const;
export type TrackingExportChannel = (typeof TRACKING_EXPORT_CHANNELS)[number];

export function isTrackingExportChannel(channel: Channel): channel is TrackingExportChannel {
  return (TRACKING_EXPORT_CHANNELS as readonly string[]).includes(channel);
}

export function buildTrackingExport(
  channel: TrackingExportChannel,
  rows: TrackingExportRow[],
): TrackingExportFile {
  switch (channel) {
    case "etsy":
      return buildEtsyExport(rows);
    case "amazon":
      return buildAmazonExport(rows);
    case "tiktok":
      return buildTiktokExport(rows);
    case "walmart":
      return buildWalmartExport(rows);
  }
}
