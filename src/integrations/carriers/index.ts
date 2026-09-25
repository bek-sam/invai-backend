import { env } from "../../env";
import { type CompanyScope, isSampleWorkspace } from "../../modules/tenancy/demo-flag";
import { easypostCarrier, easypostTracking } from "./easypost";
import { mockCarrier, mockTracking } from "./mock";
import type { TrackingAdapter } from "./tracking";
import type { CarrierAdapter } from "./types";

export * from "./tracking";
export * from "./types";

/**
 * EasyPost when EASYPOST_API_KEY is set, otherwise the deterministic mock carrier. A sample
 * workspace (tenancy.demo) always gets the mock: it can never buy a real label.
 */
export async function carrierAdapter(scope: CompanyScope): Promise<CarrierAdapter> {
  if (env.mocks.carrier || !easypostCarrier) return mockCarrier;
  return (await isSampleWorkspace(scope.companyId)) ? mockCarrier : easypostCarrier;
}

/** Tracker reads from the same provider `carrierAdapter()` buys labels from. */
export async function carrierTracking(scope: CompanyScope): Promise<TrackingAdapter> {
  if (env.mocks.carrier || !easypostTracking) return mockTracking;
  return (await isSampleWorkspace(scope.companyId)) ? mockTracking : easypostTracking;
}
