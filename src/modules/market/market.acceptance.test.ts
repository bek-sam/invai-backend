/*
 * Wave 18 acceptance tests for the market module (T-18-3), written from
 * `invai-docs/specs/market-signals.md` before the build (`acceptance-tests-first`).
 *
 * First pass, expected red until T-18-2 (providers) and T-18-3 (module) land. Types come from the
 * landed contract (0.6.0). The module itself doesn't exist yet, so `./service`, `./config` and
 * `./jobs` are loaded through `load()` (a dynamic import on a path constant): the file typechecks
 * today and each test fails on the missing module, one clear reason per test. Second pass, after
 * the stubs land: static imports, and AC18 (blank out-of-stock weeks), which needs T-18-3's
 * history schema.
 *
 * Assumed from `waves/18/wave.md` "Agreed interfaces" and the T-18-3 card: service functions are
 * `(tx, ctx, input)`; `market.computeSignals`, `market.refreshPricing` and
 * `market.trackRecommendations` take `{ companyId }`, `market.refreshDemand` takes `{}`;
 * `service.ts` exports `NICHES` with each niche's `queries`.
 *
 * Owner: qa-engineer. Implementers don't edit this file; disagreements go in their report.
 */
import type {
  DesignNiches,
  MarketRecommendation,
  MarketTrend,
  NicheTaxonomyEntry,
  SignalProvenance,
  TrendClass,
} from "@invai/contracts";
import { call } from "@orpc/server";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "../../api/context";
import { router } from "../../api/router";
import { withSystem, withTenant } from "../../db/client";
import {
  blankVariants,
  type Channel,
  channelConnections,
  designs,
  listings,
  locations,
  orderItems,
  orderItemTransitions,
  orders,
  products,
  profitLines,
  stockLevels,
  usage,
} from "../../db/schema";
import { marketPricingProvider } from "../../integrations/market";
import { getJob, runJobInline } from "../../lib/queues";
import { createCompany, createUser, tenantContext } from "../../test/fixtures";
import { periodOf } from "../billing/service";
import * as market from "./service";

/* ---- The module under test --------------------------------------------------------------- */

// `./service` and `./config` are stubs today (they throw "not implemented"); `./jobs` does not
// exist yet, so it is loaded through a path constant and the typechecker stays out of it.
const JOBS = "./jobs";
async function load<T>(path: string): Promise<T> {
  return (await import(path)) as T;
}
const service = async () => market;

const JOB = {
  refreshDemand: "market.refreshDemand",
  refreshPricing: "market.refreshPricing",
  computeSignals: "market.computeSignals",
  trackRecommendations: "market.trackRecommendations",
} as const;

/** Runs a market job inline the way the worker would (registers the module first). */
async function runMarketJob(name: (typeof JOB)[keyof typeof JOB], input: unknown) {
  await load(JOBS);
  const job = getJob(name);
  if (!job) throw new Error(`job ${name} is not registered (T-18-3 jobs.ts)`);
  return runJobInline(job, input);
}

/** The jobs for one shop in the spec's order: global refresh → pricing → signals. */
async function runShopJobs(companyId: string) {
  await runMarketJob(JOB.refreshDemand, {});
  await runMarketJob(JOB.refreshPricing, { companyId });
  await runMarketJob(JOB.computeSignals, { companyId });
}

type AnyProcedure = Parameters<typeof call>[0];
function procedureAt(path: string): AnyProcedure {
  let node: unknown = router;
  for (const key of path.split(".")) node = (node as Record<string, unknown> | undefined)?.[key];
  if (!node) throw new Error(`procedure ${path} is not on the router (T-18-3 router.ts)`);
  return node as AnyProcedure;
}
function rpc<T>(path: string, input: unknown, context: TenantContext): Promise<T> {
  return call(procedureAt(path), input as never, { context }) as Promise<T>;
}
async function codeOf(path: string, input: unknown, context: TenantContext): Promise<string> {
  try {
    await rpc(path, input, context);
    return "OK";
  } catch (err) {
    return (err as { code?: string }).code ?? String(err);
  }
}
type RecPage = { items: MarketRecommendation[]; nextCursor: string | null };
const listRecs = (input: Record<string, unknown>, ctx: TenantContext) =>
  rpc<RecPage>("market.recommendations.list", { limit: 50, ...input }, ctx);
const getNiches = (designId: string, ctx: TenantContext) =>
  rpc<DesignNiches>("market.niches.get", { designId }, ctx);

/* ---- Fixture shops shaped like Desert Bloom Tees ------------------------------------------- */

const DAY = 86_400_000;
const WEEK = 7 * DAY;
const uniq = () => crypto.randomUUID().slice(0, 12);
type Connection = typeof channelConnections.$inferSelect;
type Design = typeof designs.$inferSelect;

type Shop = { id: string; ownerId: string; owner: TenantContext; etsy: Connection };

/** A user whose email doesn't depend on the clock (the shared fixture's does; the clock is frozen). */
const user = (companyId: string, role: "owner" | "designer" | "presser" | "office") =>
  createUser(companyId, role, { email: `${role}-${uniq()}@test.local` });

/** A shop with an owner and an Etsy CSV connection (the seed's small-shop shape). */
async function shop(name = "Fixture Bloom Tees"): Promise<Shop> {
  const company = await createCompany({ name: `${name} ${uniq()}` });
  const owner = await user(company.id, "owner");
  const etsy = await connection(company.id, "etsy", "csv_only");
  return {
    id: company.id,
    ownerId: owner.id,
    owner: tenantContext(company.id, owner.id, "owner"),
    etsy,
  };
}

/** A channel connection with an explicit status: the shared fixture's default is `csv_only`. */
async function connection(
  companyId: string,
  channel: Channel,
  status: "connected" | "csv_only" = "connected",
): Promise<Connection> {
  const [row] = await withSystem((tx) =>
    tx
      .insert(channelConnections)
      .values({
        companyId,
        channel,
        name: `${channel} ${status}`,
        status,
        mode: status === "connected" ? "api" : "csv",
        provider: "mock",
        connectedAt: status === "connected" ? new Date() : null,
      })
      .returning(),
  );
  if (!row) throw new Error("connection insert failed");
  return row;
}

