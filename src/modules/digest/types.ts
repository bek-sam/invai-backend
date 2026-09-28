import type {
  Channel,
  DigestAction,
  DigestDetector,
  DigestFact,
  DigestGlanceItem,
  MarketRecommendation,
} from "@invai/contracts";

/*
 * The weekly snapshot (spec pipeline 4): plain numbers computed by `snapshot.ts` from the shared
 * analyst queries and finance's profit functions. Detectors and ranking are pure functions of it,
 * so they are unit-tested without a database. Money in cents; `*Pct` are percent numbers; `*Rate`
 * are 0..1 ratios.
 */

export type WeekTotals = {
  orders: number;
  units: number;
  revenue: number;
  net: number;
  /** Percent number (net / revenue × 100); null with no revenue. */
  marginPct: number | null;
  adsCost: number;
  avgOrderValue: number | null;
};

export type CostLines = {
  channelFees: number;
  blankCost: number;
  transferCost: number;
  labelCost: number;
  packagingCost: number;
  laborCost: number;
  adsCost: number;
  refunds: number;
};
export type CostLine = keyof CostLines;

export type ChannelWeek = {
  channel: Channel;
  revenue: number;
  previousRevenue: number;
  net: number;
  previousNet: number;
  orders: number;
};

export type AdsChannel = {
  channel: Channel;
  spend: number;
  previousSpend: number;
  revenue: number;
  previousRevenue: number;
  roas: number | null;
  netAfterAds: number;
};

export type DesignRef = { designId: string; name: string | null };

export type FulfillmentChannel = {
  channel: Channel;
  shipped: number;
  onTimeRate: number | null;
  previousOnTimeRate: number | null;
  previousShipped: number;
  overdueNow: number;
};

export type LowStockBlank = {
  blankVariantId: string;
  name: string;
  available: number;
  reorderPoint: number;
  /** A top design whose sales used this blank recently; null when no link is recorded. */
  forDesign: DesignRef | null;
  /** That design's units last week (0 when unlinked). */
  designUnits: number;
};

export type UnhealthyChannel = {
  connectionId: string;
  channel: Channel;
  status: string;
};

export type Snapshot = {
  weekKey: string;
  weekStart: string;
  weekEnd: string;
  periodFrom: string;
  periodTo: string;
  timezone: string;
  asOf: string;
  current: WeekTotals;
  previous: WeekTotals;
  /** Net per week before the current one, most recent first (up to 8; weeks with orders only). */
  trailingNet: number[];
  trailingRevenue: number[];
  costLines: { current: CostLines; previous: CostLines };
  byChannel: ChannelWeek[];
  /** Orders placed in the week whose profit (fees) isn't computed yet. */
  incompleteOrders: number;
  ads: AdsChannel[];
  designs: {
    rising: (DesignRef & { units: number; previousUnits: number })[];
    lowMargin: (DesignRef & { units: number; revenue: number; net: number; marginPct: number })[];
    crossListingGaps: (DesignRef & {
      soldOn: { channel: Channel; units: number }[];
      missingOn: Channel[];
      netPerUnit: number | null;
    })[];
    top: (DesignRef & { units: number; net: number })[];
  };
  fulfillment: {
    channels: FulfillmentChannel[];
    overdueNow: number;
    shipped: number;
    onTimeRate: number | null;
    previousOnTimeRate: number | null;
    /** Best weekly on-time rate in the trailing weeks (for the D8 record). */
    bestTrailingOnTimeRate: number | null;
    reprints: number;
    previousReprints: number;
    reprintCostCents: number;
    topReprintReason: string | null;
    itemsPlaced: number;
  };
  lowStock: LowStockBlank[];
  unhealthyChannels: UnhealthyChannel[];
};

/** A detector's output before ranking. */
export type Candidate = {
  detector: DigestDetector;
  section: "action" | "win" | "market";
  /** Stable across weeks (repeat suppression, AC12). */
  fingerprint: string;
  impactCents: number | null;
  confidence: number;
  templateKey: string;
  action: DigestAction;
  facts: DigestFact[];
  /** Market items only. */
  recommendation?: MarketRecommendation;
  /** Market items that may take a top-3 slot (R1 with a gap or low blank, R3). */
  promotable?: boolean;
};

export type Ranked = Candidate & { rank: number; score: number };

/** What the previous digests say about each fingerprint (repeat suppression). */
export type History = {
  votedDownLastWeek: ReadonlySet<string>;
  /** Consecutive most-recent weeks each fingerprint was shown as an action without a click. */
  weeksShownWithoutAction: ReadonlyMap<string, number>;
};

export type RankedDigest = {
  actions: Ranked[];
  win: Ranked | null;
  marketWatch: Ranked[];
  steady: boolean;
};

export type DigestContent = {
  steady: boolean;
  incompleteOrders: number;
  partialChannels: Channel[];
  glance: DigestGlanceItem[];
  net: DigestFact | null;
  netChange: DigestFact | null;
};
