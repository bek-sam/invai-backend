import type { Channel, CsvFormat, NormalizedOrder, PersonalizationAnswer } from "@invai/contracts";
import { parseCsv } from "../../../lib/csv";
import type { ChannelHold, ChannelLineCancel, ChannelRefund } from "../types";

/*
 * Marketplace CSV exports -> NormalizedOrder. One parser per export format, using each
 * marketplace's real column names; headers are matched loosely (case, spaces, punctuation and
 * a few known aliases), so older and newer export versions both work. Every data row is
 * validated on its own: bad rows land in `errors` with their line number and the rest import.
 */

export type CsvRowError = { row: number; message: string };

export type ParsedCsv = {
  orders: NormalizedOrder[];
  /** Orders the export lists as cancelled (not imported; cancels existing ones). */
  cancelledChannelOrderIds: string[];
  /** First line number of each order in `orders` (for error reporting at import time). */
  orderRows: number[];
  rowsTotal: number;
  errors: CsvRowError[];
  /** T-7-2: refunds the export lists (Shopify "Refunded Amount", TikTok "Order Refund Amount",
   * generic `refund_amount`), one order-level refund per order, before tax. */
  refunds?: ChannelRefund[];
  /** T-7-4: orders to hold (TikTok "On hold", Amazon buyer-requested cancellation). */
  holds?: ChannelHold[];
  /** T-7-4: single lines the export lists as cancelled while the order stands (Walmart). */
  cancelledLines?: ChannelLineCancel[];
};

export class CsvFormatError extends Error {}

/* ------------------------------------ table reading ------------------------------------ */

const normHeader = (h: string) => h.toLowerCase().replace(/[^a-z0-9#]/g, "");

type Row = {
  line: number;
  get: (...names: string[]) => string;
  has: (...names: string[]) => boolean;
};

/** Parse CSV or TSV (Amazon reports are tab-delimited, unquoted). */
export function readTable(text: string): { headers: string[]; rows: Row[] } {
  const src = text.replace(/^﻿/, "");
  const firstLine = src.slice(0, src.search(/\r?\n|$/));
  const isTsv = (firstLine.match(/\t/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0);
  let table: string[][];
  let lines: number[];
  if (isTsv) {
    const raw = src.split(/\r?\n/);
    table = [];
    lines = [];
    raw.forEach((l, i) => {
      if (l.trim() === "") return;
      table.push(l.split("\t"));
      lines.push(i + 1);
    });
  } else {
    table = parseCsv(src);
    // parseCsv drops blank rows; quoted newlines are rare in exports, so count by position.
    lines = table.map((_, i) => i + 1);
  }
  const [header, ...body] = table;
  if (!header) return { headers: [], rows: [] };
  const headers = header.map((h) => h.trim());
  const index = new Map<string, number>();
  headers.forEach((h, i) => {
    const k = normHeader(h);
    if (!index.has(k)) index.set(k, i);
  });
  const find = (names: string[]) => {
    for (const n of names) {
      const i = index.get(normHeader(n));
      if (i !== undefined) return i;
    }
    return -1;
  };
  const rows = body.map((cells, bi) => ({
    line: lines[bi + 1] ?? bi + 2,
    get: (...names: string[]) => {
      const i = find(names);
      return i >= 0 ? (cells[i] ?? "").trim() : "";
    },
    has: (...names: string[]) => find(names) >= 0,
  }));
  return { headers, rows };
}

function requireColumns(headers: string[], format: string, groups: string[][]) {
  const have = new Set(headers.map(normHeader));
  const missing = groups.filter((g) => !g.some((n) => have.has(normHeader(n)))).map((g) => g[0]);
  if (missing.length)
    throw new CsvFormatError(
      `This does not look like a ${format} export: missing column(s) ${missing.map((m) => `"${m}"`).join(", ")}`,
    );
}

/* ------------------------------------ value parsing ------------------------------------ */

export function money(v: string): number | null {
  if (!v) return null;
  let s = v.replace(/[A-Z]{3}\s*/g, "").replace(/[$€£\s]/g, "");
  const negative = /^\(.*\)$/.test(s) || s.startsWith("-");
  s = s.replace(/[()-]/g, "");
  if (/^\d{1,3}(\.\d{3})*,\d{2}$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  else s = s.replace(/,/g, "");
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) * (negative ? -1 : 1);
}

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

/**
 * Tolerant date parser: ISO 8601, `MM/DD/YY(YY)[ hh:mm[:ss][ AM|PM]]`, `YYYY-MM-DD hh:mm:ss`,
 * `Sep 22, 2026`, `22-Sep-2026`. Times without an offset are read as UTC. A date without a time
 * becomes 12:00 UTC (the same calendar day in every US timezone); the importer treats a
 * channel ship-by at exactly 12:00:00.000Z as "by the end of that day" in the shop's timezone.
 */
export const DATE_ONLY_HOUR = "12";

export function parseDate(v: string): Date | null {
  const s = v.trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}T/.test(s) || /[+-]\d{2}:?\d{2}$|Z$/.test(s)) {
    const d = new Date(s.replace(/ ([+-]\d{2})(\d{2})$/, "$1:$2"));
    if (!Number.isNaN(d.getTime())) return d;
  }
  const n = (m: RegExpExecArray, i: number) => Number(m[i] ?? Number.NaN);
  const month = (m: RegExpExecArray, i: number) => MONTHS[(m[i] ?? "").toLowerCase()];
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (m) return utc(n(m, 1), n(m, 2), n(m, 3), m[4] ?? DATE_ONLY_HOUR, m[5], m[6]);
  m =
    /^(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})(?:[ ,T]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM|am|pm)?)?/.exec(
      s,
    );
  if (m) {
    let y = n(m, 3);
    if (y < 100) y += 2000;
    if (!m[4]) return utc(y, n(m, 1), n(m, 2), DATE_ONLY_HOUR);
    let h = Number(m[4]);
    if (m[7]) h = (h % 12) + (/pm/i.test(m[7]) ? 12 : 0);
    return utc(y, n(m, 1), n(m, 2), String(h), m[5], m[6]);
  }
  m = /^([A-Za-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4})/.exec(s);
  const mo1 = m ? month(m, 1) : undefined;
  if (m && mo1) return utc(n(m, 3), mo1, n(m, 2), DATE_ONLY_HOUR);
  m = /^(\d{1,2})[- ]([A-Za-z]{3})[a-z]*[- ](\d{4})/.exec(s);
  const mo2 = m ? month(m, 2) : undefined;
  if (m && mo2) return utc(n(m, 3), mo2, n(m, 1), DATE_ONLY_HOUR);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function utc(y: number, mo: number, d: number, h?: string, mi?: string, se?: string): Date | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, mo - 1, d, h ? +h : 0, mi ? +mi : 0, se ? +se : 0));
  return Number.isNaN(date.getTime()) ? null : date;
}