async function design(
  companyId: string,
  input: { name: string; tags: string[]; personalizationTemplateId?: string },
): Promise<Design> {
  const [row] = await withSystem((tx) =>
    tx
      .insert(designs)
      .values({
        companyId,
        code: `D-${uniq()}`,
        name: input.name,
        tags: input.tags,
        personalizationTemplateId: input.personalizationTemplateId,
      })
      .returning(),
  );
  if (!row) throw new Error("design insert failed");
  return row;
}

/** A blank the design is pressed on, with its stock level (R1 names it when below reorder point). */
async function blank(companyId: string, input: { onHand: number; reorderPoint: number }) {
  return withSystem(async (tx) => {
    const [variant] = await tx
      .insert(blankVariants)
      .values({
        companyId,
        brand: "Gildan",
        style: "64000",
        styleCode: "G640",
        styleName: "Softstyle Tee",
        color: "Black",
        colorCode: "BLK",
        size: "L",
        sizeCode: "L",
        sku: `G640-BLK-L-${uniq()}`,
        costCents: 385,
        reorderPoint: input.reorderPoint,
        reorderQty: 48,
      })
      .returning();
    if (!variant) throw new Error("blank insert failed");
    const [location] = await tx
      .insert(locations)
      .values({ companyId, name: `Main ${uniq()}`, isDefault: true })
      .returning();
    if (!location) throw new Error("location insert failed");
    await tx.insert(stockLevels).values({
      companyId,
      blankVariantId: variant.id,
      locationId: location.id,
      onHand: input.onHand,
      available: input.onHand,
      reorderPoint: input.reorderPoint,
      reorderQty: 48,
    });
    return variant;
  });
}

async function product(
  companyId: string,
  designId: string,
  prices: { channel: Channel; price: number }[],
) {
  const [row] = await withSystem((tx) =>
    tx
      .insert(products)
      .values({
        companyId,
        designId,
        brand: "Gildan",
        styleCode: "G640",
        name: `Softstyle ${uniq()}`,
        prices,
      })
      .returning(),
  );
  if (!row) throw new Error("product insert failed");
  return row;
}

async function listing(companyId: string, conn: Connection, designId: string, title: string) {
  const [row] = await withSystem((tx) =>
    tx
      .insert(listings)
      .values({
        companyId,
        connectionId: conn.id,
        channel: conn.channel,
        channelListingId: `L-${uniq()}`,
        title,
        state: "active",
        designId,
      })
      .returning(),
  );
  if (!row) throw new Error("listing insert failed");
  return row;
}

type SaleInput = {
  designId: string;
  weeksAgo: number;
  units: number;
  priceCents?: number;
  state?: "shipped" | "cancelled";
  cancelledFrom?: "on_sheet";
  isReprint?: boolean;
  blankVariantId?: string;
  /** Paid → shipped hours; the shop's production lead time is the median of these. */
  leadHours?: number;
  now: Date;
};

/** One order with `units` items (one item = one unit) placed `weeksAgo` weeks before `now`. */
async function sale(companyId: string, conn: Connection, s: SaleInput) {
  const placedAt = new Date(s.now.getTime() - s.weeksAgo * WEEK - 3 * DAY);
  const doneAt = new Date(placedAt.getTime() + (s.leadHours ?? 48) * 3_600_000);
  const price = s.priceCents ?? 2499;
  const state = s.state ?? "shipped";
  return withSystem(async (tx) => {
    const [order] = await tx
      .insert(orders)
      .values({
        companyId,
        connectionId: conn.id,
        channel: conn.channel,
        channelOrderId: `co-${uniq()}`,
        orderNo: uniq(),
        status: state === "cancelled" ? "cancelled" : "shipped",
        placedAt,
        shipBy: new Date(placedAt.getTime() + 3 * DAY),
        itemCount: s.units,
        subtotalCents: price * s.units,
        shippingCents: 499,
        totalCents: price * s.units + 499,
        shippedAt: state === "shipped" ? doneAt : null,
        cancelledAt: state === "cancelled" ? doneAt : null,
        cancelReason: state === "cancelled" ? "buyer_request" : null,
      })
      .returning();
    if (!order) throw new Error("order insert failed");
    const items = await tx
      .insert(orderItems)
      .values(
        Array.from({ length: s.units }, (_, i) => ({
          companyId,
          orderId: order.id,
          lineNo: 1,
          unitNo: i + 1,
          unitsInLine: s.units,
          channelLineId: "L1",
          channelSku: "FIX-SKU",
          title: "Fixture tee",
          unitPriceCents: price,
          shipBy: order.shipBy,
          state,
          stateChangedAt: doneAt,
          designId: s.designId,
          blankVariantId: s.blankVariantId,
          isReprint: s.isReprint ?? false,
          placement: "front",
          printWidthIn: 10.5,
          printHeightIn: 12,
        })),
      )
      .returning();
    if (s.cancelledFrom) {
      await tx.insert(orderItemTransitions).values(
        items.map((it) => ({
          companyId,
          orderItemId: it.id,
          orderId: order.id,
          fromState: s.cancelledFrom,
          toState: "cancelled" as const,
          actorKind: "user" as const,
          reason: "buyer cancelled after the sheet was built",
        })),
      );
    }
    return { order, items };
  });
}

/** Weekly units for the last `series.length` weeks (index 0 = the oldest week). */
async function weeklySales(
  companyId: string,
  conn: Connection,
  designId: string,
  series: number[],
  now: Date,
  extra: Partial<SaleInput> = {},
) {
  for (let i = 0; i < series.length; i++) {
    const units = series[i] ?? 0;
    if (units <= 0) continue;
    await sale(companyId, conn, { designId, weeksAgo: series.length - i, units, now, ...extra });
  }
}
const flat = (weeks: number, units: number) => Array.from({ length: weeks }, () => units);

