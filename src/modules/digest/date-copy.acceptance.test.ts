/*
 * Wave 20 acceptance tests for T-20-1 (digest, market and Today copy on real dates), written from
 * `invai-docs/waves/20/T-20-1.md` and the wording rule in `invai-docs/waves/20/wave.md` before the
 * build (`acceptance-tests-first`). Fixed clock 2026-09-28 (a Monday), shop time zone
 * America/Phoenix (the schema default, `CLAUDE.md`/fixtures).
 *
 * Layer choices (lowest layer that proves each criterion, `acceptance-tests-first` step 2):
 *  - AC3 (points, not relative percent) and the "unchanged" rule: `glanceOf` is a pure function of
 *    a `Snapshot` (`digest/build.ts`, `digest/types.ts`) -- no DB needed.
 *  - AC2 (peak-under-way wording): `renderParts`/`expand` (`digest/render.ts`) are pure functions of
 *    a `RenderModel` -- no DB needed. This only proves the *email* line; the web's own market copy
 *    (`invai-web/src/components/market/recommendation-copy.ts`) is outside every wave-20 card's
 *    owned paths and is not tested here.
 *  - AC1 (no past peak) is tested at the two places a shop actually sees a recommendation --
 *    `digest.get`'s `marketWatch` and `market.recommendations.list` -- with a recommendation row
 *    seeded directly (bypassing the rule engine, the established pattern in
 *    `digest-market.acceptance.test.ts` and `market.acceptance.test.ts`). This does not pin down
 *    `designRules()`'s own signature (not yet changed, `rules.ts` has no "today" input today) so the
 *    test can't guess it wrong; it proves the thing a shop can actually observe.
 *  - AC4 (mock `asOf`) is a pure function of the frozen clock: `mockDemandSeries` (integrations,
 *    read-only here per the T-20-1 grant on `mock*.ts`'s `asOf` computation).
 *  - AC5 (Today's overdue alert) needs the DB (real order + real alert row from `generateAlerts`).
 *
 * Owner: qa-engineer. Implementers don't edit this file; disagreements go in their report.
 */
import type {
  Digest,
  MarketAction,
  MarketRecommendation,
  MarketRule,
  RecommendationParams,
} from "@invai/contracts";
import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "../../api/context";
import { router } from "../../api/router";
import { withSystem, withTenant } from "../../db/client";
import {
  type Channel,
  channelConnections,
  designs,
  marketRecommendations,
  orderItems,
  orders,
  profitLines,
} from "../../db/schema";
import { mockDemandSeries } from "../../integrations/market/mock";
import { isoWeek, periodEndIso } from "../../integrations/market/period";
import {
  createCompany,
  createConnection,
  createLocation,
  createOrder,
  createUser,
  tenantContext,
} from "../../test/fixtures";
import * as todaySvc from "../today/service";
import { glanceOf } from "./build";
import { expand, type RenderInsight, type RenderModel, renderParts } from "./render";
import type { CostLines, Snapshot, WeekTotals } from "./types";

const uniq = () => crypto.randomUUID().slice(0, 12);
const DAY_MS = 86_400_000;

function freeze(at: string) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(at));
}
afterEach(() => {
  try {
    vi.useRealTimers();
  } catch {
    // not faked in this test
  }
});

type AnyProcedure = Parameters<typeof call>[0];
function procedureAt(path: string): AnyProcedure {
  let node: unknown = router;
  for (const key of path.split(".")) node = (node as Record<string, unknown> | undefined)?.[key];
  if (!node) throw new Error(`procedure ${path} is not on the router`);
  return node as AnyProcedure;
}
function rpc<T>(path: string, input: unknown, context: TenantContext): Promise<T> {
  return call(procedureAt(path), input as never, { context }) as Promise<T>;
}

const JOBS = "./jobs";
async function runDigestJob(name: string, input: unknown) {
  const { getJob, runJobInline } = await import("../../lib/queues");
  await import(JOBS);
  const job = getJob(name);
  if (!job) throw new Error(`job ${name} is not registered`);
  return runJobInline(job, input);
}

