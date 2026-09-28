/*
 * Wave 19 acceptance tests for the digest's Market watch block (spec AC14-AC17), written from
 * `invai-docs/specs/weekly-digest.md` before T-19-3 lands (`acceptance-tests-first`).
 *
 * Second pass, against landed backend HEAD (T-19-3 cadc338/bef6158): these tests run against wave
 * 18's market service directly (pushed, `src/modules/market/service.ts`: `listDigestMarketItems`,
 * `voteRecommendation`, `recordRecommendationsShown` are real) — recommendations are seeded with a
 * direct insert into `market_recommendations` rather than through the market jobs, so the "wave 18
 * signals" half of each AC is exact and stable. The digest half (`digest.get`'s `marketWatch`
 * selection, promotion into `actions`) now goes through the real digest router.
 *
 * Field names match the landed contract (0.7.0, `@invai/contracts`): `Digest.marketWatch` (not
 * `market`), and a market item is a `DigestInsight` whose `recommendation` field is the underlying
 * `MarketRecommendation` — per the schema's own doc comment, a Market watch vote goes through
 * `market.recommendations.vote`, never `digest.feedback` (AC17 below calls the real, already-
 * working wave 18 procedure directly).
 *
 * `mondayPhoenix` returns shop-local midnight (07:00Z), not 07:00 local: every freeze below was
 * `+5min` (00:05 local, before the build window) and has been corrected to `+7h5m` (07:05 local),
 * same fix as `digest.acceptance.test.ts` (T-19-3's report flagged the root cause).
 *
 * Owner: qa-engineer. Implementers don't edit this file; disagreements go in their report.
 */
import type { Digest } from "@invai/contracts";
import { call } from "@orpc/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "../../api/context";
import { router } from "../../api/router";
import { withSystem } from "../../db/client";
import {
  type Channel,
  channelConnections,
  designs,
  marketRecommendations,
  orderItems,
  orders,
  profitLines,
} from "../../db/schema";
import { createCompany, createUser, tenantContext } from "../../test/fixtures";

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
  if (!node) throw new Error(`procedure ${path} is not on the router (T-19-3/T-19-1 router.ts)`);
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
  if (!job) throw new Error(`job ${name} is not registered (T-19-3 jobs.ts)`);
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

/** A market recommendation seeded directly (wave 18's real table), skipping the market jobs. */
async function recommendation(
  companyId: string,
  input: {
    rule: "R1" | "R2" | "R3" | "R4" | "R5";
    band: "high" | "medium" | "low";
    mock?: boolean;
    designId?: string | null;
    createdAt?: Date;
  },
) {
  const now = input.createdAt ?? new Date();
  const [row] = await withSystem((tx) =>
    tx
      .insert(marketRecommendations)
      .values({
        companyId,
        rule: input.rule,
        action: "list_and_stock",
        dedupeKey: `dk-${uniq()}`,
        createdOn: now.toISOString().slice(0, 10),
        designId: input.designId ?? null,
        confidence: input.band === "high" ? 0.85 : input.band === "medium" ? 0.65 : 0.3,
        band: input.band,
        mock: input.mock ?? true,
        sources: [],
        evidenceSignalIds: [],
        staleAfterDays: 30,
        createdAt: now,
        updatedAt: now,
      })
      .returning(),
  );
  if (!row) throw new Error("recommendation insert failed");
  return row;
}

/**
 * A minimal sale inside the target week. Market watch items are only ever fetched for a non-quiet
 * week (`build.ts`'s `isQuiet` gate skips `marketOf(...)` entirely for zero-order weeks), so every
 * AC14-17 fixture needs at least one order — a fixture gap this file originally had (every shop was
 * order-free, so every digest built `skipped_quiet` and Market watch was never evaluated).
 */
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

