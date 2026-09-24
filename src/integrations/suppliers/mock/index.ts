import { createHash } from "node:crypto";
import { logger } from "../../../lib/log";
import type { SupplierAdapter, SupplierOrderLookup } from "../types";

const log = logger("supplier-mock");

/**
 * Orders the mock has accepted in this process, keyed by account (the company), supplier and PO
 * number, so read-back and cancel behave like a real supplier within one run. Ids are
 * deterministic anyway, so a restart that re-places an order yields the same id.
 */
const placed = new Map<string, SupplierOrderLookup>();

/** Deterministic 0..n from a string, so the mock gives the same numbers every run. */
function hashInt(value: string, mod: number): number {
  return createHash("sha256").update(value).digest().readUInt32BE(0) % mod;
}

/**
 * Mock supplier: stock is a stable function of the SKU (about 1 in 12 SKUs is out of stock),
 * orders get a stable id from the PO number and arrive in 2 business days. Orders can be
 * cancelled (S&S allows it for 10 minutes; the mock always does).
 */
export function mockSupplier(supplier: string, account = ""): SupplierAdapter {
  const key = (poNo: string) => `${account}:${supplier}:${poNo}`;
  return {
    provider: "mock",
    async stock(skus) {
      return skus.map((sku) => ({
        sku,
        quantity: hashInt(`${supplier}:${sku}`, 12) === 0 ? 0 : 40 + hashInt(sku, 2400),
      }));
    },
    async products(style) {
      return ["S", "M", "L", "XL"].map((size) => ({
        sku: `${style}-MOCK-${size}`,
        styleCode: style,
        brand: "Mock",
        color: "Black",
        size,
        costCents: 250 + hashInt(`${style}${size}`, 150),
        quantity: 100 + hashInt(`${style}:${size}`, 900),
      }));
    },
    async placeOrder(input) {
      const id = hashInt(`${supplier}:${input.poNo}`, 90_000_000) + 10_000_000;
      const expected = new Date(Date.now() + 2 * 86_400_000);
      const result = {
        supplierOrderId: `MOCK-${supplier.toUpperCase().slice(0, 3)}-${id}`,
        expectedAt: expected.toISOString(),
      };
      placed.set(key(input.poNo), { ...result, cancelled: false });
      log.info("mock supplier order placed", { supplier, poNo: input.poNo, ...result });
      return result;
    },
    async findOrder(poNo) {
      return placed.get(key(poNo)) ?? null;
    },
    async cancelOrder(supplierOrderId) {
      for (const order of placed.values()) {
        if (order.supplierOrderId === supplierOrderId) order.cancelled = true;
      }
      log.info("mock supplier order cancelled", { supplier, supplierOrderId });
    },
  };
}
