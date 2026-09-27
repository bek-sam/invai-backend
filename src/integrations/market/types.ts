import type { Channel, Licence, SignalSource } from "@invai/contracts";
import type { CONNECTION_STATUSES } from "../../db/schema/channels";
import type { Connection } from "../types";

export type * from "../types";
export type { Channel, Licence, SignalSource };

/*
 * Provider-level types for market signals (research 14 §4.2, T-18-2). These are lower level
 * than the contract's `SignalProvenance`/`MarketTrend`/etc (@invai/contracts, owned by T-18-1):
 * a provider returns a raw `DemandSeries`/`Comparables`, and `src/modules/market` (T-18-3) turns
 * that into the signals and recommendations the assistant reads. Nothing here ever leaves the
 * process holding another seller's identity (AC7): `Comparables.observations` carries price,
 * featured flag and offer count only.
 */

export type SeriesPoint = {
  /** ISO week "2026-W38" for `granularity: "week"`, or ISO month "2026-09" for "month". */
  period: string;
  value: number;
};

export type DemandSeries = {
  source: SignalSource;
  licence: Licence;
  /** A canonical taxonomy query string (never a shop's free text; see `DemandProvider.series`). */
  query: string;
  geo: "US";
  granularity: "week" | "month";
  scale: "absolute" | "relative_0_100" | "consistent_scaled";
  points: SeriesPoint[];
  /** The date the series describes (its last point), not the call time. */
  asOf: string;
  fetchedAt: string;
  /** Deterministic id for this exact request (source + params); lets a cache dedupe and a test assert two calls agree. */
  requestKey: string;
  mock: boolean;
};

/** No seller name, listing title or URL: only what AC7 allows out of the provider. */
export type PriceObservation = {
  landedPriceCents: number;
  isFeatured: boolean;
  offerCount: number | null;
};

export type Comparables = {
  source: SignalSource;
  licence: Licence;
  channel: Channel;
  /** Our own ASIN / item id the observations were fetched for. */
  ownRef: string;
  observations: PriceObservation[];
  asOf: string;
  fetchedAt: string;
  requestKey: string;
  mock: boolean;
};

export interface DemandProvider {
  readonly source: SignalSource;
  /** `mock: true` when this is the deterministic sandbox, never a real call. */
  readonly mock: boolean;
  /**
   * `queries` are canonical taxonomy query strings from `product/market-niches.md` (via
   * `src/modules/market`), never a shop's free text (AC8): no provider accepts arbitrary input.
   */
  series(q: {
    queries: string[];
    granularity: "week" | "month";
    years: number;
  }): Promise<DemandSeries[]>;
}

export interface PricingProvider {
  readonly source: SignalSource;
  readonly mock: boolean;
  /** Per connection (seller-scoped): results never leave the tenant that owns `conn`. */
  comparables(
    conn: Connection,
    own: { ref: string; keywords: string[]; garmentClass: string }[],
  ): Promise<Comparables[]>;
}

/** The connection status values a pricing provider selection checks ("active" = "connected"). */
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

/** What a channel connection looks like to `marketPricingProvider` (the DB row's own fields). */
export type PricingChannelConnection = {
  id: string;
  companyId: string;
  status: ConnectionStatus;
  /** "live": the channel already has real marketplace credentials (research 10/14: no separate pricing key). */
  provider: "live" | "mock";
};

export type PricingScope = {
  sampleWorkspace: boolean;
  channel: Channel;
  connection: PricingChannelConnection | null;
};