type Costs = {
  fees: number;
  blank: number;
  transfer: number;
  label: number;
  packaging: number;
  labor: number;
  ads: number;
};
/** Profit lines for every shipped item of a design: margin = (revenue − costs) / revenue. */
async function profitFor(companyId: string, designId: string, costs: Costs) {
  await withSystem(async (tx) => {
    const rows = await tx
      .select({
        id: orderItems.id,
        orderId: orderItems.orderId,
        price: orderItems.unitPriceCents,
        placedAt: orders.placedAt,
        channel: orders.channel,
      })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .where(
        and(
          eq(orderItems.companyId, companyId),
          eq(orderItems.designId, designId),
          eq(orderItems.state, "shipped"),
        ),
      );
    const total = Object.values(costs).reduce((a, b) => a + b, 0);
    if (!rows.length) return;
    await tx.insert(profitLines).values(
      rows.map((r) => ({
        companyId,
        orderId: r.orderId,
        orderItemId: r.id,
        channel: r.channel,
        designId,
        revenueCents: r.price,
        channelFeesCents: costs.fees,
        blankCostCents: costs.blank,
        transferCostCents: costs.transfer,
        labelCostCents: costs.label,
        packagingCostCents: costs.packaging,
        laborCostCents: costs.labor,
        adsCostCents: costs.ads,
        refundsCents: 0,
        netCents: r.price - total,
        marginPct: ((r.price - total) / r.price) * 100,
        placedAt: r.placedAt,
      })),
    );
  });
}
/** Costs that leave about 19% margin at $12.99 (R2 territory: < 25% but ≥ 15%). */
const THIN_COSTS: Costs = {
  fees: 195,
  blank: 285,
  transfer: 150,
  label: 300,
  packaging: 45,
  labor: 80,
  ads: 0,
};
/** Costs that leave about 38% margin at $24.99. */
const HEALTHY_COSTS: Costs = {
  fees: 325,
  blank: 385,
  transfer: 210,
  label: 450,
  packaging: 45,
  labor: 120,
  ads: 0,
};

/** Uses up the shop's AI credits for the current period (the wave 8 pattern). */
async function exhaustCredits(companyId: string) {
  await withSystem((tx) =>
    tx.insert(usage).values({ companyId, period: periodOf().key, aiCredits: 100_000 }),
  );
}

/** md5 of every row of `table` for one company: unchanged digest = the table wasn't written. */
async function digest(companyId: string, tables: readonly string[]) {
  return withSystem(async (tx) => {
    const out: Record<string, string> = {};
    for (const t of tables) {
      const r = await tx.execute<{ d: string }>(
        sql.raw(
          `select coalesce(md5(string_agg(x::text, '|' order by x::text)), '') as d from (select * from "${t}" where company_id = '${companyId}') x`,
        ),
      );
      out[t] = r.rows[0]?.d ?? "";
    }
    return out;
  });
}
/** Every table a market answer or recommendation must never write (spec AC16). */
const BUSINESS_TABLES = [
  "designs",
  "products",
  "listings",
  "listing_variants",
  "channel_connections",
  "orders",
  "order_items",
  "ad_spend",
  "cost_settings",
  "blank_variants",
  "stock_levels",
  "inventory_movements",
  "purchase_orders",
] as const;

function freeze(at: string) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(at));
  return new Date(at);
}
const isOwn = (p: SignalProvenance) => p.source === "own";
const isOutside = (p: SignalProvenance) => p.source !== "own" && p.source !== "census";
const ownReading = (t: MarketTrend) => t.readings.find((r) => r.provenance.source === "own");

/* ============================================================================================ */

describe("T-18-3 happy path on a fixture shop (spec AC1, AC3)", () => {
  let s: Shop;
  let pumpkin: Design;
  let teacher: Design;
  let odd: Design;
  // AC3 pins the calendar: the shop is looked at on 2026-09-01, Halloween's peak ≤ 10 weeks away.
  const NOW = "2026-09-01T16:00:00.000Z";

  beforeAll(async () => {
    s = await shop();
    const now = freeze(NOW);
    // Connected but the design isn't listed there: the seed's Amazon is csv_only, so a fixture.
    await connection(s.id, "amazon", "connected");
    pumpkin = await design(s.id, { name: "Spooky Pumpkin Ghost", tags: ["halloween", "ghost"] });
    teacher = await design(s.id, { name: "Best Teacher Ever", tags: ["teacher", "classroom"] });
    odd = await design(s.id, { name: "Zorbnak Quux", tags: ["zorbnak"] });
    const blankId = (await blank(s.id, { onHand: 4, reorderPoint: 24 })).id;
    await product(s.id, pumpkin.id, [{ channel: "etsy", price: 24.99 }]);
    await listing(s.id, s.etsy, pumpkin.id, "Spooky Pumpkin Ghost tee");
    // 30 weeks of steady sales on Etsy only, pressed on the tracked blank, 48 h paid → shipped.
    await weeklySales(s.id, s.etsy, pumpkin.id, flat(30, 3), now, {
      blankVariantId: blankId,
      leadHours: 48,
    });
    await weeklySales(s.id, s.etsy, teacher.id, flat(30, 2), now);
    await runShopJobs(s.id);
  }, 120_000);
  afterAll(() => vi.useRealTimers());

  it("AC1: after the jobs, every active design has 1–2 taxonomy niches or is unclassified", async () => {
    const { NICHES } = await service();
    const keys = new Set(NICHES.map((n) => n.key));
    for (const d of [pumpkin, teacher, odd]) {
      const got = await getNiches(d.id, s.owner);
      expect(got.niches.length, d.name).toBeLessThanOrEqual(2);
      for (const k of got.niches) expect(keys.has(k), `${d.name}: ${k}`).toBe(true);
      if (got.niches.length === 0) expect(got.source).toBe("unclassified");
    }
    expect((await getNiches(pumpkin.id, s.owner)).niches).toContain("halloween");
    const t = await getNiches(teacher.id, s.owner);
    expect(t.niches).toContain("teacher");
    expect(t.source).toBe("stems");
  });

  it("AC1: signals exist for each classified design with source, asOf, n, confidence and mock: true on outside sources", async () => {
    const svc = await service();
    for (const d of [pumpkin, teacher]) {
      const trend = await withTenant(s.id, (tx) =>
        svc.getTrendSignal(tx, s.owner, { designId: d.id }),
      );
      expect(trend.sources.length, d.name).toBeGreaterThan(0);
      for (const p of trend.sources) {
        expect(new Date(p.asOf).getTime(), `${p.source} asOf`).not.toBeNaN();
        expect(new Date(p.fetchedAt).getTime(), `${p.source} fetchedAt`).not.toBeNaN();
        if (isOutside(p)) expect(p.mock, p.source).toBe(true);
        if (isOwn(p)) expect(p.licence).toBe("first_party");
      }
      expect(trend.confidence).toBeGreaterThanOrEqual(0);
      expect(trend.confidence).toBeLessThanOrEqual(1);
      expect(["high", "medium", "low"]).toContain(trend.band);
      expect(trend.mock).toBe(trend.sources.some((p) => p.mock));
      expect(ownReading(trend)?.n, `${d.name} own points`).toBe(30);
    }
  });

  it("AC3: on 2026-09-01 a Halloween design gets October as a peak, an act-by date from the shop's lead time, and R1 says list on Amazon and stock its blank", async () => {
    const svc = await service();
    const season = await withTenant(s.id, (tx) =>
      svc.getSeasonalitySignal(tx, s.owner, { designId: pumpkin.id }),
    );
    expect(season.peakMonths).toContain(10);
    expect(season.actBy).not.toBeNull();
    // 48 h paid → shipped rounds up to 1 week, plus the 3-week listing ramp.
    expect(season.actBy?.leadTimeWeeks).toBe(4);
    expect(season.actBy?.peakMonth === 9 || season.actBy?.peakMonth === 10).toBe(true);
    const actBy = new Date(`${season.actBy?.date}T00:00:00Z`).getTime();
    expect(actBy).toBeLessThanOrEqual(new Date("2026-10-01T00:00:00Z").getTime());
    expect(actBy).toBeGreaterThanOrEqual(new Date("2026-07-01T00:00:00Z").getTime());

    const recs = await withTenant(s.id, (tx) =>
      svc.listRecommendations(tx, s.owner, { designId: pumpkin.id, limit: 20 }),
    );
    const r1 = recs.find((r) => r.rule === "R1");
    expect(r1, `rules: ${recs.map((r) => r.rule).join(",")}`).toBeDefined();
    expect(r1?.action).toBe("list_and_stock");
    expect(r1?.params.channels).toEqual(["amazon"]); // already on Etsy; only the missing channel
    expect(r1?.params.blankName).toMatch(/G640|Softstyle/);
    expect(r1?.params.blankBelowReorderPoint).toBe(true); // on hand 4 < reorder point 24
    expect(r1?.params.peakMonth === 9 || r1?.params.peakMonth === 10).toBe(true);
    expect(r1?.params.actByDate).toBe(season.actBy?.date);
    expect(r1?.band).not.toBe("low");
    expect(r1?.target.designId).toBe(pumpkin.id);
  });
});

