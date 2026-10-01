/*
 * Wave 18 acceptance tests for the assistant's market tools (T-18-4), written from
 * `invai-docs/specs/market-signals.md` before the build (`acceptance-tests-first`).
 *
 * First pass, expected red until T-18-3 (signals, jobs) and T-18-4 (tools, prompt v5, validator)
 * land. The market module's jobs are loaded through a dynamic import on a path constant so the
 * file typechecks before `src/modules/market` exists. Runs on the mock AI provider (no key), like
 * `service.test.ts`; the real-model eval waits for OI-8.
 *
 * Owner: qa-engineer. Implementers don't edit this file; disagreements go in their report.
 */
import type { MarketRecommendation, RecommendationRef, SignalSourceRef } from "@invai/contracts";
import { call } from "@orpc/server";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "../../api/context";
import { router } from "../../api/router";
import { withSystem, withTenant } from "../../db/client";
import {
  type Channel,
  channelConnections,
  designs,
  listings,
  orderItems,
  orders,
  products,
  profitLines,
} from "../../db/schema";
import { getJob, runJobInline } from "../../lib/queues";
import { createCompany, createUser, tenantContext } from "../../test/fixtures";
import * as market from "../market/service";
import { localYmd } from "../market/signals";
import { assistantTools } from "./assistant-tools";
import * as svc from "./service";

/* ---- Market module (loaded late: it doesn't exist yet) ------------------------------------- */

const JOBS = "../market/jobs";
async function load<T>(path: string): Promise<T> {
  return (await import(path)) as T;
}
async function runMarketJob(name: string, input: unknown) {
  await load(JOBS);
  const job = getJob(name);
  if (!job) throw new Error(`job ${name} is not registered (T-18-3 jobs.ts)`);
  return runJobInline(job, input);
}
async function runShopJobs(companyId: string) {
  await runMarketJob("market.refreshDemand", {});
  await runMarketJob("market.refreshPricing", { companyId });
  await runMarketJob("market.computeSignals", { companyId });
}

type AnyProcedure = Parameters<typeof call>[0];
function procedureAt(path: string): AnyProcedure {
  let node: unknown = router;
  for (const key of path.split(".")) node = (node as Record<string, unknown> | undefined)?.[key];
  if (!node) throw new Error(`procedure ${path} is not on the router (T-18-3 router.ts)`);
  return node as AnyProcedure;
}
type RecPage = { items: MarketRecommendation[]; nextCursor: string | null };
const listRecs = (ids: string[], ctx: TenantContext) =>
  call(procedureAt("market.recommendations.list"), { ids, limit: 50 } as never, {
    context: ctx,
  }) as Promise<RecPage>;
const vote = (id: string, v: "done" | "not_useful", ctx: TenantContext) =>
  call(procedureAt("market.recommendations.vote"), { id, vote: v } as never, {
    context: ctx,
  }) as Promise<MarketRecommendation>;

/* ---- Assistant turn helpers ---------------------------------------------------------------- */

/** A streamed event with the wave 18 optional fields visible (the contract keeps them optional). */
type Ev = {
  type: string;
  name?: string;
  text?: string;
  summary?: string;
  input?: Record<string, unknown>;
  mock?: boolean;
  sources?: SignalSourceRef[];
  recommendations?: RecommendationRef[];
  conversationId?: string;
  messageId?: string;
};
type Turn = {
  events: Ev[];
  text: string;
  calls: Ev[];
  results: Ev[];
  conversationId: string;
  messageId: string;
  /** Every tool output of the turn, replayed with the same input: the oracle for the numbers. */
  outputs: { name: string; blob: string }[];
};

