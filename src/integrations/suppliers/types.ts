/*
 * Supplier (blank wholesaler) adapter. Adapters never touch the database: the inventory module
 * resolves credentials and passes them in. SKUs are the supplier's own SKU (blank_variants.supplier_sku).
 */

export type SupplierCredentials = { account: string; apiKey: string };

export type SupplierShipTo = {
  name: string;
  company: string | null;
  street1: string;
  street2: string | null;
  city: string;
  state: string;
  zip: string;
};

export type SupplierOrderInput = {
  poNo: string;
  lines: { sku: string; quantity: number }[];
  shipTo: SupplierShipTo | null;
  /** S&S `testOrder`: validated but never shipped. */
  test?: boolean;
};

export type SupplierOrderResult = {
  /** The supplier's order number. A PO split across warehouses joins them with ",". */
  supplierOrderId: string;
  /** Supplier's expected delivery date, when known. */
  expectedAt: string | null;
};

/** What the supplier has on file for one of our PO numbers (read-back before a retry). */
export type SupplierOrderLookup = SupplierOrderResult & { cancelled: boolean };

export type SupplierProduct = {
  sku: string;
  styleCode: string;
  brand: string;
  color: string;
  size: string;
  costCents: number;
  quantity: number;
};

export interface SupplierAdapter {
  provider: "live" | "mock";
  /** Live stock summed over every warehouse. Unknown SKUs are omitted. */
  stock(skus: string[]): Promise<{ sku: string; quantity: number }[]>;
  products(style: string): Promise<SupplierProduct[]>;
  /**
   * Places the order. `input.poNo` is our idempotency key: never call this again for the same
   * PO without `findOrder` first, since suppliers don't document dedupe on it.
   */
  placeOrder(input: SupplierOrderInput): Promise<SupplierOrderResult>;
  /** Looks up the supplier's orders for our PO number; null when none exists. */
  findOrder(poNo: string): Promise<SupplierOrderLookup | null>;
  /** Cancels at the supplier. Absent when the supplier has no cancel API. */
  cancelOrder?(supplierOrderId: string): Promise<void>;
}

/**
 * `outcome` says what a failed write means: `not_placed` when the supplier certainly did nothing
 * (validation error, 4xx, nothing sent), `unknown` when it may have acted (timeout, network, 5xx),
 * so the caller must read back before trying again.
 */
export class SupplierError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
    readonly outcome: "not_placed" | "unknown" = "not_placed",
  ) {
    super(message);
  }
}

/** The tenant hasn't connected its own supplier account (production never borrows InvAI's). */
export class SupplierNotConnectedError extends SupplierError {
  constructor(readonly supplier: string) {
    super(`Connect your ${supplier} account in inventory settings before ordering from it`);
  }
}
