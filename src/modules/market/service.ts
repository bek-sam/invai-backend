import type {
  MarketRecommendation,
  MarketSeasonality,
  MarketTrend,
  PricePosition,
  PriceSimulation,
} from "@invai/contracts";
import type { TenantContext } from "../../api/context";
import type { Tx } from "../../db/client";
import type { Channel } from "../../db/schema";

/*
 * Market signals read service (T-18-3, wave 18, `specs/market-signals.md`). Stub: every function
 * throws until the engine lands. Signatures are the agreed interfaces in `waves/18/wave.md`.
 */

type Ctx = Pick<TenantContext, "companyId">;
export type Subject = { designId: string } | { niche: string };

function notYet(name: string): never {
  throw new Error(`market.${name} is not implemented yet (T-18-3)`);
}

export async function getTrendSignal(_tx: Tx, _ctx: Ctx, _input: Subject): Promise<MarketTrend> {
  return notYet("getTrendSignal");
}

export async function getSeasonalitySignal(
  _tx: Tx,
  _ctx: Ctx,
  _input: Subject,
): Promise<MarketSeasonality> {
  return notYet("getSeasonalitySignal");
}

export async function getPricePosition(
  _tx: Tx,
  _ctx: Ctx,
  _input: { designId: string; channel: Channel },
): Promise<PricePosition> {
  return notYet("getPricePosition");
}

export async function simulatePrice(
  _tx: Tx,
  _ctx: Ctx,
  _input: { designId: string; channel: Channel; prices?: number[] },
): Promise<PriceSimulation> {
  return notYet("simulatePrice");
}

export async function listRecommendations(
  _tx: Tx,
  _ctx: Ctx,
  _input: { designId?: string; ids?: string[]; minBand?: "high" | "medium" | "low"; limit: number },
): Promise<MarketRecommendation[]> {
  return notYet("listRecommendations");
}

export async function recordRecommendationsShown(
  _tx: Tx,
  _ctx: Ctx,
  _input: { ids: string[]; shownIn: "assistant" | "digest"; refId?: string },
): Promise<void> {
  return notYet("recordRecommendationsShown");
}

export async function listDigestMarketItems(
  _tx: Tx,
  _ctx: Ctx,
  _input: { asOf: Date },
): Promise<MarketRecommendation[]> {
  return notYet("listDigestMarketItems");
}

export { NICHES, nicheLabel } from "./niches";