async function ask(ctx: TenantContext, message: string, conversationId?: string): Promise<Turn> {
  const events: Ev[] = [];
  for await (const e of svc.ask(ctx, { message, conversationId })) events.push(e as Ev);
  const done = events.at(-1);
  expect(done?.type, "the stream ends with done").toBe("done");
  const calls = events.filter((e) => e.type === "tool_call");
  const tools = assistantTools(ctx);
  const outputs: Turn["outputs"] = [];
  for (const c of calls) {
    const tool = tools.find((t) => t.name === c.name);
    if (!tool) throw new Error(`tool ${c.name} streamed but is not in assistantTools`);
    const out = await tool.run(c.input ?? {});
    outputs.push({ name: c.name ?? "", blob: JSON.stringify(out) });
  }
  return {
    events,
    text: events
      .filter((e) => e.type === "text_delta")
      .map((e) => e.text ?? "")
      .join(""),
    calls,
    results: events.filter((e) => e.type === "tool_result"),
    conversationId: done?.conversationId ?? "",
    messageId: done?.messageId ?? "",
    outputs,
  };
}

/** Every number in the answer (outside the mock provider's demo-mode footer) must be in a tool output. */
function numbersNotInTools(turn: Turn): string[] {
  const body = turn.text.replace(/\((?:Demo mode|Modo demo):[^)]*\)/g, "");
  const blob = turn.outputs.map((o) => o.blob).join("\n");
  const found = body.match(/\d[\d,]*(?:\.\d+)?/g) ?? [];
  const missing: string[] = [];
  for (const raw of found) {
    const clean = raw.replace(/,/g, "");
    const n = Number(clean);
    const forms = new Set([
      clean,
      String(n),
      String(n / 100), // 15% ↔ 0.15
      String(Math.round(n * 100)), // $19.99 ↔ 1999 cents
      n.toFixed(2),
      (n / 100).toFixed(2),
    ]);
    if (![...forms].some((f) => blob.includes(f))) missing.push(raw);
  }
  return missing;
}

const SOURCE_WITH_DATE =
  /(Google Trends|Pinterest|Census|Jungle Scout|your (own )?sales|own data)[^.\n]{0,80}\d{4}-\d{2}-\d{2}/i;
const TM_DROPPED =
  /can't look up that niche because it may use a protected name|No puedo buscar ese nicho/i;
const STALE_NOTE = /older than usual|más viejos de lo normal/i;
const DISAGREE_NOTE = /point different ways|van en direcciones distintas/i;
const REC_SAMPLE = /Sample data, not your real market|Datos de muestra, no tu mercado real/i;

/* ---- Fixture shops shaped like Desert Bloom Tees ------------------------------------------- */

const DAY = 86_400_000;
const WEEK = 7 * DAY;
const uniq = () => crypto.randomUUID().slice(0, 12);

/** Every fixture company keeps the schema default (`companies.timezone`); `localYmd` needs it. */
const TIME_ZONE = "America/Phoenix";

/**
 * ISO weekday (Mon=1..Sun=7) of `at`'s local calendar date, the convention `completeWeeks` uses.
 * Second pass (QA): a fixed "-3 days" only placed `weeksAgo` in its intended ISO week for a
 * Thursday-Sunday `now`; a Tuesday `now` put weeksAgo=1 a week early, leaving the true last
 * complete ISO week empty (same cause as `market.acceptance.test.ts`'s AC17 fixture bug).
 */
function isoWeekday(at: Date): number {
  const day = new Date(`${localYmd(at, TIME_ZONE)}T00:00:00.000Z`).getUTCDay();
  return day === 0 ? 7 : day;
}
type Connection = typeof channelConnections.$inferSelect;

