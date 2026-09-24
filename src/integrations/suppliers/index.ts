import { env } from "../../env";
import { mockSupplier } from "./mock";
import { ssActivewearAdapter } from "./ssactivewear";
import type { SupplierAdapter, SupplierCredentials } from "./types";

export type * from "./types";
export { SupplierError } from "./types";

/**
 * The adapter for a supplier. S&S goes live when credentials exist (the company's own account
 * from inventory settings, else the platform env keys); everything else is the mock.
 */
export function getSupplierAdapter(
  supplier: string,
  companyCreds: SupplierCredentials | null = null,
): SupplierAdapter {
  if (supplier === "ssactivewear") {
    const creds =
      companyCreds ??
      (env.mocks.supplier
        ? null
        : {
            account: env.SS_ACTIVEWEAR_ACCOUNT as string,
            apiKey: env.SS_ACTIVEWEAR_API_KEY as string,
          });
    if (creds) return ssActivewearAdapter(creds);
  }
  return mockSupplier(supplier);
}