/** A Monday 00:00 UTC that stands in for shop-local Monday 00:00 for Phoenix (UTC-7, no DST). */
function mondayPhoenix(dateIso: string) {
  return new Date(`${dateIso}T07:00:00.000Z`);
}

type Shop = { id: string; owner: TenantContext; etsy: typeof channelConnections.$inferSelect };
async function shop(name: string): Promise<Shop> {
  const company = await createCompany({ name: `${name} ${uniq()}` });
  const owner = await createUser(company.id, "owner", { email: `owner-${uniq()}@test.local` });
  const [etsy] = await withSystem((tx) =>
    tx
      .insert(channelConnections)
      .values({
        companyId: company.id,
        channel: "etsy" as Channel,
        name: "etsy",
        status: "connected",
        mode: "api",
        provider: "mock",
        connectedAt: new Date(),
      })
      .returning(),
  );
  if (!etsy) throw new Error("connection insert failed");
  return { id: company.id, owner: tenantContext(company.id, owner.id, "owner"), etsy };
}

/** A market recommendation seeded directly (bypasses the rule engine), with a free `params`. */
async function recommendation(
  companyId: string,
  input: {
    rule: MarketRule;
    band: "high" | "medium" | "low";
    designId?: string | null;
    createdAt: Date;
    params?: Partial<RecommendationParams>;
  },
) {
  const now = input.createdAt;
  const [row] = await withSystem((tx) =>
    tx
      .insert(marketRecommendations)
      .values({
        companyId,
        rule: input.rule,
        action: "list_and_stock" as MarketAction,
        dedupeKey: `dk-${uniq()}`,
        createdOn: now.toISOString().slice(0, 10),
        designId: input.designId ?? null,
        confidence: input.band === "high" ? 0.85 : input.band === "medium" ? 0.65 : 0.3,
        band: input.band,
        mock: true,
        sources: [],
        evidenceSignalIds: [],
        params: input.params ?? {},
        staleAfterDays: 30,
        createdAt: now,
        updatedAt: now,
      })
      .returning(),
  );
  if (!row) throw new Error("recommendation insert failed");
  return row;
}

/** A minimal sale inside the target week: `marketOf` is only ever called for a non-quiet week. */
async function saleAt(companyId: string, connectionId: string, channel: Channel, placedAt: Date) {
  return withSystem(async (tx) => {
    const [order] = await tx
      .insert(orders)
      .values({
        companyId,
        connectionId,
        channel,
        channelOrderId: `ord-${uniq()}`,
        orderNo: `T-${uniq()}`,
        status: "new",
        placedAt,
        shipBy: new Date(placedAt.getTime() + 2 * DAY_MS),
        subtotalCents: 2500,
        totalCents: 2500,
        itemCount: 1,
      })
      .returning();
    if (!order) throw new Error("order insert failed");
    const [item] = await tx
      .insert(orderItems)
      .values({
        companyId,
        orderId: order.id,
        channelSku: `SKU-${uniq()}`,
        title: "Fixture tee",
        state: "packed",
        shipBy: order.shipBy,
      })
      .returning();
    if (!item) throw new Error("order item insert failed");
    await tx.insert(profitLines).values({
      companyId,
      orderId: order.id,
      orderItemId: item.id,
      channel,
      revenueCents: 2500,
      netCents: 1200,
      marginPct: 1200 / 2500,
      placedAt,
    });
  });
}

/* -------------------------------------------------------------------------------------------- */
/* AC3: glance changes as points (marginPct, onTimeRate), and "unchanged" for a zero change       */
/* -------------------------------------------------------------------------------------------- */

const emptyCostLines: CostLines = {
  channelFees: 0,
  blankCost: 0,
  transferCost: 0,
  labelCost: 0,
  packagingCost: 0,
  laborCost: 0,
  adsCost: 0,
  refunds: 0,
};

function totals(t: Partial<WeekTotals>): WeekTotals {
  return {
    orders: 0,
    units: 0,
    revenue: 0,
    net: 0,
    marginPct: null,
    adsCost: 0,
    avgOrderValue: null,
    ...t,
  };
}

