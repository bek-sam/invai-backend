/*
 * Wave 18 acceptance tests: the mock visibility rule in production (spec AC22, AC29; wave.md hard
 * fences; T-18-3 AC2a). First pass, expected red until T-18-3 lands.
 *
 * `env.isProd` is flipped to true (and `allowMocks` to false) for this file only, so a real shop
 * must see no mock-sourced market data at all, while a sample workspace (`isSampleWorkspace`, a
 * user's own demo company, not `companies.demo`) still gets every mock.
 *
 * Owner: qa-engineer. Implementers don't edit this file; disagreements go in their report.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "../../api/context";
import { withSystem, withTenant } from "../../db/client";
import { channelConnections, companies, designs, orderItems, orders } from "../../db/schema";
import { marketPricingProvider } from "../../integrations/market";
import { getJob, runJobInline } from "../../lib/queues";
import { createCompany, createUser, tenantContext } from "../../test/fixtures";
import { assistantTools } from "../ai/assistant-tools";
import { clearSampleWorkspaceCache } from "../tenancy/demo-flag";
import { mockSourcesAllowed } from "./config";
import * as market from "./service";

vi.mock("../../env", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../env")>();
  // Production for a real shop: mocks are "no source". Database URLs stay the test ones.
  return { ...mod, env: { ...mod.env, isProd: true, allowMocks: false } };
});

const JOBS = "./jobs";
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

const DAY = 86_400_000;
const WEEK = 7 * DAY;
const uniq = () => crypto.randomUUID().slice(0, 12);

type Shop = {
  id: string;
  ownerId: string;
  owner: TenantContext;
  amazon: typeof channelConnections.$inferSelect;
};

/** A shop with an owner, an Etsy CSV connection, a connected Amazon, and 30 weeks of Halloween sales. */
/** Company and owner first, on the real clock: the shared fixtures' slugs and emails use Date.now(). */
async function base() {
  const company = await createCompany({ name: `Prod Bloom ${uniq()}` });
  const owner = await createUser(company.id, "owner", { email: `owner-${uniq()}@test.local` });
  return { company, owner };
}

async function shop(
  b: Awaited<ReturnType<typeof base>>,
  now: Date,
): Promise<Shop & { designId: string }> {
  const { company, owner } = b;
  const [etsy] = await withSystem((tx) =>
    tx
      .insert(channelConnections)
      .values({
        companyId: company.id,
        channel: "etsy",
        name: "etsy",
        status: "csv_only",
        mode: "csv",
        provider: "mock",
      })
      .returning(),
  );
  const [amazon] = await withSystem((tx) =>
    tx
      .insert(channelConnections)
      .values({
        companyId: company.id,
        channel: "amazon",
        name: "amazon",
        status: "connected",
        mode: "api",
        provider: "mock",
        connectedAt: now,
      })
      .returning(),
  );
  if (!etsy || !amazon) throw new Error("connection insert failed");
  const [d] = await withSystem((tx) =>
    tx
      .insert(designs)
      .values({
        companyId: company.id,
        code: `D-${uniq()}`,
        name: "Spooky Pumpkin Ghost",
        tags: ["halloween"],
      })
      .returning(),
  );
  if (!d) throw new Error("design insert failed");
  for (let w = 30; w >= 1; w--) {
    const placedAt = new Date(now.getTime() - w * WEEK - 3 * DAY);
    await withSystem(async (tx) => {
      const [order] = await tx
        .insert(orders)
        .values({
          companyId: company.id,
          connectionId: amazon.id,
          channel: "amazon",
          channelOrderId: `co-${uniq()}`,
          orderNo: uniq(),
          status: "shipped",
          placedAt,
          shipBy: new Date(placedAt.getTime() + 3 * DAY),
          itemCount: 3,
          subtotalCents: 3 * 1299,
          totalCents: 3 * 1299 + 499,
          shippedAt: new Date(placedAt.getTime() + 2 * DAY),
        })
        .returning();
      if (!order) throw new Error("order insert failed");
      await tx.insert(orderItems).values(
        [1, 2, 3].map((unitNo) => ({
          companyId: company.id,
          orderId: order.id,
          unitNo,
          unitsInLine: 3,
          channelSku: "FIX-SKU",
          title: "Fixture tee",
          unitPriceCents: 1299,
          shipBy: order.shipBy,
          state: "shipped" as const,
          designId: d.id,
        })),
      );
    });
  }
  return {
    id: company.id,
    ownerId: owner.id,
    owner: tenantContext(company.id, owner.id, "owner"),
    amazon,
    designId: d.id,
  };
}