const intQty = (v: string) => {
  const n = Number(v.replace(/[^\d.-]/g, ""));
  return Number.isInteger(n) ? n : Number.NaN;
};

const emailOrNull = (v: string) => (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) ? v : null);

const country2 = (v: string) => {
  const s = v.trim();
  if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase();
  if (/^(united states|usa|us|united states of america)$/i.test(s) || !s) return "US";
  if (/^canada$/i.test(s)) return "CA";
  return s.slice(0, 2).toUpperCase();
};

/** `Color: Black, Size: M, Personalization: Ashley` (Etsy) or `Black / M` (Shopify). */
function parseVariations(
  v: string,
  allPersonalization = false,
): { attrs: Record<string, string>; personalization: PersonalizationAnswer[] } {
  const attrs: Record<string, string> = {};
  const personalization: PersonalizationAnswer[] = [];
  if (!v) return { attrs, personalization };
  const parts = v.split(/,(?=[^,:]+:)|\n|;/);
  for (const p of parts) {
    const idx = p.indexOf(":");
    if (idx < 0) continue;
    const key = p.slice(0, idx).trim();
    const value = p.slice(idx + 1).trim();
    if (!key) continue;
    const isOption = /^(color|colour|primary color|size|style)$/i.test(key);
    if (!isOption && (allPersonalization || /personali[sz]ation|custom|name|text/i.test(key)))
      personalization.push({ question: key, answer: value || null, fileUrl: null });
    else attrs[key.toLowerCase()] = value;
  }
  return { attrs, personalization };
}

/* ------------------------------------ order assembly ------------------------------------ */

type Draft = {
  firstLine: number;
  order: Omit<NormalizedOrder, "items" | "totals"> & {
    totals: Partial<NormalizedOrder["totals"]>;
  };
  items: NormalizedOrder["items"];
  itemTotal: number;
};

