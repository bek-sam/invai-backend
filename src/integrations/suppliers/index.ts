import { env } from "../../env";
import { mockSupplier } from "./mock";
import { ssActivewearAdapter } from "./ssactivewear";
import { type SupplierAdapter, type SupplierCredentials, SupplierNotConnectedError } from "./types";

export type * from "./types";
export { SupplierError, SupplierNotConnectedError } from "./types";

/** Suppliers InvAI can order from through an API (SanMar SOAP is deferred). */
const API_SUPPLIERS = new Set(["ssactivewear"]);

export type SupplierAdapterOptions = {
  /** Scopes the mock's remembered orders (the company id); real accounts are already scoped. */
  account?: string;
  /** Defaults to `env.isProd`; tests pass it explicitly. */
  production?: boolean;
};

/**
 * How a company's orders to this supplier would go:
 * - `live`: the company's own API credentials (never InvAI's platform keys);
 * - `mock`: outside production, when the company has none;
 * - `none`: in production without credentials, or a supplier with no API. Nothing is sent.
 */
export function supplierProvider(
  supplier: string,
  companyCreds: SupplierCredentials | null,
  production = env.isProd,
): "live" | "mock" | "none" {
  if (API_SUPPLIERS.has(supplier) && companyCreds) return "live";
  return production ? "none" : "mock";
}

/**
 * The adapter for a company's supplier account. Only the company's own credentials make it
 * live: a tenant never orders on InvAI's account. Without them, development and tests get the
 * mock; production throws `SupplierNotConnectedError` for an API supplier and returns null for a
 * supplier with no API (callers refuse to order; nothing is faked).
 */
export function getSupplierAdapter(
  supplier: string,
  companyCreds: SupplierCredentials | null = null,
  opts: SupplierAdapterOptions = {},
): SupplierAdapter | null {
  const provider = supplierProvider(supplier, companyCreds, opts.production);
  if (provider === "live" && companyCreds) return ssActivewearAdapter(companyCreds);
  if (provider === "mock") return mockSupplier(supplier, opts.account);
  if (API_SUPPLIERS.has(supplier)) throw new SupplierNotConnectedError(supplier);
  return null;
}
