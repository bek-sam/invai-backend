import {
  censusRetailSeries,
  marketDemandProviders,
  marketPricingProvider,
} from "../../integrations/market";
import { classifyDesignNiche, screenMarketTerms } from "../ai/niche";
import type { Classifier } from "./mapper";

/*
 * The market module's outside dependencies in one place: the providers (T-18-2,
 * `src/integrations/market`) and the niche classifier and trademark screen (T-18-4,
 * `src/modules/ai/niche.ts`). Tests swap them with `setMarketDeps` (test doubles for other
 * owners' units, never for this module's own code).
 */

export type MarketDeps = {
  marketDemandProviders: typeof marketDemandProviders;
  marketPricingProvider: typeof marketPricingProvider;
  censusRetailSeries: typeof censusRetailSeries;
  classify: (companyId: string) => Classifier;
  screen: typeof screenMarketTerms | null;
};

const defaults: MarketDeps = {
  marketDemandProviders,
  marketPricingProvider,
  censusRetailSeries,
  classify: (companyId) => (input) => classifyDesignNiche(companyId, input),
  screen: screenMarketTerms,
};

let override: Partial<MarketDeps> = {};

export function integrationsMarket(): MarketDeps {
  return { ...defaults, ...override };
}

/** Test hook: replace some dependencies; call with `{}` to restore the real ones. */
export function setMarketDeps(deps: Partial<MarketDeps>) {
  override = deps;
}
