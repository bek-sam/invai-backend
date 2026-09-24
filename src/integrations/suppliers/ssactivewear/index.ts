import { logger } from "../../../lib/log";
import { takeToken } from "../ratelimit";
import {
  type SupplierAdapter,
  type SupplierCredentials,
  SupplierError,
  type SupplierProduct,
} from "../types";

/*
 * S&S Activewear REST API v2 (https://api.ssactivewear.com/V2/Default.aspx).
 * - Auth: HTTP Basic, username = account number, password = API key.
 * - GET  /v2/products/?style={style}      one row per SKU (price, per-warehouse qty)
 * - GET  /v2/inventory/{sku,sku,...}      per-warehouse qty for the given SKUs
 * - POST /v2/orders/                      place an order; returns the created order(s)
 * - Rate limit: 60 requests per minute per account (X-Rate-Limit-Remaining header). We keep a
 *   shared Redis token bucket so API and worker processes together stay under it.
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
  orderNumber?: string;
  guid?: string;
  expectedDeliveryDate?: string | null;
};

const sumQty = (w: SsWarehouse[] | undefined) => (w ?? []).reduce((n, x) => n + (x.qty ?? 0), 0);

export function ssActivewearAdapter(creds: SupplierCredentials): SupplierAdapter {
  const auth = `Basic ${Buffer.from(`${creds.account}:${creds.apiKey}`).toString("base64")}`;

  async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    await takeToken(`ssactivewear:${creds.account}`, { capacity: 60, perMs: 60_000 });
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        Authorization: auth,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const remaining = res.headers.get("x-rate-limit-remaining");
    if (remaining !== null && Number(remaining) < 5) log.warn("near rate limit", { remaining });
    const text = await res.text();
    if (!res.ok) {
      // S&S returns 404 for "no results" on inventory/products lookups.
      if (res.status === 404 && method === "GET") return [] as T;
      throw new SupplierError(
        `S&S ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`,
        res.status,
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
        lines: input.lines.map((l) => ({ identifier: l.sku, qty: l.quantity })),
      };
      const rows = await request<SsOrderRow[] | SsOrderRow>("POST", "/orders/", body);
      const first = Array.isArray(rows) ? rows[0] : rows;
      const id = first?.orderNumber ?? first?.guid;
      if (!id) throw new SupplierError("S&S accepted the order but returned no order number");
      return { supplierOrderId: String(id), expectedAt: first?.expectedDeliveryDate ?? null };
    },
  };
}
