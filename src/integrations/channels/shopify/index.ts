import { env } from "../../../env";
import type { ChannelAdapter } from "../types";
import { shopifyLive } from "./live";
import { shopifyMock } from "./mock";

export {
  credentialsFromToken,
  exchangeShopifyCode,
  refreshShopifyToken,
  ShopifyRefreshError,
} from "./auth";
export * from "./common";
export { finishShopifyInstall, shopifyAuthorizeUrl } from "./live";
export { SHOPIFY_IMAGE_SCOPE, shopifyProductId } from "./media";
export {
  MOCK_SHOPIFY_MISSING_PRODUCT,
  mockShopifyOrder,
  mockShopifyProductMedia,
  mockShopifySubscriptions,
  resetMockShopifyMedia,
} from "./mock";

/** The live adapter when SHOPIFY_API_KEY/SECRET are set, else the mock store. */
export function shopifyAdapter(
  provider: "live" | "mock" = env.mocks.shopify ? "mock" : "live",
): ChannelAdapter {
  return provider === "live" && !env.mocks.shopify ? shopifyLive : shopifyMock;
}
