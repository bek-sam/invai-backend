import { aiRouter } from "../modules/ai/router";
import { analyticsRouter } from "../modules/analytics/router";
import { billingRouter } from "../modules/billing/router";
import { blanksRouter, designsRouter, productsRouter } from "../modules/catalog/router";
import { channelsRouter, skuRulesRouter } from "../modules/channels/router";
import { digestRouter } from "../modules/digest/router";
import { filesRouter } from "../modules/files/router";
import { financeRouter } from "../modules/finance/router";
import { inventoryRouter } from "../modules/inventory/router";
import { marketRouter } from "../modules/market/router";
import { orderItemsRouter, ordersRouter } from "../modules/orders/router";
import { personalizationRouter } from "../modules/personalization/router";
import { privacyRouter } from "../modules/privacy/router";
import { productionRouter } from "../modules/production/router";
import { shippingRouter } from "../modules/shipping/router";
import {
  auditRouter,
  demoRouter,
  floorRouter,
  locationsRouter,
  meRouter,
  stationsRouter,
  teamRouter,
} from "../modules/tenancy/router";
import { alertsRouter, todayRouter } from "../modules/today/router";
import { vendorPortalRouter, vendorsRouter } from "../modules/vendors/router";
import { os } from "./orpc";

/**
 * The full v1 API: every key of `contract` mapped to a module router. `os.router()` fails
 * to typecheck if a procedure is missing, so the contract and the implementation cannot drift.
 */
export const router = os.router({
  me: meRouter,
  team: teamRouter,
  locations: locationsRouter,
  stations: stationsRouter,
  floor: floorRouter,
  audit: auditRouter,
  demo: demoRouter,
  today: todayRouter,
  alerts: alertsRouter,
  orders: ordersRouter,
  orderItems: orderItemsRouter,
  channels: channelsRouter,
  skuRules: skuRulesRouter,
  designs: designsRouter,
  blanks: blanksRouter,
  products: productsRouter,
  files: filesRouter,
  personalization: personalizationRouter,
  production: productionRouter,
  vendors: vendorsRouter,
  vendorPortal: vendorPortalRouter,
  inventory: inventoryRouter,
  shipping: shippingRouter,
  finance: financeRouter,
  ai: aiRouter,
  billing: billingRouter,
  privacy: privacyRouter,
  market: marketRouter,
  digest: digestRouter,
  analytics: analyticsRouter,
});

export type Router = typeof router;