/* ============================================================================================ */

describe("T-18-3 own history and comparables (spec AC17, AC19, AC6)", () => {
  let s: Shop;
  let amazon: Connection;
  let tee: Design;
  let custom: Design;
  const NOW = "2026-09-15T16:00:00.000Z";

  beforeAll(async () => {
    s = await shop();
    const now = freeze(NOW);
    amazon = await connection(s.id, "amazon", "connected");
    tee = await design(s.id, { name: "Dog Mom Life", tags: ["dog mom", "dogs"] });
    // 60 weeks × 3 units: last 4 weeks = 12 units, the same 4 weeks a year earlier = 12 → yoy 0.
    await weeklySales(s.id, s.etsy, tee.id, flat(60, 3), now);
    // Contamination inside the last 4 weeks: 5 units cancelled after on_sheet, 3 reprints.
    await sale(s.id, s.etsy, {
      designId: tee.id,
      weeksAgo: 2,
      units: 5,
      state: "cancelled",
      cancelledFrom: "on_sheet",
      now,
    });
    await sale(s.id, s.etsy, { designId: tee.id, weeksAgo: 1, units: 3, isReprint: true, now });
    custom = await design(s.id, {
      name: "Custom Name Dog Mom",
      tags: ["dog mom", "personalized"],
      personalizationTemplateId: crypto.randomUUID(),
    });
    await weeklySales(s.id, amazon, custom.id, flat(20, 2), now);
    await runShopJobs(s.id);
  }, 120_000);
  afterAll(() => vi.useRealTimers());

  it("AC17: an item cancelled after on_sheet and a reprint are not sold units (own yoy stays 0)", async () => {
    const svc = await service();
    const trend = await withTenant(s.id, (tx) =>
      svc.getTrendSignal(tx, s.owner, { designId: tee.id }),
    );
    const own = ownReading(trend);
    expect(own, "an own reading (60 weeks ≥ the 56 yoy needs)").toBeDefined();
    // 12 real units ÷ 12 last year − 1 = 0. Counting the 8 bad units would give 20 ÷ 12 − 1 = 0.67.
    expect(own?.yoy).toBeCloseTo(0, 6);
    expect(own?.trend).not.toBe("insufficient");
  });

  it("AC17 (hand SQL): the shipped, non-reprint unit count for the contaminated week is 3", async () => {
    const weekStart = new Date(new Date(NOW).getTime() - WEEK - 4 * DAY);
    const weekEnd = new Date(weekStart.getTime() + WEEK);
    const rows = await withSystem((tx) =>
      tx.execute<{ n: number }>(sql`
        select count(*)::int as n from order_items i join orders o on o.id = i.order_id
        where i.company_id = ${s.id} and i.design_id = ${tee.id}
          and i.state <> 'cancelled' and i.is_reprint = false
          and o.placed_at >= ${weekStart} and o.placed_at < ${weekEnd}`),
    );
    expect(rows.rows[0]?.n).toBe(3);
  });

  it("AC19: a personalized design compares only against personalized comparables (mock Amazon)", async () => {
    const provider = marketPricingProvider({
      sampleWorkspace: false,
      channel: "amazon",
      connection: amazon,
    });
    expect(provider?.mock).toBe(true);
    if (!provider) return;
    // Spec step 2.5 filters comparables on the personalization flag, so the provider must take it
    // on the own item and mark it on each observation. T-18-2's stub has neither yet.
    type OwnItem = Parameters<typeof provider.comparables>[1][number] & { personalized?: boolean };
    const own = (personalized: boolean): OwnItem => ({
      ref: custom.id,
      keywords: ["custom name dog mom shirt"],
      garmentClass: "tee",
      personalized,
    });
    const [plain] = await provider.comparables(amazon, [own(false)]);
    const [personal] = await provider.comparables(amazon, [own(true)]);
    expect(plain?.observations.length).toBeGreaterThanOrEqual(8);
    expect(personal?.observations.length).toBeGreaterThanOrEqual(8);
    expect(personal?.observations).not.toEqual(plain?.observations);
    const flagged = (personal?.observations ?? []).filter(
      (o) => (o as { personalized?: boolean }).personalized === true,
    );
    expect(flagged.length).toBe(personal?.observations.length);

    const svc = await service();
    const pos = await withTenant(s.id, (tx) =>
      svc.getPricePosition(tx, s.owner, { designId: custom.id, channel: "amazon" }),
    );
    expect(pos.n).toBeLessThanOrEqual(flagged.length);
    if (!pos.available) expect(pos.reason).toBe("too_few_comparables");
  });

  it("AC6: price position on Etsy is `available: false` with a reason, and simulate_price still answers from own data", async () => {
    const svc = await service();
    const pos = await withTenant(s.id, (tx) =>
      svc.getPricePosition(tx, s.owner, { designId: tee.id, channel: "etsy" }),
    );
    expect(pos.available).toBe(false);
    if (!pos.available) expect(pos.reason).toBe("no_compliant_source");
    await profitFor(s.id, tee.id, HEALTHY_COSTS);
    const sim = await withTenant(s.id, (tx) =>
      svc.simulatePrice(tx, s.owner, { designId: tee.id, channel: "etsy", prices: [2499, 2749] }),
    );
    expect(sim.incomplete).toBe(false);
    expect(sim.missing).toEqual([]);
    expect(sim.candidates.length).toBeLessThanOrEqual(20);
    const p0 = sim.candidates.find((c) => c.priceCents === 2499);
    expect(p0).toBeDefined();
    // Hand calculation at p0: 2499 + 499 shipping − 1535 costs = 1463 net (fees at 13% of price).
    expect(Number.isInteger(p0?.netPerUnitCents)).toBe(true);
    expect(p0?.netPerUnitCents).toBeGreaterThan(0);
    expect(p0?.marginPct).toBeGreaterThan(0);
    expect(p0?.marginPct).toBeLessThan(100);
    expect(sim.candidates.some((c) => c.origin === "requested" && c.priceCents === 2749)).toBe(
      true,
    );
    expect(sim.sources.every((p) => p.source === "own")).toBe(true);
  });
});

