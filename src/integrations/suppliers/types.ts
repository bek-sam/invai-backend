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
  supplierOrderId: string;
  /** Supplier's expected delivery date, when known. */
  expectedAt: string | null;
};

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
  placeOrder(input: SupplierOrderInput): Promise<SupplierOrderResult>;
}

export class SupplierError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
  }
}