function newCollector() {
  const drafts = new Map<string, Draft>();
  const errors: CsvRowError[] = [];
  const cancelled = new Set<string>();
  const holds = new Map<string, ChannelHold>();
  const cancelledLines: ChannelLineCancel[] = [];
  const refundTotals = new Map<string, { cents: number; at: string | null; taxInside: boolean }>();
  return {
    drafts,
    errors,
    cancelled,
    cancelledLines,
    hold(channelOrderId: string, signal: ChannelHold["signal"]) {
      holds.set(`${channelOrderId}|${signal}`, { channelOrderId, signal });
    },
    fail(row: Row, message: string) {
      errors.push({ row: row.line, message });
    },
    /** An order's refunded total (the first non-zero value wins; exports repeat it per line). */
    refund(orderId: string, raw: string, at: Date | null, taxInside: boolean) {
      const cents = Math.abs(money(raw) ?? 0);
      if (cents > 0 && !refundTotals.has(orderId))
        refundTotals.set(orderId, { cents, at: at?.toISOString() ?? null, taxInside });
    },
    finish(): Omit<ParsedCsv, "rowsTotal"> {
      const orders: NormalizedOrder[] = [];
      const orderRows: number[] = [];
      const refunds: ChannelRefund[] = [];
      for (const [id, d] of drafts) {
        if (cancelled.has(id)) continue;
        if (d.items.length === 0) continue;
        const subtotal = d.order.totals.subtotal ?? d.itemTotal;
        const shipping = d.order.totals.shipping ?? 0;
        const tax = d.order.totals.tax ?? 0;
        const discount = Math.abs(d.order.totals.discount ?? 0);
        orders.push({
          ...d.order,
          totals: {
            subtotal,
            shipping,
            tax,
            discount,
            total: d.order.totals.total ?? subtotal + shipping + tax - discount,
          },
          items: d.items,
        });
        orderRows.push(d.firstLine);
        const r = refundTotals.get(id);
        const o = orders[orders.length - 1];
        if (r && o) {
          // Refund totals that include sales tax: take out the order's tax share.
          const { total, tax } = o.totals;
          const exTax =
            r.taxInside && tax > 0 && total > 0
              ? Math.round((r.cents * (total - tax)) / total)
              : r.cents;
          if (exTax > 0)
            refunds.push({
              channelOrderId: id,
              channelRefundId: `${id}:csv-refund`,
              channelLineId: null,
              quantity: 1,
              amountCents: Math.min(exTax, Math.max(0, total - tax)),
              refundedAt: r.at,
              note: "From the order export",
            });
        }
      }
      // A line cancel whose order has no line left cancels the whole order instead.
      const live = new Set(orders.map((o) => o.channelOrderId));
      for (const l of cancelledLines)
        if (!live.has(l.channelOrderId)) cancelled.add(l.channelOrderId);
      return {
        orders,
        orderRows,
        cancelledChannelOrderIds: [...cancelled],
        errors,
        refunds,
        holds: [...holds.values()].filter((h) => live.has(h.channelOrderId)),
        cancelledLines: cancelledLines.filter((l) => live.has(l.channelOrderId)),
      };
    },
  };
}

type Collector = ReturnType<typeof newCollector>;

function addLine(
  c: Collector,
  row: Row,
  orderId: string,
  makeOrder: () => Draft["order"],
  line: {
    lineId: string;
    sku: string;
    listingId: string | null;
    title: string;
    variantTitle: string | null;
    quantity: number;
    unitPrice: number;
    personalization: PersonalizationAnswer[];
  },
) {
  let d = c.drafts.get(orderId);
  if (!d) {
    d = { firstLine: row.line, order: makeOrder(), items: [], itemTotal: 0 };
    c.drafts.set(orderId, d);
  }
  const existing = d.items.find((i) => i.channelLineId === line.lineId);
  if (existing) {
    // The same line listed twice (re-exported rows): keep the first.
    return;
  }
  d.items.push({
    channelLineId: line.lineId,
    channelSku: line.sku,
    channelListingId: line.listingId,
    title: line.title || line.sku || "Item",
    variantTitle: line.variantTitle,
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    personalization: line.personalization,
  });
  d.itemTotal += line.unitPrice * line.quantity;
}

function checkQty(c: Collector, row: Row, raw: string): number | null {
  if (!raw) {
    c.fail(row, "Missing quantity");
    return null;
  }
  const q = intQty(raw);
  if (!Number.isInteger(q) || q < 1) {
    c.fail(row, `Invalid quantity "${raw}"`);
    return null;
  }
  if (q > 500) {
    c.fail(row, `Quantity ${q} looks wrong (over 500 units)`);
    return null;
  }
  return q;
}

function requireDate(c: Collector, row: Row, raw: string, what: string): Date | null {
  const d = parseDate(raw);
  if (!d) c.fail(row, raw ? `Unreadable ${what} "${raw}"` : `Missing ${what}`);
  return d;
}

/* ------------------------------------ Etsy ------------------------------------ */

