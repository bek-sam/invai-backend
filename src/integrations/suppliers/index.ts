import { env } from "../../env";
import { type CompanyScope, isSampleWorkspace } from "../../modules/tenancy/demo-flag";
import { mockSupplier } from "./mock";
import { ssActivewearAdapter } from "./ssactivewear";
import { type SupplierAdapter, type SupplierCredentials, SupplierNotConnectedError } from "./types";

export type * from "./types";
export { SupplierError, SupplierNotConnectedError } from "./types";

/** Suppliers InvAI can order from through an API (SanMar SOAP is deferred). */
const API_SUPPLIERS = new Set(["ssactivewear"]);

export type SupplierAdapterOptions = {
  /** Defaults to `env.isProd`; tests pass it explicitly. */
  production?: boolean;
};

/**
 * How a company's orders to this supplier would go:
 * - `mock`: always for a sample workspace (tenancy.demo), whatever keys it entered;
 * - `live`: the company's own API credentials (never InvAI's platform keys);
 * - `mock`: outside production, when the company has none;
 * - `none`: in production without credentials, or a supplier with no API. Nothing is sent.
 */
export function supplierProvider(
  supplier: string,
  companyCreds: SupplierCredentials | null,
  production = env.isProd,
  sample = false,
): "live" | "mock" | "none" {
  if (sample) return "mock";
  if (API_SUPPLIERS.has(supplier) && companyCreds) return "live";
  return production ? "none" : "mock";
}

/**
 * The adapter for a company's supplier account. Only the company's own credentials make it
 * live: a tenant never orders on InvAI's account, and a sample workspace never orders for real
 * (it gets the mock, checked live on every call). Without credentials, development and tests get
 * the mock; production throws `SupplierNotConnectedError` for an API supplier and returns null
 * for a supplier with no API (callers refuse to order; nothing is faked). The mock's remembered
 * orders are scoped to the company id.
 */
export async function getSupplierAdapter(
  supplier: string,
  companyCreds: SupplierCredentials | null,
  scope: CompanyScope & SupplierAdapterOptions,
): Promise<SupplierAdapter | null> {
  const sample = await isSampleWorkspace(scope.companyId);
  const provider = supplierProvider(supplier, companyCreds, scope.production, sample);
  if (provider === "live" && companyCreds) return ssActivewearAdapter(companyCreds);
  if (provider === "mock") return mockSupplier(supplier, scope.companyId);
  if (API_SUPPLIERS.has(supplier)) throw new SupplierNotConnectedError(supplier);
  return null;
}
