import { and, eq, gt, notLike, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { systemContext } from "../../api/context";
import { recordUsage } from "../../modules/billing/service";
import { generateAlerts } from "../../modules/today/service";
import { createCompany, createUser } from "../../test/fixtures";
import { withSystem, withTenant } from "../client";
import { alerts, stockLevels, usage } from "../schema";
import { buildShopData, DESERT_BLOOM_PROFILE, type ShopSeedOptions } from "./builder";
import { rng } from "./data";

/*
 * T-20-5 round 2 (B-106): a running worker's scheduled sweeps don't go through the outbox, so
 * the hold in outbox-hold.ts can't stop them. The 5-minute alert sweep (`today.alertsSweep`)
 * fans out to every shop, the half-built one included: it creates `inventory_settings` lazily
 * and raises `stock_low:<variant>` and `order_at_risk:<order>` alerts on the same dedupe keys
 * the seed writes later; a worker's AI credit spend creates the period's `usage` row the same
 * way. The seed must finish anyway, with one row per key and its own numbers in `usage`.
 */

let companyId: string;
let userId: string;

const countAlerts = (where: ReturnType<typeof and>) =>
  withSystem((tx) =>
    tx
      .select({ n: sql<number>`count(*)`.mapWith(Number) })
      .from(alerts)
      .where(and(eq(alerts.companyId, companyId), where))
      .then((r) => r[0]?.n ?? 0),
  );

const stockLowKeys = (where: ReturnType<typeof and> = sql`true`) =>
  withSystem((tx) =>
    tx
      .select({ key: alerts.dedupeKey })
      .from(alerts)
      .where(and(eq(alerts.companyId, companyId), eq(alerts.kind, "stock_low"), where))
      .then((rows) => new Set(rows.map((r) => r.key))),
  );

/** Before the seed's inventory phase, no blank has opening stock yet. */
const beforeInventoryPhase = () =>
  withSystem((tx) =>
    tx
      .select({ n: sql<number>`count(*)`.mapWith(Number) })
      .from(stockLevels)
      .where(and(eq(stockLevels.companyId, companyId), gt(stockLevels.onHand, 0)))
      .then((r) => (r[0]?.n ?? 0) === 0),
  );

beforeAll(async () => {
  companyId = (await createCompany({ name: "Sweep Race Shop" })).id;
  userId = (await createUser(companyId, "owner")).id;
});

describe("seed builder beside the alert sweep", () => {
  it("completes when the sweep wrote the seed's keys between two phases", async () => {
    let phases = 0;
    let sweeps = 0;
    let atRiskBeforeSeed = 0;
    // The sweep's stock_low keys before the inventory phase, and the seed's right after it
    // (the sweep's text ends with a period, the seed's doesn't). One holder object: the fields
    // are set inside `run`, which control-flow narrowing can't see.
    const keys = { sweep: new Set<string>(), seed: null as Set<string> | null };
    const run: ShopSeedOptions["run"] = async (fn) => {
      // Between two committed phases: first look at what the previous phase left, then do what
      // the worker's alert tick does to this shop. Not before the first phase: on an empty shop
      // the sweep only fails ("Create a location first").
      if (phases++ === 0) return withTenant(companyId, fn);
      const early = await beforeInventoryPhase();
      if (!early && !keys.seed) keys.seed = await stockLowKeys(notLike(alerts.message, "%."));
      await withTenant(companyId, (tx) => generateAlerts(tx, systemContext(companyId)));
      sweeps++;
      if (early) keys.sweep = await stockLowKeys();
      // `order_at_risk` is written in the seed's last phase, so every count here precedes it.
      atRiskBeforeSeed = Math.max(
        atRiskBeforeSeed,
        await countAlerts(eq(alerts.kind, "order_at_risk")),
      );
      // A worker's AI credit spend (or a poll's mock import) creates this period's `usage` row
      // through the same `recordUsage` upsert, long before the seed's own usage phase.
      if (sweeps === 3)
        await withTenant(companyId, (tx) => recordUsage(tx, companyId, { aiCredits: 1 }));
      return withTenant(companyId, fn);
    };

    await buildShopData({
      companyId,
      random: rng(20260928),
      run,
      runHistory: (fn) => withSystem(fn, companyId),
      profile: {
        ...DESERT_BLOOM_PROFILE,
        shopifyDomain: `sweep-${companyId.slice(0, 8)}.myshopify.com`,
      },
      people: { owner: userId, office: userId, presser: userId, packer: userId, receiver: userId },
      pins: [],
      issueStationToken: false,
      vendor: { vendorCompanyId: null, name: "Sweep DTF", email: "orders@sweep-race.invalid" },
      volume: { historicalOrders: 12, dueSoonOrders: 6, adSpendDays: 3 },
      render: { designs: false, artwork: false, sheets: false },
    });
    expect(sweeps).toBeGreaterThan(3);

    // The race was real: the sweep held stock_low keys the seed then wrote (a plain insert
    // fails here with `alerts_company_id_dedupe_key_index`), and at-risk keys before the last
    // phase.
    expect(keys.sweep.size).toBeGreaterThan(0);
    expect(keys.seed?.size ?? 0).toBeGreaterThan(0);
    const overlap = [...(keys.seed ?? [])].filter((k) => keys.sweep.has(k));
    expect(overlap.length).toBeGreaterThan(0);
    expect(atRiskBeforeSeed).toBeGreaterThan(0);
    // The seed's keys are the open ones (one row each: the unique index); the sweep's next tick
    // resolved the keys that stopped being low, as it does for a worker started after the seed.
    expect(await countAlerts(and(eq(alerts.kind, "stock_low"), eq(alerts.status, "open")))).toBe(
      keys.seed?.size,
    );

    // One usage row for the period, carrying the seed's numbers, not the early spend's.
    const usageRows = await withSystem((tx) =>
      tx.select().from(usage).where(eq(usage.companyId, companyId)),
    );
    expect(usageRows).toHaveLength(1);
    expect(usageRows[0]).toMatchObject({ aiCredits: 37 });
    expect(usageRows[0]?.ordersImported).toBeGreaterThan(0);
  }, 120_000);
});