/**
 * Etsy "Sold Order Items" export (Shop Manager > Settings > Options > Download Data): one row
 * per transaction with Sale Date, Item Name, Buyer, Quantity, Price, Discount Amount, Delivery
 * (Shipping), Item Total, Transaction ID, Listing ID, Ship Name/Address1/..., Order ID,
 * Variations, SKU. The "Sold Orders" file (order-level only) is rejected with a hint.
 */
function parseEtsy(text: string): ParsedCsv {
  const { headers, rows } = readTable(text);
  if (
    !headers.some((h) => /item name|transaction id/i.test(h)) &&
    headers.some((h) => /number of items/i.test(h))
  )
    throw new CsvFormatError(
      'This is Etsy\'s "Sold Orders" file; upload "Sold Order Items" (it has the item lines)',
    );
  requireColumns(headers, "Etsy Sold Order Items", [
    ["Order ID"],
    ["Sale Date"],
    ["Item Name"],
    ["Quantity"],
  ]);
  const c = newCollector();
  for (const row of rows) {
    const orderId = row.get("Order ID");
    if (!orderId) {
      c.fail(row, "Missing Order ID");
      continue;
    }
    const placedAt = requireDate(c, row, row.get("Sale Date", "Date Paid"), "Sale Date");
    const qty = checkQty(c, row, row.get("Quantity"));
    if (!placedAt || qty === null) continue;
    const price = money(row.get("Price")) ?? 0;
    const { attrs, personalization } = parseVariations(row.get("Variations"));
    const variantTitle =
      [attrs.color ?? attrs.colour ?? attrs["primary color"], attrs.size]
        .filter(Boolean)
        .join(" / ") || null;
    const buyerName = row.get("Ship Name", "Buyer", "Full Name") || "Etsy buyer";
    addLine(
      c,
      row,
      orderId,
      () => ({
        channel: "etsy",
        channelOrderId: orderId,
        orderNo: orderId,
        placedAt: placedAt.toISOString(),
        sourceUpdatedAt: null,
        shipBy: null,
        isRush: /express|priority|rush/i.test(row.get("Shipping Method", "Delivery Method")),
        buyerName,
        buyerEmail: emailOrNull(row.get("Buyer Email", "Email")),
        shipTo: row.get("Ship Address1", "Street 1")
          ? {
              name: buyerName,
              company: null,
              street1: row.get("Ship Address1", "Street 1"),
              street2: row.get("Ship Address2", "Street 2") || null,
              city: row.get("Ship City"),
              state: row.get("Ship State"),
              zip: row.get("Ship Zipcode", "Ship Zip"),
              country: country2(row.get("Ship Country")),
              phone: null,
              email: null,
            }
          : null,
        shippingMethod: row.get("Shipping Method", "Delivery Method") || null,
        totals: {
          shipping: money(row.get("Order Shipping", "Order Delivery")) ?? undefined,
          tax: money(row.get("Order Sales Tax")) ?? undefined,
        },
        buyerNote: row.get("Message from buyer", "Note from buyer") || null,
      }),
      {
        lineId: row.get("Transaction ID") || `${orderId}-${row.line}`,
        sku: row.get("SKU"),
        listingId: row.get("Listing ID") || null,
        title: row.get("Item Name"),
        variantTitle,
        quantity: qty,
        unitPrice: price,
        personalization,
      },
    );
    // Per-line shipping/discount columns: roll them up when the order-level ones are absent.
    const d = c.drafts.get(orderId);
    if (d && !row.has("Order Shipping", "Order Delivery")) {
      const ship = money(row.get("Delivery", "Shipping")) ?? 0;
      d.order.totals.shipping = (d.order.totals.shipping ?? 0) + ship;
    }
    if (d) {
      const disc = Math.abs(money(row.get("Discount Amount")) ?? 0);
      d.order.totals.discount = (d.order.totals.discount ?? 0) + disc;
      if (!row.has("Order Sales Tax")) {
        const tax = money(row.get("Sales Tax", "VAT Paid by Buyer")) ?? 0;
        d.order.totals.tax = (d.order.totals.tax ?? 0) + tax;
      }
    }
  }
  return { ...c.finish(), rowsTotal: rows.length };
}

/* ------------------------------------ Amazon ------------------------------------ */

/**
 * Amazon "Unshipped Orders" / "New Orders" report (tab-delimited): order-id, order-item-id,
 * purchase-date, promise-date (latest ship date), buyer-email, buyer-name, sku, product-name,
 * quantity-purchased / quantity-to-ship, ship-service-level, recipient-name, ship-address-1..3,
 * ship-city, ship-state, ship-postal-code, ship-country, item-price, item-tax, shipping-price,
 * is-prime, customized-url.
 */