/* ============================================================================================ */

describe("T-18-3 disagreement and stale reads (spec AC8, AC10)", () => {
  let s: Shop;
  let d: Design;
  let niche = "";
  let outside: TrendClass = "flat";
  const NOW = "2026-09-20T16:00:00.000Z";

  beforeAll(async () => {
    s = await shop();
    const now = freeze(NOW);
    await runMarketJob(JOB.refreshDemand, {});
    await runMarketJob(JOB.computeSignals, { companyId: s.id });
    // Find a niche whose outside mock trend has a direction, then sell the opposite way.
    const svc = await service();
    for (const n of svc.NICHES.slice(0, 24)) {
      const t = await withTenant(s.id, (tx) => svc.getTrendSignal(tx, s.owner, { niche: n.key }));
      if (t.trend === "rising" || t.trend === "falling") {
        niche = n.key;
        outside = t.trend;
        break;
      }
    }
    if (!niche) throw new Error("no mock niche series is rising or falling (T-18-2 AC1 shapes)");
    d = await design(s.id, { name: `${niche} design`, tags: [niche] });
    // Own units grow 6%/week when the outside falls, shrink 6%/week when it rises (30 weeks).
    const own = Array.from({ length: 30 }, (_, i) =>
      Math.round(outside === "falling" ? 3 * 1.06 ** i : 18 * 0.94 ** i),
    );
    await weeklySales(s.id, s.etsy, d.id, own, now);
    await runMarketJob(JOB.computeSignals, { companyId: s.id });
  }, 180_000);
  afterAll(() => vi.useRealTimers());

  it("AC8: own data and the outside mock pointing different ways sets the disagreement flag and caps the band below high", async () => {
    const svc = await service();
    const t = await withTenant(s.id, (tx) => svc.getTrendSignal(tx, s.owner, { designId: d.id }));
    const own = ownReading(t);
    expect(own?.trend, `own series built to oppose the outside ${outside}`).toBe(
      outside === "falling" ? "rising" : "falling",
    );
    expect(t.readings.some((r) => r.provenance.source !== "own" && r.trend === outside)).toBe(true);
    expect(t.disagreement).toBe(true);
    // a = 0.4 caps confidence at 0.4: never high, and never an averaged single direction.
    expect(t.band).not.toBe("high");
    expect(t.confidence).toBeLessThanOrEqual(0.4 + 1e-9);
  });

  it("AC10: signals older than 2× their source TTL read as stale with a lower confidence and the same sources", async () => {
    const svc = await service();
    const fresh = await withTenant(s.id, (tx) =>
      svc.getTrendSignal(tx, s.owner, { designId: d.id }),
    );
    expect(fresh.stale).toBe(false);
    vi.setSystemTime(new Date(new Date(NOW).getTime() + 61 * DAY)); // > 2 × the 30-day Census TTL
    const old = await withTenant(s.id, (tx) => svc.getTrendSignal(tx, s.owner, { designId: d.id }));
    expect(old.stale).toBe(true);
    expect(old.confidence).toBeLessThan(fresh.confidence);
    // The source and date line survives: the provenance is still on the signal, unchanged.
    expect(old.sources.map((p) => [p.source, p.asOf])).toEqual(
      fresh.sources.map((p) => [p.source, p.asOf]),
    );
  });
});

/* ============================================================================================ */

