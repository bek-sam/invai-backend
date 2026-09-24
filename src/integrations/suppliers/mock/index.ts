import { createHash } from "node:crypto";
import type { SupplierAdapter } from "../types";

/** Deterministic 0..n from a string, so the mock gives the same numbers every run. */
function hashInt(value: string, mod: number): number {
  return createHash("sha256").update(value).digest().readUInt32BE(0) % mod;
}

/**
 * Mock supplier: stock is a stable function of the SKU (about 1 in 12 SKUs is out of stock),
 * orders get a stable id from the PO number and arrive in 2 business days.
 */
export function mockSupplier(supplier: string): SupplierAdapter {
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
      return {
        supplierOrderId: `MOCK-${supplier.toUpperCase().slice(0, 3)}-${id}`,
        expectedAt: expected.toISOString(),
      };
    },
  };
}