function parseAmazon(text: string): ParsedCsv {
  const { headers, rows } = readTable(text);
  requireColumns(headers, "Amazon Unshipped Orders", [
    ["order-id"],
    ["order-item-id"],
    ["purchase-date"],
    ["sku"],
    ["quantity-to-ship", "quantity-purchased"],
  ]);
  const c = newCollector();
  for (const row of rows) {
    const orderId = row.get("order-id");
    if (!orderId) {
      c.fail(row, "Missing order-id");
      continue;
    }
    const placedAt = requireDate(c, row, row.get("purchase-date"), "purchase-date");
    const qty = checkQty(c, row, row.get("quantity-to-ship", "quantity-purchased"));
    if (!placedAt || qty === null) continue;
    if (
      /^(true|yes|y)$/i.test(
        row.get("is-buyer-requested-cancellation", "is-buyer-requested-cancel"),
      )
    )
      c.hold(orderId, "buyer_cancel_request");
    const shipBy = parseDate(row.get("promise-date", "latest-ship-date", "ship-by-date"));
    const itemPrice = money(row.get("item-price"));
    const serviceLevel = row.get("ship-service-level");
    const customizedUrl = row.get("customized-url");
    const recipient = row.get("recipient-name", "buyer-name") || "Amazon buyer";
    addLine(
      c,
      row,
      orderId,
      () => ({
        channel: "amazon",
        channelOrderId: orderId,
        orderNo: orderId,
        placedAt: placedAt.toISOString(),
        sourceUpdatedAt: null,
        shipBy: shipBy?.toISOString() ?? null,
        isRush:
          /expedited|priority|nextday|next day|secondday|second day|sameday/i.test(serviceLevel) ||
          row.get("is-prime").toLowerCase() === "true",
        buyerName: recipient,
        buyerEmail: emailOrNull(row.get("buyer-email")),
        shipTo: row.get("ship-address-1")
          ? {
              name: recipient,
              company: null,
              street1: row.get("ship-address-1"),
              street2:
                [row.get("ship-address-2"), row.get("ship-address-3")].filter(Boolean).join(", ") ||
                null,
              city: row.get("ship-city"),
              state: row.get("ship-state"),
              zip: row.get("ship-postal-code"),
              country: country2(row.get("ship-country")),
              phone: row.get("buyer-phone-number", "ship-phone-number") || null,
              email: null,
            }
          : null,
        shippingMethod: serviceLevel || null,
        totals: {},
        buyerNote: row.get("delivery-Instructions", "gift-message-text") || null,
      }),
      {
        lineId: row.get("order-item-id"),
        sku: row.get("sku"),
        listingId: row.get("asin") || null,
        title: row.get("product-name"),
        variantTitle: null,
        quantity: qty,
        // Amazon's item-price is the line total.
        unitPrice: itemPrice !== null ? Math.round(itemPrice / qty) : 0,
        personalization: /^https?:\/\//.test(customizedUrl)
          ? [
              {
                question: "Amazon Custom",
                answer: row.get("customized-page") || null,
                fileUrl: customizedUrl,
              },
            ]
          : [],
      },
    );
    const d = c.drafts.get(orderId);
    if (d) {
      d.order.totals.shipping =
        (d.order.totals.shipping ?? 0) + (money(row.get("shipping-price")) ?? 0);
      d.order.totals.tax =
        (d.order.totals.tax ?? 0) +
        (money(row.get("item-tax")) ?? 0) +
        (money(row.get("shipping-tax")) ?? 0);
      d.order.totals.discount =
        (d.order.totals.discount ?? 0) + Math.abs(money(row.get("item-promotion-discount")) ?? 0);
    }
  }
  return { ...c.finish(), rowsTotal: rows.length };
}

/* ------------------------------------ TikTok Shop ------------------------------------ */

/**
 * TikTok Shop Seller Center order export: Order ID, Order Status, SKU ID, Seller SKU, Product
 * Name, Variation, Quantity, SKU Unit Original Price, SKU Subtotal After Discount, Shipping Fee
 * After Discount, Taxes, Order Amount, Created Time, Paid Time, Buyer Message, Recipient,
 * Phone #, Zipcode, Country, State, City, Detail Address, Additional address information.
 */
