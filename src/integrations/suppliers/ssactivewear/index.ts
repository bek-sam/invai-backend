import { logger } from "../../../lib/log";
import { takeToken } from "../ratelimit";
import {
  type SupplierAdapter,
  type SupplierCredentials,
  SupplierError,
  type SupplierProduct,
} from "../types";

/*
 * S&S Activewear REST API v2 (https://api.ssactivewear.com/V2/Default.aspx), checked 2026-09-24.
 * - Auth: HTTP Basic, username = account number, password = API key.
 * - GET    /v2/products/?style={style}    one row per SKU (price, per-warehouse qty)
 * - GET    /v2/inventory/{sku,sku,...}    per-warehouse qty for the given SKUs
 * - POST   /v2/orders/                    place an order; returns the created order(s), one per
 *                                         warehouse (https://api.ssactivewear.com/V2/Orders_Post.aspx)
 * - GET    /v2/orders/{identifier}        identifier = PO number, order number, invoice or GUID
 *                                         (https://api.ssactivewear.com/V2/Orders.aspx)
 * - DELETE /v2/orders/{orderNumber}       cancel; only within 10 minutes of placing
 *                                         (https://api.ssactivewear.com/V2/Orders_DELETE.aspx)
 * - Rate limit: 60 requests per minute per account (X-Rate-Limit-Remaining header). We keep a
 *   shared Redis token bucket so API and worker processes together stay under it.
 * - S&S documents no idempotency on POST /orders, so the caller reads back by PO number
 *   (`findOrder`) before any retry.
 */

const BASE = "https://api.ssactivewear.com/v2";
const log = logger("ssactivewear");
const INVENTORY_BATCH = 50;

type SsWarehouse = { warehouseAbbr: string; skuID?: number; qty: number };
type SsInventoryRow = { sku: string; skuID?: number; warehouses?: SsWarehouse[] };
type SsProductRow = {
  sku: string;
  styleID?: number;
  styleName?: string;
  partNumber?: string;
  brandName?: string;
  colorName?: string;
  sizeName?: string;
  customerPrice?: number;
  piecePrice?: number;
  qty?: number;
  warehouses?: SsWarehouse[];
};
type SsOrderRow = {
  orderNumber?: string | number;
  guid?: string;
  poNumber?: string;
  orderStatus?: string;
  expectedDeliveryDate?: string | null;
};

const isCancelled = (r: SsOrderRow) => /^cancel/i.test(r.orderStatus ?? "");
const orderIdOf = (r: SsOrderRow) => (r.orderNumber ?? r.guid ?? "").toString();

/** One result for every order S&S made from one PO (it splits by warehouse). */
function summarize(rows: SsOrderRow[]) {
  const ids = rows.map(orderIdOf).filter(Boolean);
  return {
    supplierOrderId: ids.join(","),
    expectedAt: rows.find((r) => r.expectedDeliveryDate)?.expectedDeliveryDate ?? null,
  };
}

const sumQty = (w: SsWarehouse[] | undefined) => (w ?? []).reduce((n, x) => n + (x.qty ?? 0), 0);

