import { env } from "../../../env";
import type { ChannelAdapter } from "../types";
import { shopifyLive } from "./live";
import { shopifyMock } from "./mock";

export * from "./common";
export { exchangeShopifyCode, finishShopifyInstall, shopifyAuthorizeUrl } from "./live";
export { mockShopifyOrder, mockShopifySubscriptions } from "./mock";

/** The live adapter when SHOPIFY_API_KEY/SECRET are set, else the mock store. */
export function shopifyAdapter(
  provider: "live" | "mock" = env.mocks.shopify ? "mock" : "live",
): ChannelAdapter {
  return provider === "live" && !env.mocks.shopify ? shopifyLive : shopifyMock;
}