function parseTiktok(text: string): ParsedCsv {
  const { headers, rows } = readTable(text);
  requireColumns(headers, "TikTok Shop orders", [
    ["Order ID"],
    ["Seller SKU", "SKU"],
    ["Quantity"],
    ["Created Time", "Paid Time"],
  ]);
  const c = newCollector();
  for (const row of rows) {
    const orderId = row.get("Order ID").replace(/^'/, "");
    // TikTok exports put a description row under the header ("Platform unique order ID.").
    if (!orderId || !/\d/.test(orderId)) {
      if (orderId) continue;
      c.fail(row, "Missing Order ID");
      continue;
    }
    const status = row.get("Order Status").toLowerCase();
    if (/cancel/.test(status)) {
      c.cancelled.add(orderId);
      continue;
    }
    if (/on.?hold/.test(status)) c.hold(orderId, "channel_on_hold");
    const placedAt = requireDate(c, row, row.get("Paid Time", "Created Time"), "Created Time");
    const qty = checkQty(c, row, row.get("Quantity"));
    if (!placedAt || qty === null) continue;
    c.refund(orderId, row.get("Order Refund Amount"), null, true);
    const unit =
      money(row.get("SKU Subtotal After Discount")) !== null
        ? Math.round((money(row.get("SKU Subtotal After Discount")) as number) / qty)
        : (money(row.get("SKU Unit Original Price")) ?? 0);
    const recipient = row.get("Recipient") || row.get("Buyer Username") || "TikTok buyer";
    const shipByRaw = row.get("Ship By Time", "Latest Ship Time", "Shipping Due Time");
    addLine(
      c,
      row,
      orderId,
      () => ({
        channel: "tiktok",
        channelOrderId: orderId,
        orderNo: orderId,
        placedAt: placedAt.toISOString(),
        sourceUpdatedAt: null,
        shipBy: parseDate(shipByRaw)?.toISOString() ?? null,
        isRush: false,
        buyerName: recipient,
        buyerEmail: null,
        shipTo: row.get("Detail Address")
          ? {
              name: recipient,
              company: null,
              street1: row.get("Detail Address"),
              street2: row.get("Additional address information") || null,
              city: row.get("City"),
              state: row.get("State"),
              zip: row.get("Zipcode"),
              country: country2(row.get("Country")),
              phone: row.get("Phone #") || null,
              email: null,
            }
          : null,
        shippingMethod: row.get("Delivery Option", "Shipping Provider Name") || null,
        totals: {
          shipping: money(row.get("Shipping Fee After Discount")) ?? undefined,
          tax: money(row.get("Taxes")) ?? undefined,
          total: money(row.get("Order Amount")) ?? undefined,
        },
        buyerNote: row.get("Buyer Message") || null,
      }),
      {
        lineId: row.get("SKU ID") ? `${row.get("SKU ID")}-${row.line}` : `${orderId}-${row.line}`,
        sku: row.get("Seller SKU", "SKU"),
        listingId: row.get("Product ID") || null,
        title: row.get("Product Name"),
        variantTitle: row.get("Variation") || null,
        quantity: qty,
        unitPrice: unit,
        personalization: [],
      },
    );
  }
  return { ...c.finish(), rowsTotal: rows.length };
}

/* ------------------------------------ Walmart ------------------------------------ */

/**
 * Walmart Seller Center order export: PO#, Order#, Order Date, Ship By, Customer Name, Ship to
 * Address 1/2, City, State, Zip, Line#, Status, Item Description, Shipping Method, Qty, SKU,
 * Item Cost, Shipping Cost, Tax. The purchase order (PO#) is what ships and takes tracking.
 */
function parseWalmart(text: string): ParsedCsv {
  const { headers, rows } = readTable(text);
  requireColumns(headers, "Walmart orders", [
    ["PO#", "PO Number"],
    ["Order Date"],
    ["SKU"],
    ["Qty", "Quantity"],
  ]);
  const c = newCollector();
  for (const row of rows) {
    const po = row.get("PO#", "PO Number");
    if (!po) {
      c.fail(row, "Missing PO#");
      continue;
    }
    if (/cancel/i.test(row.get("Status"))) {
      // Only this line (T-7-4); `finish` cancels the PO when no line is left.
      c.cancelledLines.push({
        channelOrderId: po,
        channelLineId: `${po}-${row.get("Line#", "Line Number") || row.line}`,
      });
      continue;
    }
    const placedAt = requireDate(c, row, row.get("Order Date"), "Order Date");
    const qty = checkQty(c, row, row.get("Qty", "Quantity"));
    if (!placedAt || qty === null) continue;
    const name = row.get("Customer Name") || "Walmart customer";
    const method = row.get("Shipping Method", "Shipping Tier");
    addLine(
      c,
      row,
      po,
      () => ({
        channel: "walmart",
        channelOrderId: po,
        orderNo: row.get("Order#", "Customer Order ID") || po,
        placedAt: placedAt.toISOString(),
        sourceUpdatedAt: null,
        shipBy: parseDate(row.get("Ship By", "Ship By Date"))?.toISOString() ?? null,
        isRush: /express|next ?day|two ?day|2-day|rush/i.test(method),
        buyerName: name,
        buyerEmail: null,
        shipTo: row.get("Ship to Address 1")
          ? {
              name,
              company: null,
              street1: row.get("Ship to Address 1"),
              street2: row.get("Ship to Address 2") || null,
              city: row.get("City"),
              state: row.get("State"),
              zip: row.get("Zip"),
              country: "US",
              phone: row.get("Customer Phone Number") || null,
              email: null,
            }
          : null,
        shippingMethod: method || null,
        totals: {},
        buyerNote: null,
      }),
      {
        lineId: `${po}-${row.get("Line#", "Line Number") || row.line}`,
        sku: row.get("SKU"),
        listingId: row.get("Item ID", "UPC") || null,
        title: row.get("Item Description"),
        variantTitle: null,
        quantity: qty,
        unitPrice: Math.round(
          (money(row.get("Item Cost")) ?? 0) / (row.has("Item Cost") ? qty : 1),
        ),
        personalization: [],
      },
    );
    const d = c.drafts.get(po);
    if (d) {
      d.order.totals.shipping =
        (d.order.totals.shipping ?? 0) + (money(row.get("Shipping Cost")) ?? 0);
      d.order.totals.tax = (d.order.totals.tax ?? 0) + (money(row.get("Tax")) ?? 0);
    }
  }
  return { ...c.finish(), rowsTotal: rows.length };
}

/* ------------------------------------ Shopify ------------------------------------ */

/**
 * Shopify admin "Export orders" CSV: one row per line item; order-level columns (Email,
 * Financial Status, Subtotal, Shipping, Taxes, Total, Discount Amount, Shipping Method,
 * Created at, Shipping Name/Address1/..., Notes, Cancelled at, Id) are only filled on the first
 * row of each order. `Name` is the order number (#1001), `Id` the order id the API uses.
 */
function parseShopify(text: string): ParsedCsv {
  const { headers, rows } = readTable(text);
  requireColumns(headers, "Shopify orders", [
    ["Name"],
    ["Lineitem quantity"],
    ["Lineitem name"],
    ["Lineitem sku"],
  ]);
  const c = newCollector();
  const firstRow = new Map<string, Row>();
  for (const row of rows) {
    const name = row.get("Name");
    if (!name) {
      c.fail(row, "Missing Name (order number)");
      continue;
    }
    if (!firstRow.has(name)) firstRow.set(name, row);
    const head = firstRow.get(name) as Row;
    const id = head.get("Id") || name;
    if (head.get("Cancelled at")) {
      c.cancelled.add(id);
      continue;
    }
    const placedAt = requireDate(c, row, head.get("Created at", "Paid at"), "Created at");
    c.refund(id, head.get("Refunded Amount"), null, true);
    const qty = checkQty(c, row, row.get("Lineitem quantity"));
    if (!placedAt || qty === null) continue;
    const lineName = row.get("Lineitem name");
    const dash = lineName.lastIndexOf(" - ");
    const buyer = head.get("Shipping Name", "Billing Name") || "Shopify customer";
    const method = head.get("Shipping Method");
    addLine(
      c,
      row,
      id,
      () => ({
        channel: "shopify",
        channelOrderId: id,
        orderNo: name,
        placedAt: placedAt.toISOString(),
        sourceUpdatedAt: null,
        shipBy: null,
        isRush: /express|rush|overnight|priority/i.test(method),
        buyerName: buyer,
        buyerEmail: emailOrNull(head.get("Email")),
        shipTo: head.get("Shipping Address1", "Shipping Street")
          ? {
              name: buyer,
              company: head.get("Shipping Company") || null,
              street1: head.get("Shipping Address1", "Shipping Street"),
              street2: head.get("Shipping Address2") || null,
              city: head.get("Shipping City"),
              state: head.get("Shipping Province"),
              zip: head.get("Shipping Zip").replace(/^'/, ""),
              country: country2(head.get("Shipping Country")),
              phone: head.get("Shipping Phone", "Phone") || null,
              email: null,
            }
          : null,
        shippingMethod: method || null,
        totals: {
          subtotal: money(head.get("Subtotal")) ?? undefined,
          shipping: money(head.get("Shipping")) ?? undefined,
          tax: money(head.get("Taxes")) ?? undefined,
          discount: money(head.get("Discount Amount")) ?? undefined,
          total: money(head.get("Total")) ?? undefined,
        },
        buyerNote: head.get("Notes") || null,
      }),
      {
        lineId: `${id}-${row.line}`,
        sku: row.get("Lineitem sku"),
        listingId: null,
        title: dash > 0 ? lineName.slice(0, dash) : lineName,
        variantTitle: dash > 0 ? lineName.slice(dash + 3) : null,
        quantity: qty,
        unitPrice: money(row.get("Lineitem price")) ?? 0,
        personalization: parseVariations(
          row.get("Lineitem properties", "Note Attributes").replace(/\n/g, ","),
        ).personalization,
      },
    );
  }
  return { ...c.finish(), rowsTotal: rows.length };
}

/* ------------------------------------ Generic ------------------------------------ */

/**
 * InvAI's generic template for anything else: order_id, order_no, placed_at, ship_by,
 * buyer_name, buyer_email, ship_name, address1, address2, city, state, zip, country, phone, sku,
 * title, variant, quantity, unit_price, shipping, tax, discount, total, note, personalization,
 * rush. Order-level values are read from the order's first row.
 */
function parseGeneric(text: string, channel: Channel): ParsedCsv {
  const { headers, rows } = readTable(text);
  requireColumns(headers, "generic order CSV", [
    ["order_id", "order id", "order number"],
    ["sku"],
    ["quantity", "qty"],
  ]);
  const c = newCollector();
  for (const row of rows) {
    const orderId = row.get("order_id", "order id", "order number");
    if (!orderId) {
      c.fail(row, "Missing order_id");
      continue;
    }
    if (/cancel/i.test(row.get("status"))) {
      c.cancelled.add(orderId);
      continue;
    }
    const placedRaw = row.get("placed_at", "order date", "created_at", "date");
    const placedAt = placedRaw ? requireDate(c, row, placedRaw, "placed_at") : new Date();
    c.refund(
      orderId,
      row.get("refund_amount", "refunded amount"),
      parseDate(row.get("refunded_at", "refund date")),
      false,
    );
    const qty = checkQty(c, row, row.get("quantity", "qty"));
    if (!placedAt || qty === null) continue;
    const buyer = row.get("buyer_name", "ship_name", "customer", "name") || "Customer";
    const personalization = row.get("personalization", "custom text");
    addLine(
      c,
      row,
      orderId,
      () => ({
        channel,
        channelOrderId: orderId,
        orderNo: row.get("order_no", "order number") || orderId,
        placedAt: placedAt.toISOString(),
        sourceUpdatedAt: null,
        shipBy: parseDate(row.get("ship_by", "ship by"))?.toISOString() ?? null,
        isRush: /^(1|true|yes|y)$/i.test(row.get("rush", "is_rush")),
        buyerName: buyer,
        buyerEmail: emailOrNull(row.get("buyer_email", "email")),
        shipTo: row.get("address1", "street1", "address")
          ? {
              name: row.get("ship_name") || buyer,
              company: row.get("company") || null,
              street1: row.get("address1", "street1", "address"),
              street2: row.get("address2", "street2") || null,
              city: row.get("city"),
              state: row.get("state", "province"),
              zip: row.get("zip", "postal_code", "postcode"),
              country: country2(row.get("country")),
              phone: row.get("phone") || null,
              email: null,
            }
          : null,
        shippingMethod: row.get("shipping_method", "service") || null,
        totals: {
          shipping: money(row.get("shipping")) ?? undefined,
          tax: money(row.get("tax")) ?? undefined,
          discount: money(row.get("discount")) ?? undefined,
          total: money(row.get("total")) ?? undefined,
        },
        buyerNote: row.get("note", "notes", "buyer_note") || null,
      }),
      {
        lineId: row.get("line_id", "item_id") || `${orderId}-${row.line}`,
        sku: row.get("sku"),
        listingId: row.get("listing_id") || null,
        title: row.get("title", "product", "item"),
        variantTitle: row.get("variant", "variation") || null,
        quantity: qty,
        unitPrice: money(row.get("unit_price", "price")) ?? 0,
        personalization: personalization
          ? parseVariations(personalization, true).personalization.length
            ? parseVariations(personalization, true).personalization
            : [{ question: "Personalization", answer: personalization, fileUrl: null }]
          : [],
      },
    );
  }
  return { ...c.finish(), rowsTotal: rows.length };
}

/** Parse a marketplace export. Throws CsvFormatError when the file is not that format at all. */
export function parseOrdersCsv(format: CsvFormat, text: string, channel?: Channel): ParsedCsv {
  if (!text.trim()) throw new CsvFormatError("The file is empty");
  switch (format) {
    case "etsy":
      return parseEtsy(text);
    case "amazon":
      return parseAmazon(text);
    case "tiktok":
      return parseTiktok(text);
    case "walmart":
      return parseWalmart(text);
    case "shopify":
      return parseShopify(text);
    case "generic":
      return parseGeneric(text, channel ?? "csv");
  }
}