async function runTool(ctx: TenantContext, name: string, input: Record<string, unknown>) {
  const tool = assistantTools(ctx).find((t) => t.name === name);
  if (!tool) throw new Error(`assistant tool ${name} is missing (T-18-4)`);
  return tool.run(input);
}

describe("mock visibility rule in production (spec AC29, AC22)", () => {
  const NOW = "2026-09-15T16:00:00.000Z";
  let real: Awaited<ReturnType<typeof shop>>;
  let sample: Awaited<ReturnType<typeof shop>>;

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = new Date(NOW);
    const [realBase, sampleBase] = [await base(), await base()];
    vi.setSystemTime(now);
    real = await shop(realBase, now);
    sample = await shop(sampleBase, now);
    await withSystem((tx) =>
      tx
        .update(companies)
        .set({ demoOwnerUserId: sample.ownerId })
        .where(eq(companies.id, sample.id)),
    );
    clearSampleWorkspaceCache();
    await runShopJobs(real.id);
    await runShopJobs(sample.id);
  }, 180_000);
  afterAll(() => vi.useRealTimers());

  it("AC29: for a real shop, mockSourcesAllowed is false and no signal, tool or recommendation rests on a mock", async () => {
    expect(await mockSourcesAllowed(real.id)).toBe(false);
    const trend = await withTenant(real.id, (tx) =>
      market.getTrendSignal(tx, real.owner, { designId: real.designId }),
    );
    expect(trend.mock).toBe(false);
    expect(trend.sources.every((p) => !p.mock)).toBe(true);
    expect(trend.readings.find((r) => r.provenance.source === "own")?.n).toBe(30);
    const pos = await withTenant(real.id, (tx) =>
      market.getPricePosition(tx, real.owner, { designId: real.designId, channel: "amazon" }),
    );
    expect(pos.available).toBe(false);
    if (!pos.available) expect(pos.reason).toBe("no_compliant_source");
    const recs = await withTenant(real.id, (tx) =>
      market.listRecommendations(tx, real.owner, { limit: 50 }),
    );
    expect(recs.filter((r) => r.rule === "R2" || r.rule === "R4")).toEqual([]);
    expect(recs.filter((r) => r.mock || r.sources.some((p) => p.mock))).toEqual([]);
  });

  it("AC29: the assistant's price-position tool answers `available: false` for Amazon in production for a real shop", async () => {
    const out = await runTool(real.owner, "get_price_position", {
      designId: real.designId,
      channel: "amazon",
    });
    const data = out.data as { available?: boolean; reason?: string; mock?: boolean };
    expect(data.available).toBe(false);
    expect(data.reason).toBe("no_compliant_source");
    expect(out.answer.toLowerCase()).toMatch(/no approved price source/);
    expect(JSON.stringify(out.data)).not.toMatch(/"mock":true/);
    const trend = await runTool(real.owner, "get_market_trend", { designId: real.designId });
    expect(JSON.stringify(trend.data)).not.toMatch(/"mock":true/);
    expect(trend.answer.toLowerCase()).not.toContain("sample data");
  });

  it("AC22: a sample workspace gets only mocks even in production, even on a 'live' connection", async () => {
    expect(await mockSourcesAllowed(sample.id)).toBe(true);
    const live = marketPricingProvider({
      sampleWorkspace: true,
      channel: "amazon",
      connection: {
        id: sample.amazon.id,
        companyId: sample.id,
        status: "connected",
        provider: "live",
      },
    });
    expect(live?.mock).toBe(true);
    const trend = await withTenant(sample.id, (tx) =>
      market.getTrendSignal(tx, sample.owner, { designId: sample.designId }),
    );
    expect(trend.sources.filter((p) => p.mock).length).toBeGreaterThan(0);
    expect(trend.mock).toBe(true);
    const pos = await withTenant(sample.id, (tx) =>
      market.getPricePosition(tx, sample.owner, { designId: sample.designId, channel: "amazon" }),
    );
    // Mock comparables are allowed here: either an answer, or only "too few", never "no source".
    if (!pos.available) expect(pos.reason).toBe("too_few_comparables");
    else expect(pos.mock).toBe(true);
  });
});
