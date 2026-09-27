/*
 * Wave 18 acceptance test: a demand provider outage (spec AC20; T-18-3 AC10; T-18-2 AC5). First
 * pass, expected red until T-18-3 lands.
 *
 * The clock here is the latest in the whole acceptance suite (2027-01), so the global cache rows
 * this file writes are newer than any other file's, and "kept the last good rows" can be read
 * off `fetched_at` without interference from other tests sharing the test database.
 *
 * Owner: qa-engineer. Implementers don't edit this file; disagreements go in their report.
 */
import type { MarketTrend } from "@invai/contracts";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { withSystem, withTenant } from "../../db/client";
import { channelConnections, designs, orderItems, orders } from "../../db/schema";
import { env } from "../../env";
import { getJob, runJobInline } from "../../lib/queues";
import { createCompany, createUser, tenantContext } from "../../test/fixtures";
import * as market from "./service";

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

const DAY = 86_400_000;
const WEEK = 7 * DAY;
const uniq = () => crypto.randomUUID().slice(0, 12);

/** A shop with a Halloween design and 30 weeks of Etsy sales ending at `now`. */
/** Company and owner first, on the real clock: the shared fixtures' slugs and emails use Date.now(). */
async function base() {
  const company = await createCompany({ name: `Outage Bloom ${uniq()}` });
  const owner = await createUser(company.id, "owner", { email: `owner-${uniq()}@test.local` });
  return { company, owner };
}

async function shop(b: Awaited<ReturnType<typeof base>>, now: Date) {
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
  if (!etsy || !d) throw new Error("fixture insert failed");
  for (let w = 30; w >= 1; w--) {
    const placedAt = new Date(now.getTime() - w * WEEK - 3 * DAY);
    await withSystem(async (tx) => {
      const [order] = await tx
        .insert(orders)
        .values({
          companyId: company.id,
          connectionId: etsy.id,
          channel: "etsy",
          channelOrderId: `co-${uniq()}`,
          orderNo: uniq(),
          status: "shipped",
          placedAt,
          shipBy: new Date(placedAt.getTime() + 3 * DAY),
          itemCount: 3,
          subtotalCents: 3 * 2499,
          totalCents: 3 * 2499 + 499,
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
          unitPriceCents: 2499,
          shipBy: order.shipBy,
          state: "shipped" as const,
          designId: d.id,
        })),
      );
    });
  }
  return { id: company.id, owner: tenantContext(company.id, owner.id, "owner"), designId: d.id };
}

async function latestFetch(source: string): Promise<number> {
  const r = await withSystem((tx) =>
    tx.execute<{ at: string | null }>(
      sql`select max(fetched_at)::text as at from market_series_cache where source = ${source}`,
    ),
  );
  const at = r.rows[0]?.at;
  return at ? new Date(at).getTime() : 0;
}

describe("T-18-3 provider outage (spec AC20)", () => {
  const T0 = new Date("2027-01-15T04:00:00.000Z");
  const T1 = new Date(T0.getTime() + 10 * DAY); // past every weekly source's 7-day TTL
  let s: Awaited<ReturnType<typeof shop>>;
  let before: MarketTrend;
  let refreshResult: unknown;

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const b = await base();
    vi.setSystemTime(T0);
    s = await shop(b, T0);
    await runMarketJob("market.refreshDemand", {});
    await runMarketJob("market.computeSignals", { companyId: s.id });
    before = await withTenant(s.id, (tx) =>
      market.getTrendSignal(tx, s.owner, { designId: s.designId }),
    );
    // Google Trends goes down; the nightly refresh runs again 10 days later.
    env.marketMockFail.add("google_trends");
    vi.setSystemTime(T1);
    refreshResult = await runMarketJob("market.refreshDemand", {});
    await runMarketJob("market.computeSignals", { companyId: s.id });
  }, 180_000);
  afterAll(() => {
    env.marketMockFail.delete("google_trends");
    vi.useRealTimers();
  });

  it("the refresh does not throw, records the failed source, and other sources still refresh", async () => {
    expect(JSON.stringify(refreshResult ?? {})).toContain("google_trends");
    expect(await latestFetch("pinterest_trends")).toBeGreaterThanOrEqual(T1.getTime());
    expect(await latestFetch("jungle_scout")).toBeGreaterThanOrEqual(T1.getTime());
  });

  it("the last good Google Trends rows are kept (no row newer than the outage, none deleted)", async () => {
    const latest = await latestFetch("google_trends");
    expect(latest).toBeGreaterThan(0);
    expect(latest).toBeLessThan(T1.getTime());
    expect(latest).toBeGreaterThanOrEqual(T0.getTime() - DAY);
    const n = await withSystem((tx) =>
      tx.execute<{ n: number }>(
        sql`select count(*)::int as n from market_series_cache where source = 'google_trends'`,
      ),
    );
    expect(n.rows[0]?.n).toBeGreaterThan(0);
  });

  it("reads still answer, with the older Google Trends asOf and a lower confidence; nothing throws to the user", async () => {
    const after = await withTenant(s.id, (tx) =>
      market.getTrendSignal(tx, s.owner, { designId: s.designId }),
    );
    const g0 = before.sources.find((p) => p.source === "google_trends");
    const g1 = after.sources.find((p) => p.source === "google_trends");
    expect(g0, "Google Trends was a source before the outage").toBeDefined();
    expect(g1, "the older Google Trends rows are still a source").toBeDefined();
    expect(new Date(g1?.fetchedAt ?? 0).getTime()).toBeLessThan(T1.getTime());
    expect(g1?.asOf).toBe(g0?.asOf);
    const p1 = after.sources.find((p) => p.source === "pinterest_trends");
    expect(new Date(p1?.fetchedAt ?? 0).getTime()).toBeGreaterThanOrEqual(T1.getTime());
    expect(after.confidence).toBeLessThan(before.confidence);
    expect(after.readings.find((r) => r.provenance.source === "own")?.n).toBe(30);
  });
});