function baseSnapshot(input: {
  current: Partial<WeekTotals>;
  previous: Partial<WeekTotals>;
  onTimeRate: number | null;
  previousOnTimeRate: number | null;
}): Snapshot {
  return {
    weekKey: "2026-W39",
    weekStart: "2026-09-28",
    weekEnd: "2026-10-05",
    periodFrom: "2026-09-28T07:00:00.000Z",
    periodTo: "2026-10-05T07:00:00.000Z",
    timezone: "America/Phoenix",
    asOf: "2026-09-28T07:05:00.000Z",
    current: totals(input.current),
    previous: totals(input.previous),
    trailingNet: [],
    trailingRevenue: [],
    costLines: { current: emptyCostLines, previous: emptyCostLines },
    byChannel: [],
    incompleteOrders: 0,
    ads: [],
    designs: { rising: [], lowMargin: [], crossListingGaps: [], top: [] },
    fulfillment: {
      channels: [],
      overdueNow: 0,
      shipped: 0,
      onTimeRate: input.onTimeRate,
      previousOnTimeRate: input.previousOnTimeRate,
      bestTrailingOnTimeRate: null,
      reprints: 0,
      previousReprints: 0,
      reprintCostCents: 0,
      topReprintReason: null,
      itemsPlaced: 0,
    },
    lowStock: [],
    unhealthyChannels: [],
  };
}

describe("AC3 (T-20-1): margin % and on-time % changes render as points, one decimal", () => {
  it("margin 26.5 -> 33.4 renders '+6.9 pts'; on-time 95.0% -> 97.5% renders '+2.5 pts', not a relative percent", () => {
    const s = baseSnapshot({
      current: { marginPct: 33.4, revenue: 250_000, net: 83_500 },
      previous: { marginPct: 26.5, revenue: 240_000, net: 63_600 },
      onTimeRate: 0.975,
      previousOnTimeRate: 0.95,
    });
    const glance = glanceOf(s);
    const margin = glance.find((g) => g.metric === "marginPct");
    const onTime = glance.find((g) => g.metric === "onTimeRate");
    // Relative-percent relabelled as "pts" (wave 19's actual bug) would read "+26.0 pts" here, not
    // "+6.9 pts" -- the fixture is chosen (architect A4) so a superficial relabel can't pass.
    expect(margin?.change?.formatted.en).toBe("+6.9 pts");
    expect(margin?.change?.formatted.es).toBe("+6,9 pts");
    expect(onTime?.change?.formatted.en).toBe("+2.5 pts");
    expect(onTime?.change?.formatted.es).toBe("+2,5 pts");
  });
});

describe("AC3 (T-20-1): a zero change on any glance metric renders 'unchanged', never 0% or +0.0 pts", () => {
  it("orders unchanged week over week", () => {
    const s = baseSnapshot({
      current: { orders: 40, revenue: 100_000, net: 30_000 },
      previous: { orders: 40, revenue: 100_000, net: 30_000 },
      onTimeRate: 0.95,
      previousOnTimeRate: 0.95,
    });
    const glance = glanceOf(s);
    const ordersRow = glance.find((g) => g.metric === "orders");
    expect(ordersRow?.change?.formatted.en).toBe("unchanged");
    expect(ordersRow?.change?.formatted.es).toBe("sin cambio");
  });
});

/* -------------------------------------------------------------------------------------------- */
/* AC1: an R1 item whose act-by date has passed is dropped from Market watch and the assistant's  */
/* recommendation list; one with a future act-by date still shows it.                             */
/* -------------------------------------------------------------------------------------------- */

