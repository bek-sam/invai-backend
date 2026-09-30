import { computeSignalsForShop } from "../../modules/market/compute";
import { integrationsMarket } from "../../modules/market/deps";
import { refreshDemand } from "../../modules/market/jobs";

/*
 * T-23-10 (follow-up to T-23-8/B-207): a fresh seed had no outside-demand rows in
 * `market_series_cache` until the hourly `market.sweep` job ran (`src/modules/market/jobs.ts`
 * `marketSweep`, `MARKET_SWEEP_EVERY_MS`), so a stack just booted from `pnpm db:seed` never had
 * any `mock: true` reading to show the assistant's "Sample data" badge -- Desert Bloom isn't a
 * sample workspace itself (`src/modules/tenancy/demo-flag.ts`), so its *own* signals are never
 * flagged `mock`; only an *outside* demand source can set it (T-23-9's "Market answer" finding).
 *
 * The seed now runs the same two calls the sweep would once it found a due shop: the global
 * `refreshDemand()` (writes `market_series_cache` from the demand providers -- always the mock
 * ones here, no key is ever set, `src/integrations/market/index.ts`), then
 * `computeSignalsForShop()` for the shop, the real per-shop path `market.computeSignals` uses
 * (auto-classifies each design's niche, matches it against the outside rows just written, and
 * writes both `market_signals` and any `market_recommendations` -- not hand-inserted rows).
 *
 * Idempotent, like T-23-8's digest builder: `refreshDemand` upserts on
 * `(source, query, granularity, period)` and `computeSignalsForShop` upserts signals on
 * `(company_id, subject_type, subject_id, signal, source)` and recommendations at most once per
 * `(company_id, dedupe_key, created_on)` -- a second seed run changes nothing (AC2).
 */
export async function seedMarketDemand(companyId: string) {
  const demand = await refreshDemand();
  const deps = integrationsMarket();
  const signals = await computeSignalsForShop(
    companyId,
    {},
    { classify: deps.classify(companyId), screen: deps.screen },
  );
  return { demand, signals };
}
