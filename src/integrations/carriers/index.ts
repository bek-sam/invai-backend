import { env } from "../../env";
import { easypostCarrier, easypostTracking } from "./easypost";
import { mockCarrier, mockTracking } from "./mock";
import type { TrackingAdapter } from "./tracking";
import type { CarrierAdapter } from "./types";

export * from "./tracking";
export * from "./types";

/** EasyPost when EASYPOST_API_KEY is set, otherwise the deterministic mock carrier. */
export function carrierAdapter(): CarrierAdapter {
  return env.mocks.carrier || !easypostCarrier ? mockCarrier : easypostCarrier;
}

/** Tracker reads from the same provider `carrierAdapter()` buys labels from. */
export function carrierTracking(): TrackingAdapter {
  return env.mocks.carrier || !easypostTracking ? mockTracking : easypostTracking;
}