describe("AC1 (T-20-1): a past-peak R1 item never reaches Market watch; a future one still does", () => {
  it("digest.get's marketWatch drops the Aug 1 act-by item, keeps the Oct 20 one", async () => {
    const s = await shop("Watch Tees");
    const monday = mondayPhoenix("2026-09-28");
    const past = await withSystem((tx) =>
      tx
        .insert(designs)
        .values({ companyId: s.id, code: `D-${uniq()}`, name: "Spooky Tee", tags: [] })
        .returning(),
    ).then((rows) => rows[0]);
    const future = await withSystem((tx) =>
      tx
        .insert(designs)
        .values({ companyId: s.id, code: `D-${uniq()}`, name: "Turkey Tee", tags: [] })
        .returning(),
    ).then((rows) => rows[0]);
    if (!past || !future) throw new Error("design insert failed");
    const createdAt = new Date(monday.getTime() - 2 * DAY_MS);
    // September peak, well past by the time this week's digest is built (weekEnd 2026-10-05). No
    // `channels`/`blankBelowReorderPoint`: `isPromotable` (market-watch.ts) would otherwise make
    // this R1 candidate compete for a top-3 *action* slot, which removes it from `marketWatch`
    // for a reason unrelated to this test (confirmed against current code: whichever of the two
    // recommendations sorts first by score/fingerprint tiebreak gets promoted and silently
    // disappears from marketWatch either way, which made an earlier draft of this test pass for
    // the wrong reason).
    const pastPeak = await recommendation(s.id, {
      rule: "R1",
      band: "medium",
      designId: past.id,
      createdAt,
      params: { designName: "Spooky Tee", peakMonth: 9, actByDate: "2026-08-01" },
    });
    // October peak, still ahead of this digest week's end.
    const futurePeak = await recommendation(s.id, {
      rule: "R1",
      band: "medium",
      designId: future.id,
      createdAt,
      params: { designName: "Turkey Tee", peakMonth: 10, actByDate: "2026-10-20" },
    });
    await saleAt(s.id, s.etsy.id, "etsy", new Date(monday.getTime() - 3 * DAY_MS));

    freeze(new Date(monday.getTime() + 7 * 60 * 60_000 + 5 * 60_000).toISOString());
    await runDigestJob("digest.sweep", {});
    const digest = await rpc<Digest>("digest.get", { weekKey: "2026-W39" }, s.owner);
    expect(digest.marketWatch.some((m) => m.recommendation?.id === pastPeak.id)).toBe(false);
    const kept = digest.marketWatch.find((m) => m.recommendation?.id === futurePeak.id);
    expect(kept).toBeDefined();
    expect(kept?.recommendation?.params.actByDate).toBe("2026-10-20");
  });

  it("market.recommendations.list (the assistant's tool) drops the same past-peak item", async () => {
    const s = await shop("List Tees");
    const monday = mondayPhoenix("2026-09-28");
    const createdAt = new Date(monday.getTime() - 2 * DAY_MS);
    const pastPeak = await recommendation(s.id, {
      rule: "R1",
      band: "medium",
      createdAt,
      params: {
        designName: "Spooky Tee 2",
        channels: ["etsy"],
        peakMonth: 9,
        actByDate: "2026-08-01",
      },
    });
    const futurePeak = await recommendation(s.id, {
      rule: "R1",
      band: "medium",
      createdAt,
      params: {
        designName: "Turkey Tee 2",
        channels: ["etsy"],
        peakMonth: 10,
        actByDate: "2026-10-20",
      },
    });

    freeze(new Date(monday.getTime() + 8 * 60 * 60_000).toISOString()); // Monday 08:00 Phoenix
    const page = await rpc<{ items: MarketRecommendation[]; nextCursor: string | null }>(
      "market.recommendations.list",
      { limit: 50 },
      s.owner,
    );
    expect(page.items.some((r) => r.id === pastPeak.id)).toBe(false);
    expect(page.items.some((r) => r.id === futurePeak.id)).toBe(true);
  });
});

/* -------------------------------------------------------------------------------------------- */
/* AC2: a peak under way renders "season is on now" wording, with no act-by date shown.           */
/* -------------------------------------------------------------------------------------------- */