describe("AC14: Market watch shows a qualifying medium/high item and drops a low-band one", () => {
  it("shows the R1 item with source/date/band and 'Sample data'; the R4 low item is absent", async () => {
    const s = await shop("Watch Tees");
    const monday = mondayPhoenix("2026-09-28");
    const halloween = await withSystem((tx) =>
      tx
        .insert(designs)
        .values({ companyId: s.id, code: `D-${uniq()}`, name: "Halloween Tee", tags: [] })
        .returning(),
    ).then((rows) => rows[0]);
    if (!halloween) throw new Error("design insert failed");
    // `listDigestMarketItems` only shows items created within 7 days of the build instant
    // (`asOf`): an explicit `createdAt` inside this week keeps the test deterministic regardless
    // of the real wall-clock date the suite happens to run on (an earlier version relied on the
    // default `new Date()`, which only worked by coincidence when "today" was near this week — see
    // AC17, where the same default made the recommendation look "too old" and fail).
    const createdAt = new Date(monday.getTime() - 2 * DAY_MS);
    const r1 = await recommendation(s.id, {
      rule: "R1",
      band: "medium",
      designId: halloween.id,
      createdAt,
    });
    await recommendation(s.id, { rule: "R4", band: "low", designId: halloween.id, createdAt });
    await saleAt(s.id, s.etsy.id, "etsy", new Date(monday.getTime() - 3 * DAY_MS));

    freeze(new Date(monday.getTime() + 7 * 60 * 60_000 + 5 * 60_000).toISOString());
    await runDigestJob("digest.sweep", {});
    const digest = await rpc<Digest>("digest.get", { weekKey: "2026-W39" }, s.owner);
    expect(digest.marketWatch.some((m) => m.recommendation?.id === r1.id)).toBe(true);
    expect(digest.marketWatch.some((m) => m.recommendation?.rule === "R4")).toBe(false);
  });
});

describe("AC15: promotion into the top 3 actions", () => {
  it("an R1 item with a cross-listing gap may take a top-3 slot; an R2 item never does", async () => {
    const s = await shop("Promote Tees");
    const monday = mondayPhoenix("2026-10-05");
    const createdAt = new Date(monday.getTime() - 2 * DAY_MS); // deterministic: see AC14's comment
    await recommendation(s.id, { rule: "R1", band: "high", createdAt });
    const r2 = await recommendation(s.id, { rule: "R2", band: "high", createdAt });
    await saleAt(s.id, s.etsy.id, "etsy", new Date(monday.getTime() - 3 * DAY_MS));
    freeze(new Date(monday.getTime() + 7 * 60 * 60_000 + 5 * 60_000).toISOString());
    await runDigestJob("digest.sweep", {});
    const digest = await rpc<Digest>("digest.get", { weekKey: "2026-W40" }, s.owner);
    expect(digest.actions.some((a) => a.recommendation?.id === r2.id)).toBe(false);
  });
});

describe("AC16: a missing, stale or throwing market read never blocks the digest", () => {
  it("the digest still builds ready with no Market watch block when signals are stale", async () => {
    const s = await shop("Stale Tees");
    const monday = mondayPhoenix("2026-10-12");
    await recommendation(s.id, {
      rule: "R1",
      band: "high",
      createdAt: new Date(monday.getTime() - 90 * DAY_MS), // far past staleAfterDays: 30
    });
    await saleAt(s.id, s.etsy.id, "etsy", new Date(monday.getTime() - 3 * DAY_MS));
    freeze(new Date(monday.getTime() + 7 * 60 * 60_000 + 5 * 60_000).toISOString());
    await runDigestJob("digest.sweep", {});
    const digest = await rpc<Digest>("digest.get", { weekKey: "2026-W41" }, s.owner);
    expect(digest.status).toBe("ready");
    expect(digest.marketWatch).toHaveLength(0);
  });
});

describe("AC17: a Market watch vote is the same market-recommendation vote", () => {
  it("voting 'not useful' updates the one underlying recommendation record, via market.recommendations.vote", async () => {
    const s = await shop("Vote Tees");
    const monday = mondayPhoenix("2026-10-19");
    const createdAt = new Date(monday.getTime() - 2 * DAY_MS); // deterministic: see AC14's comment
    const r1 = await recommendation(s.id, { rule: "R1", band: "high", createdAt });
    await saleAt(s.id, s.etsy.id, "etsy", new Date(monday.getTime() - 3 * DAY_MS));
    freeze(new Date(monday.getTime() + 7 * 60 * 60_000 + 5 * 60_000).toISOString());
    await runDigestJob("digest.sweep", {});
    const digest = await rpc<Digest>("digest.get", { weekKey: "2026-W42" }, s.owner);
    expect(digest.marketWatch.some((m) => m.recommendation?.id === r1.id)).toBe(true);

    // Per the contract's own doc comment on `DigestInsight.recommendation`: Market watch items are
    // voted through `market.recommendations.vote` (already real, wave 18), never `digest.feedback`.
    await rpc("market.recommendations.vote", { id: r1.id, vote: "not_useful" }, s.owner);
    const marketVoted = await withSystem((tx) =>
      tx.query.marketRecommendations.findFirst({ where: (t, o) => o.eq(t.id, r1.id) }),
    );
    expect(marketVoted?.vote).toBe("not_useful");
  });
});