describe("T-18-3 read-only, credits, corrections (spec AC16, AC21, AC25, AC32 backend)", () => {
  let s: Shop;
  let d: Design;
  let designer: TenantContext;
  const NOW = "2026-09-15T16:00:00.000Z";

  beforeAll(async () => {
    s = await shop();
    designer = tenantContext(s.id, (await user(s.id, "designer")).id, "designer");
    const now = freeze(NOW);
    d = await design(s.id, { name: "Pumpkin Patch Crew", tags: ["halloween", "pumpkin"] });
    await product(s.id, d.id, [{ channel: "etsy", price: 22.99 }]);
    await weeklySales(s.id, s.etsy, d.id, flat(20, 2), now);
    await profitFor(s.id, d.id, HEALTHY_COSTS);
  }, 120_000);
  afterAll(() => vi.useRealTimers());

  it("AC16: the jobs, the reads and a vote write no business table", async () => {
    const before = await digest(s.id, BUSINESS_TABLES);
    await runShopJobs(s.id);
    const svc = await service();
    await withTenant(s.id, async (tx) => {
      await svc.getTrendSignal(tx, s.owner, { designId: d.id });
      await svc.getSeasonalitySignal(tx, s.owner, { designId: d.id });
      await svc.getPricePosition(tx, s.owner, { designId: d.id, channel: "etsy" });
      await svc.simulatePrice(tx, s.owner, { designId: d.id, channel: "etsy" });
    });
    const recs = await listRecs({}, s.owner);
    const first = recs.items[0];
    if (first) await rpc("market.recommendations.vote", { id: first.id, vote: "done" }, s.owner);
    const after = await digest(s.id, BUSINESS_TABLES);
    expect(after).toEqual(before);
  });

  it("AC16: the module's source never writes a catalog, listing, price, ad, stock or PO table", async () => {
    const fs = await import("node:fs/promises");
    const dir = new URL("./", import.meta.url);
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".ts") && !f.includes(".test."));
    expect(files).toContain("service.ts");
    const forbidden =
      /\.(insert|update|delete)\(\s*(listings|listingVariants|products|designs|adSpend|costSettings|purchaseOrders|stockLevels|inventoryMovements|channelConnections)\b/;
    for (const f of files) {
      const src = await fs.readFile(new URL(f, dir), "utf8");
      expect(src, f).not.toMatch(forbidden);
    }
  });

  it("AC21: with no AI credits the model fallback is skipped, the design stays unclassified and own-data signals still compute", async () => {
    await exhaustCredits(s.id);
    const odd = await design(s.id, { name: "Zorbnak Quux Two", tags: ["zorbnak"] });
    await weeklySales(s.id, s.etsy, odd.id, flat(14, 2), new Date(NOW));
    await runMarketJob(JOB.computeSignals, { companyId: s.id });
    const got = await getNiches(odd.id, s.owner);
    expect(got.niches).toEqual([]);
    expect(got.source).toBe("unclassified");
    const svc = await service();
    const t = await withTenant(s.id, (tx) => svc.getTrendSignal(tx, s.owner, { designId: odd.id }));
    expect(ownReading(t)?.n).toBe(14);
    expect(t.sources.filter(isOutside)).toEqual([]);
  });

  it("AC25: a shop's niche correction survives the next mapper run", async () => {
    await rpc("market.niches.set", { designId: d.id, niches: ["teacher"] }, s.owner);
    await runMarketJob(JOB.computeSignals, { companyId: s.id });
    const got = await getNiches(d.id, s.owner);
    expect(got.niches).toEqual(["teacher"]);
    expect(got.source).toBe("correction");
  });

  it("AC32 (backend): a designer may set up to 2 niches, a third or an unknown key is refused, and clearing both returns to unclassified", async () => {
    const set = (niches: string[]) =>
      rpc<DesignNiches>("market.niches.set", { designId: d.id, niches }, designer);
    expect((await set(["halloween", "retirement"])).niches).toEqual(["halloween", "retirement"]);
    expect((await getNiches(d.id, designer)).niches).toEqual(["halloween", "retirement"]);
    expect(
      await codeOf(
        "market.niches.set",
        { designId: d.id, niches: ["halloween", "retirement", "teacher"] },
        designer,
      ),
    ).toBe("BAD_REQUEST");
    expect(
      await codeOf("market.niches.set", { designId: d.id, niches: ["not-a-niche"] }, designer),
    ).toBe("UNKNOWN_NICHE");
    expect((await set([])).niches).toEqual([]);
    const cleared = await getNiches(d.id, designer);
    expect(cleared.niches).toEqual([]);
    expect(cleared.source).not.toBe("correction");
  });

  it("AC32 (backend): the taxonomy lists 69 niches with en and es labels, and nicheLabel matches", async () => {
    const tax = await rpc<{ items: NicheTaxonomyEntry[] }>("market.niches.taxonomy", {}, designer);
    expect(tax.items.length).toBe(69);
    const { nicheLabel } = await service();
    for (const n of tax.items) {
      expect(n.labelEn.trim()).not.toBe("");
      expect(n.labelEs.trim()).not.toBe("");
      expect(nicheLabel(n.key, "en")).toBe(n.labelEn);
      expect(nicheLabel(n.key, "es")).toBe(n.labelEs);
    }
    expect(tax.items.find((n) => n.key === "halloween")?.peakMonths).toEqual([9, 10]);
  });
});

/* ============================================================================================ */