export function ssActivewearAdapter(creds: SupplierCredentials): SupplierAdapter {
  const auth = `Basic ${Buffer.from(`${creds.account}:${creds.apiKey}`).toString("base64")}`;

  async function request<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T> {
    try {
      await takeToken(`ssactivewear:${creds.account}`, { capacity: 60, perMs: 60_000 });
    } catch (err) {
      throw new SupplierError(`S&S is busy, try again in a minute (${(err as Error).message})`);
    }
    let res: Response;
    try {
      res = await fetch(`${BASE}${path}`, {
        method,
        headers: {
          Authorization: auth,
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      // Timeout or network failure: the request may have reached S&S.
      throw new SupplierError(
        `S&S ${method} ${path} did not answer: ${(err as Error).message}`,
        null,
        "unknown",
      );
    }
    const remaining = res.headers.get("x-rate-limit-remaining");
    if (remaining !== null && Number(remaining) < 5) log.warn("near rate limit", { remaining });
    const text = await res.text();
    if (!res.ok) {
      // S&S returns 404 for "no results" on inventory/products lookups.
      if (res.status === 404 && method === "GET") return [] as T;
      throw new SupplierError(
        `S&S ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`,
        res.status,
        res.status >= 500 ? "unknown" : "not_placed",
      );
    }
    return (text ? JSON.parse(text) : []) as T;
  }

  return {
    provider: "live",
    async stock(skus) {
      const out: { sku: string; quantity: number }[] = [];
      for (let i = 0; i < skus.length; i += INVENTORY_BATCH) {
        const batch = skus.slice(i, i + INVENTORY_BATCH).filter(Boolean);
        if (!batch.length) continue;
        const rows = await request<SsInventoryRow[]>(
          "GET",
          `/inventory/${batch.map(encodeURIComponent).join(",")}`,
        );
        for (const r of rows) out.push({ sku: r.sku, quantity: sumQty(r.warehouses) });
      }
      return out;
    },
    async products(style): Promise<SupplierProduct[]> {
      const rows = await request<SsProductRow[]>(
        "GET",
        `/products/?style=${encodeURIComponent(style)}`,
      );
      return rows.map((r) => ({
        sku: r.sku,
        styleCode: r.partNumber ?? r.styleName ?? style,
        brand: r.brandName ?? "",
        color: r.colorName ?? "",
        size: r.sizeName ?? "",
        costCents: Math.round((r.customerPrice ?? r.piecePrice ?? 0) * 100),
        quantity: r.qty ?? sumQty(r.warehouses),
      }));
    },
    async placeOrder(input) {
      if (!input.shipTo) throw new SupplierError("A ship-to address is required for S&S orders");
      const body = {
        shippingAddress: {
          customer: input.shipTo.company ?? input.shipTo.name,
          attn: input.shipTo.name,
          address: [input.shipTo.street1, input.shipTo.street2].filter(Boolean).join(" "),
          city: input.shipTo.city,
          state: input.shipTo.state,
          zip: input.shipTo.zip,
          residential: false,
        },
        shippingMethod: "1", // ground
        poNumber: input.poNo,
        emailConfirmation: "",
        testOrder: input.test ?? false,
        autoselectWarehouse: true,
        // All or nothing: never let S&S silently drop lines it can't fill.
        rejectLineErrors: true,
        lines: input.lines.map((l) => ({ identifier: l.sku, qty: l.quantity })),
      };
      const res = await request<SsOrderRow[] | SsOrderRow>("POST", "/orders/", body);
      const result = summarize(Array.isArray(res) ? res : [res]);
      if (!result.supplierOrderId) {
        throw new SupplierError(
          "S&S accepted the order but returned no order number",
          null,
          "unknown",
        );
      }
      return result;
    },
    async findOrder(poNo) {
      const res = await request<SsOrderRow[] | SsOrderRow>(
        "GET",
        `/orders/${encodeURIComponent(poNo)}`,
      );
      // The identifier also matches order and invoice numbers, so keep only our PO's rows.
      const rows = (Array.isArray(res) ? res : [res]).filter((r) => r?.poNumber === poNo);
      if (!rows.length) return null;
      const live = rows.filter((r) => !isCancelled(r));
      return { ...summarize(live.length ? live : rows), cancelled: live.length === 0 };
    },
    async cancelOrder(supplierOrderId) {
      for (const id of supplierOrderId.split(",").filter(Boolean)) {
        const res = await request<SsOrderRow[] | SsOrderRow>(
          "DELETE",
          `/orders/${encodeURIComponent(id)}`,
        );
        const rows = Array.isArray(res) ? res : [res];
        if (!rows.some(isCancelled)) {
          throw new SupplierError(
            `S&S did not cancel order ${id} (it allows cancelling only in the first 10 minutes)`,
          );
        }
      }
    },
  };
}