async function connection(companyId: string, channel: Channel, status: "connected" | "csv_only") {
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

async function shop(name: string) {
  const company = await createCompany({ name: `${name} ${uniq()}` });
  const owner = await createUser(company.id, "owner", { email: `owner-${uniq()}@test.local` });
  const etsy = await connection(company.id, "etsy", "csv_only");
  return { id: company.id, owner: tenantContext(company.id, owner.id, "owner"), etsy };
}

async function design(companyId: string, name: string, tags: string[]) {
  const [row] = await withSystem((tx) =>
    tx
      .insert(designs)
      .values({ companyId, code: `D-${uniq()}`, name, tags })
      .returning(),
  );
  if (!row) throw new Error("design insert failed");
  return row;
}

async function product(companyId: string, designId: string, channel: Channel, price: number) {
  await withSystem((tx) =>
    tx.insert(products).values({
      companyId,
      designId,
      brand: "Gildan",
      styleCode: "G640",
      name: `Softstyle ${uniq()}`,
      prices: [{ channel, price }],
    }),
  );
}

async function listing(companyId: string, conn: Connection, designId: string, title: string) {
  await withSystem((tx) =>
    tx.insert(listings).values({
      companyId,
      connectionId: conn.id,
      channel: conn.channel,
      channelListingId: `L-${uniq()}`,
      title,
      state: "active",
      designId,
    }),
  );
}

/** `series[i]` units sold in week `series.length - i` before `now` (one item = one unit). */
async function weeklySales(
  companyId: string,
  conn: Connection,
  designId: string,
  series: number[],
  now: Date,
  priceCents = 2499,
) {
  for (let i = 0; i < series.length; i++) {
    const units = series[i] ?? 0;
    if (units <= 0) continue;
    const weeksAgo = series.length - i;
    const placedAt = new Date(now.getTime() - weeksAgo * WEEK - (isoWeekday(now) - 4) * DAY);
    await withSystem(async (tx) => {
      const [order] = await tx
        .insert(orders)
        .values({
          companyId,
          connectionId: conn.id,
          channel: conn.channel,
          channelOrderId: `co-${uniq()}`,
          orderNo: uniq(),
          status: "shipped",
          placedAt,
          shipBy: new Date(placedAt.getTime() + 3 * DAY),
          itemCount: units,
          subtotalCents: priceCents * units,
          shippingCents: 499,
          totalCents: priceCents * units + 499,
          shippedAt: new Date(placedAt.getTime() + 2 * DAY),
        })
        .returning();
      if (!order) throw new Error("order insert failed");
      await tx.insert(orderItems).values(
        Array.from({ length: units }, (_, u) => ({
          companyId,
          orderId: order.id,
          unitNo: u + 1,
          unitsInLine: units,
          channelSku: "FIX-SKU",
          title: "Fixture tee",
          unitPriceCents: priceCents,
          shipBy: order.shipBy,
          state: "shipped" as const,
          designId,
          placement: "front",
          printWidthIn: 10.5,
          printHeightIn: 12,
        })),
      );
    });
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
/** Costs that leave ~12% at $19.99 (R3 territory, below the 15% floor). */
const FLOOR_BREACH: Costs = {
  fees: 260,
  blank: 385,
  transfer: 210,
  label: 450,
  packaging: 45,
  labor: 120,
  ads: 290,
};
/**
 * Costs that leave ~19% margin at $10.00 (R2 territory: < 25%, ≥ 15%). Second pass, QA: at the
 * original $12.99, `market/compute.ts`'s margin signal ignores `channelFeesCents` from
 * `profitLines` and recomputes the channel fee fresh from the default fee schedule (Amazon
 * apparel referral: 5% under $20, `finance/profit.ts`), giving ~29% margin, not the intended
 * ~19% -- above the R2 threshold, so R2 never fired. $10.00 also keeps the R2 test-price ceiling
 * (p0 x 1.1) safely under the mock's own $12.00 comparable floor.
 */
const THIN: Costs = {
  fees: 50,
  blank: 300,
  transfer: 150,
  label: 230,
  packaging: 45,
  labor: 35,
  ads: 0,
};
/** Costs that leave ~38% at $24.99. */
const HEALTHY: Costs = {
  fees: 325,
  blank: 385,
  transfer: 210,
  label: 450,
  packaging: 45,
  labor: 120,
  ads: 0,
};

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
      .where(and(eq(orderItems.companyId, companyId), eq(orderItems.designId, designId)));
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
        netCents: r.price - total,
        marginPct: ((r.price - total) / r.price) * 100,
        placedAt: r.placedAt,
      })),
    );
  });
}

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
  "purchase_orders",
] as const;
async function digest(companyId: string) {
  return withSystem(async (tx) => {
    const out: Record<string, string> = {};
    for (const t of BUSINESS_TABLES) {
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

function freeze(at: string) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(at));
  return new Date(at);
}

/* ============================================================================================ */

describe("T-18-4 market answers on a fixture shop (spec AC2, AC16, AC30, AC31, AC33, AC10)", () => {
  let s: Awaited<ReturnType<typeof shop>>;
  let amazon: Connection;
  const NOW = "2026-09-01T16:00:00.000Z"; // Halloween's peak ≤ 10 weeks away

  beforeAll(async () => {
    s = await shop("Answer Bloom");
    const now = freeze(NOW);
    amazon = await connection(s.id, "amazon", "connected");
    // Two Halloween designs on Etsy, both below the 15% margin floor (R1 + R3 each).
    for (const name of ["Spooky Pumpkin Ghost", "Witch Please"]) {
      const d = await design(s.id, name, ["halloween"]);
      await product(s.id, d.id, "etsy", 1999); // Cents (contract), not dollars
      await listing(s.id, s.etsy, d.id, `${name} tee`);
      await weeklySales(s.id, s.etsy, d.id, flat(30, 3), now, 1999);
      await profitFor(s.id, d.id, FLOOR_BREACH);
    }
    // One camping design on Amazon at a low price with thin margin (R2, on mock comparables).
    const camp = await design(s.id, "Retro Camping Bear", ["camping", "retro"]);
    await product(s.id, camp.id, "amazon", 1000); // second pass, QA: see THIN's comment
    await listing(s.id, amazon, camp.id, "Retro Camping Bear tee");
    await weeklySales(s.id, amazon, camp.id, flat(30, 4), now, 1000);
    await profitFor(s.id, camp.id, THIN);
    await runShopJobs(s.id);
  }, 180_000);
  afterAll(() => vi.useRealTimers());

  it("AC2: 'Which of my designs are trending?' calls get_market_trend; every number is in a tool output; outside facts carry source and date; mock facts say 'sample data'", async () => {
    const turn = await ask(s.owner, "Which of my designs are trending?");
    expect(turn.calls.map((c) => c.name)).toContain("get_market_trend");
    expect(numbersNotInTools(turn), turn.text).toEqual([]);
    expect(turn.text).toMatch(SOURCE_WITH_DATE);
    const anyMock = turn.results.some((r) => r.mock === true);
    expect(anyMock, "the outside sources are mocks in this build").toBe(true);
    expect(turn.text.toLowerCase()).toContain("sample data");
    for (const r of turn.results.filter((r) => r.name === "get_market_trend")) {
      expect(r.sources?.length ?? 0).toBeGreaterThan(0);
      for (const src of r.sources ?? []) expect(new Date(src.asOf).getTime()).not.toBeNaN();
    }
    // Rows are capped at 20 in every market tool.
    for (const o of turn.outputs) {
      const rows = (JSON.parse(o.blob) as { data?: { rows?: unknown[]; items?: unknown[] } }).data;
      expect((rows?.rows ?? rows?.items ?? []).length, o.name).toBeLessThanOrEqual(20);
    }
  });

  it("AC30: a recommendation built on mock data carries the `rec.sample` sentence in the answer text", async () => {
    const turn = await ask(s.owner, "Am I priced right on Amazon?");
    expect(turn.calls.map((c) => c.name)).toEqual(
      expect.arrayContaining(["get_price_position", "simulate_price"]),
    );
    const mockRecs = turn.results.flatMap((r) => (r.recommendations ?? []).filter((x) => x.mock));
    expect(mockRecs.length, "an R2 on the mock Amazon comparables").toBeGreaterThan(0);
    expect(mockRecs.some((r) => r.rule === "R2")).toBe(true);
    expect(turn.text).toMatch(REC_SAMPLE);
    expect(turn.text.toLowerCase()).toContain("sample data");
    // Every recommendation shows its band (copy `band.*`).
    expect(turn.text).toMatch(/High confidence|Medium confidence|Not enough data/);
  });

  it("AC33 (backend): recommendations ride the stream with ids, are stored on the message, and a vote after reload binds to the right one", async () => {
    const turn = await ask(s.owner, "When should I get ready for Halloween?");
    expect(turn.calls.map((c) => c.name)).toContain("get_seasonality");
    const shown = turn.results.flatMap((r) => r.recommendations ?? []);
    expect(
      shown.length,
      "two Halloween designs → at least two recommendations",
    ).toBeGreaterThanOrEqual(2);
    for (const r of turn.results) expect((r.recommendations ?? []).length).toBeLessThanOrEqual(3);
    for (const r of shown) expect(["high", "medium", "low"]).toContain(r.band);

    // Stored with the message, so the vote cards survive a reload.
    const conv = await withTenant(s.id, (tx) =>
      svc.getConversation(tx, s.owner, turn.conversationId),
    );
    const msg = conv.messages.find((m) => m.id === turn.messageId) as
      | { recommendations?: RecommendationRef[]; mock?: boolean }
      | undefined;
    expect(msg?.recommendations?.map((r) => r.id).sort()).toEqual(shown.map((r) => r.id).sort());

    // recordRecommendationsShown ran once for the turn.
    const ids = shown.map((r) => r.id);
    const stored = await listRecs(ids, s.owner);
    expect(stored.items.map((r) => r.id).sort()).toEqual([...ids].sort());
    for (const r of stored.items) {
      expect(r.shownIn).toBe("assistant");
      expect(r.shownAt).not.toBeNull();
      expect(r.vote).toBeNull();
    }

    // The owner taps "Not useful" on the second; the first is unchanged.
    const [first, second] = ids;
    if (!first || !second) throw new Error("two ids expected");
    await vote(second, "not_useful", s.owner);
    const after = await listRecs(ids, s.owner);
    expect(after.items.find((r) => r.id === second)?.vote).toBe("not_useful");
    expect(after.items.find((r) => r.id === first)?.vote).toBeNull();
  });

  it("AC31: asking about a trademark-dropped niche gets the fixed `tm.dropped` line, no signal, and never 'not enough data'", async () => {
    const en = await ask(s.owner, "How is the Disney niche doing?");
    expect(en.text).toMatch(TM_DROPPED);
    expect(en.text.toLowerCase()).not.toContain("not enough data");
    for (const r of en.results) {
      expect(r.summary?.toLowerCase(), r.name).not.toContain("disney");
      expect((r.sources ?? []).length, `${r.name} returned a signal for a dropped term`).toBe(0);
    }
    const es = await ask(s.owner, "¿Cómo va el nicho Disney?");
    expect(es.text).toMatch(/No puedo buscar ese nicho porque puede usar un nombre protegido/);
    expect(es.text.toLowerCase()).not.toContain("no hay suficientes datos");
  });

  it("AC16: three market answers and a vote change no business table", async () => {
    const before = await digest(s.id);
    await ask(s.owner, "Which of my designs are trending?");
    await ask(s.owner, "Am I priced right on Amazon?");
    const turn = await ask(s.owner, "When should I get ready for Halloween?");
    const rec = turn.results.flatMap((r) => r.recommendations ?? [])[0];
    if (rec) await vote(rec.id, "done", s.owner);
    expect(await digest(s.id)).toEqual(before);
  });

  it("AC10: when the signals are older than 2× their TTL the answer keeps the source and date line and adds `stale.note`", async () => {
    vi.setSystemTime(new Date(new Date(NOW).getTime() + 61 * DAY));
    const turn = await ask(s.owner, "Which of my designs are trending?");
    expect(turn.text).toMatch(SOURCE_WITH_DATE);
    expect(turn.text).toMatch(STALE_NOTE);
    expect(JSON.stringify(turn.outputs.map((o) => o.blob))).toMatch(
      /\\"stale\\":true|"stale":true/,
    );
    expect(numbersNotInTools(turn), turn.text).toEqual([]);
  });
});

/* ============================================================================================ */

describe("T-18-4 thin data: a small Etsy-only shop with 10 weeks of history (spec AC6)", () => {
  let s: Awaited<ReturnType<typeof shop>>;
  const NOW = "2026-09-15T16:00:00.000Z";

  beforeAll(async () => {
    s = await shop("Small Bloom");
    const now = freeze(NOW);
    const d = await design(s.id, "Dog Mom Life", ["dog mom"]);
    await product(s.id, d.id, "etsy", 2499); // Cents (contract), not dollars
    await listing(s.id, s.etsy, d.id, "Dog Mom Life tee");
    await weeklySales(s.id, s.etsy, d.id, flat(10, 4), now);
    await profitFor(s.id, d.id, HEALTHY);
    await runShopJobs(s.id);
  }, 120_000);
  afterAll(() => vi.useRealTimers());

  it("AC6: 'Am I priced right?' says there is no approved price source for Etsy, gives the margin table, and makes no price-position claim", async () => {
    const turn = await ask(s.owner, "Am I priced right?");
    expect(turn.calls.map((c) => c.name)).toEqual(
      expect.arrayContaining(["get_price_position", "simulate_price"]),
    );
    const pos = turn.outputs.find((o) => o.name === "get_price_position");
    const data = (
      JSON.parse(pos?.blob ?? "{}") as { data?: { available?: boolean; reason?: string } }
    ).data;
    expect(data?.available).toBe(false);
    expect(data?.reason).toBe("no_compliant_source");
    expect(turn.text).toMatch(/no approved price source for Etsy/i);
    expect(turn.text).not.toMatch(/percentile|premium|priced (above|below) (the )?market/i);
    // The margin table from simulate_price is in the answer: a price and a margin percent.
    expect(turn.text).toMatch(/\$\d+\.\d{2}/);
    expect(turn.text).toMatch(/\d+(\.\d+)?\s?%/);
    expect(numbersNotInTools(turn), turn.text).toEqual([]);
  });

  it("AC7 (assistant side): with fewer than 13 weeks the trend answer says 'not enough data' and recommends nothing", async () => {
    const turn = await ask(s.owner, "Which of my designs are trending?");
    const trend = turn.outputs.find((o) => o.name === "get_market_trend");
    expect(trend?.blob).toMatch(/"insufficient"/);
    expect(turn.text.toLowerCase()).toContain("not enough data");
    expect(turn.results.flatMap((r) => r.recommendations ?? [])).toEqual([]);
  });
});

/* ============================================================================================ */

describe("T-18-4 disagreement (spec AC8)", () => {
  let s: Awaited<ReturnType<typeof shop>>;
  let niche = "";
  let outside = "";
  const NOW = "2026-09-20T16:00:00.000Z";

  beforeAll(async () => {
    s = await shop("Split Bloom");
    const now = freeze(NOW);
    await runMarketJob("market.refreshDemand", {});
    await runMarketJob("market.computeSignals", { companyId: s.id });
    for (const n of market.NICHES.slice(0, 24)) {
      const t = await withTenant(s.id, (tx) =>
        market.getTrendSignal(tx, s.owner, { niche: n.key }),
      );
      if (t.trend === "rising" || t.trend === "falling") {
        niche = n.key;
        outside = t.trend;
        break;
      }
    }
    if (!niche) throw new Error("no mock niche series is rising or falling (T-18-2 AC1 shapes)");
    const d = await design(s.id, `${niche} design`, [niche]);
    const own = Array.from({ length: 30 }, (_, i) =>
      Math.round(outside === "falling" ? 3 * 1.06 ** i : 18 * 0.94 ** i),
    );
    await weeklySales(s.id, s.etsy, d.id, own, now);
    await runMarketJob("market.computeSignals", { companyId: s.id });
  }, 180_000);
  afterAll(() => vi.useRealTimers());

  it("AC8: the answer names both directions instead of one averaged trend, then adds `disagree.note`", async () => {
    const label = market.NICHES.find((n) => n.key === niche)?.labelEn ?? niche;
    const turn = await ask(s.owner, `Is the ${label} niche trending?`);
    expect(turn.calls.map((c) => c.name)).toContain("get_market_trend");
    expect(turn.outputs.map((o) => o.blob).join()).toMatch(/"disagreement":true/);
    expect(turn.text).toMatch(/rising|going up|growing/i);
    expect(turn.text).toMatch(/falling|going down|declining/i);
    expect(turn.text).toMatch(DISAGREE_NOTE);
    expect(numbersNotInTools(turn), turn.text).toEqual([]);
  });
});