describe("T-18-3 tenancy and permissions (spec AC23, AC24)", () => {
  let a: Shop;
  let b: Shop;
  let designA: Design;
  let designB: Design;

  beforeAll(async () => {
    a = await shop("Shop A");
    b = await shop("Shop B");
    const now = freeze("2026-09-15T16:00:00.000Z");
    designA = await design(a.id, { name: "Ghost Crew A", tags: ["halloween"] });
    designB = await design(b.id, { name: "Ghost Crew B", tags: ["halloween"] });
    await product(a.id, designA.id, [{ channel: "etsy", price: 19.99 }]);
    await weeklySales(a.id, a.etsy, designA.id, flat(30, 4), now);
    await profitFor(a.id, designA.id, { ...HEALTHY_COSTS, ads: 200 });
    await runShopJobs(a.id);
  }, 120_000);
  afterAll(() => vi.useRealTimers());

  it("AC23: A's jobs wrote only A's rows; B sees nothing of A in any market tenant table", async () => {
    const svc = await service();
    const recsB = await withTenant(b.id, (tx) =>
      svc.listRecommendations(tx, b.owner, { limit: 50 }),
    );
    expect(recsB).toEqual([]);
    const tB = await withTenant(b.id, (tx) =>
      svc.getTrendSignal(tx, b.owner, { designId: designB.id }),
    );
    expect(ownReading(tB)?.n ?? 0).toBe(0);
    const tables = await withSystem((tx) =>
      tx.execute<{ table_name: string }>(sql`
        select table_name from information_schema.columns
        where table_schema = 'public' and column_name = 'company_id' and table_name like 'market_%'`),
    );
    // Design niches, price snapshots, signals, recommendations at least (T-18-3 AC1).
    expect(tables.rows.length).toBeGreaterThanOrEqual(4);
    for (const { table_name } of tables.rows) {
      const forB = await withSystem((tx) =>
        tx.execute<{ n: number }>(
          sql.raw(`select count(*)::int as n from "${table_name}" where company_id = '${b.id}'`),
        ),
      );
      expect(forB.rows[0]?.n, `${table_name} rows for B`).toBe(0);
    }
    const signalsForA = await withSystem((tx) =>
      tx.execute<{ n: number }>(
        sql.raw(`select count(*)::int as n from market_signals where company_id = '${a.id}'`),
      ),
    );
    expect(signalsForA.rows[0]?.n).toBeGreaterThan(0);
  });

  it("AC23: the global cache has no shop id and holds only taxonomy queries (ADR 0015)", async () => {
    const cols = await withSystem((tx) =>
      tx.execute<{ column_name: string }>(sql`
        select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'market_series_cache'`),
    );
    const names = cols.rows.map((c) => c.column_name);
    expect(names.length).toBeGreaterThan(0);
    expect(names).not.toContain("company_id");
    expect(names.some((n) => /tenant|shop|org|design/.test(n))).toBe(false);
    const { NICHES } = await service();
    const allowed = new Set(NICHES.flatMap((n) => n.queries));
    const qs = await withSystem((tx) =>
      tx.execute<{ query: string; source: string }>(
        sql`select distinct query, source from market_series_cache`,
      ),
    );
    expect(qs.rows.length).toBeGreaterThan(0);
    for (const row of qs.rows) {
      if (row.source === "census") continue; // NAICS 448 macro series, no taxonomy query
      expect(allowed.has(row.query), `${row.source}: ${row.query}`).toBe(true);
    }
  });

  it("AC24: designer sets niches but is refused recommendations; presser is refused everything; another shop's ids are NOT_FOUND", async () => {
    const designer = tenantContext(a.id, (await user(a.id, "designer")).id, "designer");
    const presser = tenantContext(a.id, (await user(a.id, "presser")).id, "presser");
    const office = tenantContext(a.id, (await user(a.id, "office")).id, "office");
    const setA = { designId: designA.id, niches: ["halloween"] };
    const someVote = { id: crypto.randomUUID(), vote: "done" };

    expect(await codeOf("market.niches.set", setA, designer)).toBe("OK");
    expect(await codeOf("market.niches.get", { designId: designA.id }, designer)).toBe("OK");
    expect(await codeOf("market.niches.taxonomy", {}, designer)).toBe("OK");
    expect(await codeOf("market.recommendations.list", { limit: 10 }, designer)).toBe("FORBIDDEN");
    expect(await codeOf("market.recommendations.vote", someVote, designer)).toBe("FORBIDDEN");

    const all: [string, unknown][] = [
      ["market.niches.taxonomy", {}],
      ["market.niches.get", { designId: designA.id }],
      ["market.niches.set", setA],
      ["market.recommendations.list", { limit: 10 }],
      ["market.recommendations.vote", someVote],
    ];
    for (const [path, input] of all)
      expect(await codeOf(path, input, presser), path).toBe("FORBIDDEN");

    expect(await codeOf("market.niches.set", setA, office)).toBe("OK");
    expect(await codeOf("market.recommendations.list", { limit: 10 }, office)).toBe("OK");

    // Another shop's ids: NOT_FOUND, never FORBIDDEN, never a row.
    expect(await codeOf("market.niches.get", { designId: designB.id }, a.owner)).toBe("NOT_FOUND");
    expect(
      await codeOf("market.niches.set", { designId: designB.id, niches: ["teacher"] }, a.owner),
    ).toBe("NOT_FOUND");
    const recsA = await listRecs({ limit: 5 }, a.owner);
    const one = recsA.items[0];
    expect(one, "shop A has at least one recommendation to probe with").toBeDefined();
    if (one) {
      expect(
        await codeOf("market.recommendations.vote", { id: one.id, vote: "done" }, b.owner),
      ).toBe("NOT_FOUND");
      expect((await listRecs({ ids: [one.id] }, b.owner)).items).toEqual([]);
    }
    expect((await getNiches(designB.id, b.owner)).niches).not.toContain("teacher");
  });
});

/* ============================================================================================ */

