import { env } from "../../env";
import { easypostCarrier } from "./easypost";
import { mockCarrier } from "./mock";
import type { CarrierAdapter } from "./types";

export * from "./types";

/** EasyPost when EASYPOST_API_KEY is set, otherwise the deterministic mock carrier. */
export function carrierAdapter(): CarrierAdapter {
  return env.mocks.carrier || !easypostCarrier ? mockCarrier : easypostCarrier;
}