describe("AC2 (T-20-1): the R1 email line for a peak under way uses 'season is on now' wording", () => {
  it("en: 'season is on now', no act-by month or 'before'; es: 'ya empezó', no 'antes de'", () => {
    const rec: MarketRecommendation = {
      id: crypto.randomUUID(),
      rule: "R1",
      action: "list_and_stock",
      target: { designId: null, designName: "Spirit Tee", niche: null, channel: null },
      params: {
        designName: "Spirit Tee",
        channels: ["etsy"],
        peakMonth: 9,
        niche: "halloween",
        // No actByDate: the peak is under way, so no act-by date is carried or shown (AC2).
      },
      confidence: 0.7,
      band: "medium",
      mock: true,
      sources: [],
      evidenceSignalIds: [],
      stale: false,
      shownIn: null,
      shownAt: null,
      vote: null,
      votedAt: null,
      adoptedAt: null,
      outcome: null,
      createdAt: "2026-09-28T14:00:00.000Z",
    };
    const insight: RenderInsight = {
      id: "i1",
      detector: "market",
      action: { kind: "market", params: { designName: "Spirit Tee" }, href: "/catalog/designs" },
      facts: [],
      recommendation: rec,
    };
    const model: RenderModel = {
      shopName: "Spooky Shop",
      weekStart: "2026-09-28",
      weekEnd: "2026-10-05",
      glance: [],
      net: null,
      netChange: null,
      steady: false,
      incompleteOrders: 0,
      partialChannels: [],
      actions: [],
      win: null,
      marketWatch: [insight],
      unsubscribeUrl: "https://example.test/u",
      manageUrl: "https://example.test/m",
    };

    for (const [lang, mustContain, mustNotContain] of [
      ["en", "season is on now", ["before", "September"]],
      ["es", "ya empezó", ["antes de", "septiembre"]],
    ] as const) {
      const parts = renderParts(model, lang, { footer: false });
      const titleIdx = parts.findIndex((p) => p.key === "market.title");
      expect(titleIdx).toBeGreaterThanOrEqual(0);
      const actionPart = parts[titleIdx + 1];
      expect(actionPart).toBeDefined();
      const text = expand(actionPart as (typeof parts)[number], lang);
      expect(text.toLowerCase()).toContain(mustContain);
      for (const bad of mustNotContain) expect(text.toLowerCase()).not.toContain(bad.toLowerCase());
    }
  });
});

/* -------------------------------------------------------------------------------------------- */
/* AC4: mock market sources stamp asOf as the end of the last complete ISO week, never a future   */
/* date, even on a Monday morning.                                                                */
/* -------------------------------------------------------------------------------------------- */

describe("AC4 (T-20-1): mock demand series asOf is the last complete ISO week, never after now", () => {
  it("on Monday 2026-09-28, asOf is Sunday 2026-09-27 end-of-day, not the current (partial) week", () => {
    freeze("2026-09-28T15:00:00.000Z");
    const series = mockDemandSeries(
      "google_trends",
      "public_dataset",
      "halloween shirt",
      "week",
      1,
    );
    const now = new Date();
    expect(new Date(series.asOf).getTime()).toBeLessThanOrEqual(now.getTime());
    const lastCompleteWeek = isoWeek(new Date("2026-09-27T12:00:00.000Z"));
    expect(series.asOf).toBe(periodEndIso(lastCompleteWeek, "week"));
  });
});

/* -------------------------------------------------------------------------------------------- */
/* AC5: Today's overdue-label alert shows a readable shop-local date, never a raw ISO timestamp.  */
/* -------------------------------------------------------------------------------------------- */

describe("AC5 (T-20-1): the overdue alert message has no raw ISO timestamp", () => {
  it("shows 'Sep 26' (shop time zone) instead of shipBy.toISOString()", async () => {
    const company = await createCompany();
    const owner = await createUser(company.id, "owner");
    const ctx = tenantContext(company.id, owner.id, "owner");
    await createLocation(company.id);
    const conn = await createConnection(company.id);
    const created = await createOrder(company.id, conn.id, { units: 1, state: "ready" });
    await withSystem((tx) =>
      tx
        .update(orders)
        .set({ shipBy: new Date("2026-09-26T15:00:00.000Z") }) // 08:00 Phoenix, clearly overdue
        .where(eq(orders.id, created.order.id)),
    );

    await withTenant(company.id, (tx) => todaySvc.generateAlerts(tx, ctx));
    const list = await withTenant(company.id, (tx) => todaySvc.listAlerts(tx, ctx, { limit: 50 }));
    const overdue = list.items.find((a) => a.kind === "order_overdue");
    expect(overdue).toBeDefined();
    expect(overdue?.message ?? "").not.toMatch(/T\d{2}:\d{2}:\d{2}/);
    expect(overdue?.message ?? "").toContain("Sep 26");
  });
});