describe("T-18-3 feedback: votes, adoption, outcome (spec AC26, AC27, AC30, AC33 backend)", () => {
  let s: Shop;
  let amazon: Connection;
  let bear: Design;
  let bearProduct: typeof products.$inferSelect;
  const NOW = "2026-09-15T16:00:00.000Z";
  const P0 = 1299; // well below any $5–$80 comparable set's median

  /** A design listed on Amazon at p0 with thin margin and a flat 30 weeks: R2 territory. */
  async function thinAmazonDesign(name: string, now: Date) {
    const d = await design(s.id, { name, tags: ["camping", "retro"] });
    const p = await product(s.id, d.id, [{ channel: "amazon", price: P0 / 100 }]);
    await listing(s.id, amazon, d.id, `${name} tee`);
    await weeklySales(s.id, amazon, d.id, flat(30, 4), now, { priceCents: P0 });
    await profitFor(s.id, d.id, THIN_COSTS);
    return { d, p };
  }
  const r2For = async (designId: string) =>
    (await listRecs({ designId }, s.owner)).items.find((r) => r.rule === "R2");

  beforeAll(async () => {
    s = await shop();
    const now = freeze(NOW);
    amazon = await connection(s.id, "amazon", "connected");
    ({ d: bear, p: bearProduct } = await thinAmazonDesign("Retro Camping Bear", now));
    await runShopJobs(s.id);
  }, 120_000);
  afterAll(() => vi.useRealTimers());

  it("AC30 (backend): a recommendation built on mock comparables is flagged mock with a mock source; own-data ones are not", async () => {
    const recs = await listRecs({}, s.owner);
    const r2 = recs.items.find((r) => r.rule === "R2");
    expect(r2, "R2 rests on the mock Amazon comparables").toBeDefined();
    expect(r2?.mock).toBe(true);
    expect(r2?.sources.some((p) => p.mock && p.source === "amazon_pricing")).toBe(true);
    expect(r2?.action).toBe("price_test_up");
    expect(r2?.params.testPriceMinCents).toBeGreaterThanOrEqual(Math.round(P0 * 1.05));
    expect(r2?.params.testPriceMaxCents).toBeLessThanOrEqual(r2?.params.comparableMedianCents ?? 0);
    for (const r of recs.items) {
      expect(r.mock, `${r.rule} mock flag matches its sources`).toBe(r.sources.some((p) => p.mock));
    }
  });

  it("AC27: tapping 'Not useful' twice stores one vote, and the vote wins over adoption detection", async () => {
    const r2 = await r2For(bear.id);
    expect(r2, "an R2 price test on the Amazon-priced design").toBeDefined();
    if (!r2) return;
    const vote = () =>
      rpc<MarketRecommendation>(
        "market.recommendations.vote",
        { id: r2.id, vote: "not_useful" },
        s.owner,
      );
    const first = await vote();
    const second = await vote();
    expect(first.vote).toBe("not_useful");
    expect(second.vote).toBe("not_useful");
    expect(second.votedAt).toBe(first.votedAt);
    // Now the shop raises the price 6% anyway; the explicit vote still wins.
    await withSystem((tx) =>
      tx
        .update(products)
        .set({ prices: [{ channel: "amazon", price: (P0 * 1.06) / 100 }] })
        .where(eq(products.id, bearProduct.id)),
    );
    vi.setSystemTime(new Date(new Date(NOW).getTime() + 10 * DAY));
    await runMarketJob(JOB.trackRecommendations, { companyId: s.id });
    const after = (await listRecs({ ids: [r2.id] }, s.owner)).items[0];
    expect(after?.vote).toBe("not_useful");
    expect(after?.votedAt).toBe(first.votedAt);
    expect(after?.adoptedAt).toBeNull();
    expect(after?.outcome).not.toBe("improved");
  });

  it("AC26: an unvoted R2 is marked adopted when the price moves ≥ 3% up within 14 days, and gets an outcome 28 days after", async () => {
    const now = new Date(NOW);
    vi.setSystemTime(now);
    const { d: moose, p: mooseProduct } = await thinAmazonDesign("Retro Camping Moose", now);
    // A control design in the same garment class, steady, for the difference-in-differences.
    const fox = await design(s.id, { name: "Retro Camping Fox", tags: ["camping", "retro"] });
    await product(s.id, fox.id, [{ channel: "amazon", price: 24.99 }]);
    await weeklySales(s.id, amazon, fox.id, flat(30, 4), now, { priceCents: 2499 });
    await profitFor(s.id, fox.id, { ...HEALTHY_COSTS, fees: 375 });
    await runMarketJob(JOB.computeSignals, { companyId: s.id });
    const rec = await r2For(moose.id);
    expect(rec, "R2 for the second thin design").toBeDefined();
    if (!rec) return;

    // Day 3: the shop tests +6% on Amazon (on the product, and on every sale that follows).
    const newPrice = Math.round(P0 * 1.06);
    vi.setSystemTime(new Date(now.getTime() + 3 * DAY));
    await withSystem((tx) =>
      tx
        .update(products)
        .set({ prices: [{ channel: "amazon", price: newPrice / 100 }] })
        .where(eq(products.id, mooseProduct.id)),
    );
    for (let day = 3; day <= 31; day += 2) {
      const at = new Date(now.getTime() + (day + 3) * DAY);
      vi.setSystemTime(at);
      await sale(s.id, amazon, {
        designId: moose.id,
        weeksAgo: 0,
        units: 2,
        priceCents: newPrice,
        now: at,
      });
      await sale(s.id, amazon, {
        designId: fox.id,
        weeksAgo: 0,
        units: 1,
        priceCents: 2499,
        now: at,
      });
    }
    await profitFor(s.id, moose.id, THIN_COSTS);

    vi.setSystemTime(new Date(now.getTime() + 10 * DAY));
    await runMarketJob(JOB.trackRecommendations, { companyId: s.id });
    let seen = (await listRecs({ ids: [rec.id] }, s.owner)).items[0];
    expect(seen?.adoptedAt).not.toBeNull();
    expect(seen?.outcome).toBeNull();

    vi.setSystemTime(new Date(now.getTime() + 40 * DAY));
    await runMarketJob(JOB.trackRecommendations, { companyId: s.id });
    seen = (await listRecs({ ids: [rec.id] }, s.owner)).items[0];
    expect(["improved", "worse", "inconclusive"]).toContain(seen?.outcome);
    // Running the tracker again changes nothing (idempotent).
    await runMarketJob(JOB.trackRecommendations, { companyId: s.id });
    expect((await listRecs({ ids: [rec.id] }, s.owner)).items[0]).toEqual(seen);
  });

  it("AC33 (backend): `recommendations.list({ids})` returns exactly those records with their votes, so a reload can rebind vote cards", async () => {
    const all = await listRecs({}, s.owner);
    expect(all.items.length).toBeGreaterThanOrEqual(2);
    const ids = all.items.slice(0, 2).map((r) => r.id);
    const two = await listRecs({ ids }, s.owner);
    expect(two.items.map((r) => r.id).sort()).toEqual([...ids].sort());
    const unvoted = two.items.find((r) => r.vote === null);
    expect(unvoted, "one of the two is still unvoted").toBeDefined();
    if (!unvoted) return;
    const other = two.items.find((r) => r.id !== unvoted.id);
    await rpc("market.recommendations.vote", { id: unvoted.id, vote: "done" }, s.owner);
    const after = await listRecs({ ids }, s.owner);
    expect(after.items.find((r) => r.id === unvoted.id)?.vote).toBe("done");
    expect(after.items.find((r) => r.id === other?.id)?.vote ?? null).toBe(other?.vote ?? null);
  });
});
