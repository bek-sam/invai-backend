import { and, eq, inArray } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { withSystem, withTenant } from "../../db/client";
import {
  addressVerifications,
  auditLog,
  designs,
  importRuns,
  listings,
  marketPriceSnapshots,
  orderItems,
  orders,
  shipments,
} from "../../db/schema";
import { runJobInline } from "../../lib/queues";
import { createCompany, createConnection, createOrder } from "../../test/fixtures";
import { getProfit, recomputeProfit } from "../finance/service";
import { privacyRetentionSweepJob } from "./jobs";
import { buyerPiiCutoff, sweepStaleAmazonData } from "./service";

/** Companies whose audit write fails, to prove one company's failure doesn't stop the rest. */
const failAuditFor = new Set<string>();
vi.mock("../../lib/audit", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../lib/audit")>();
  return {
    ...real,
    audit: (tx: Parameters<typeof real.audit>[0], input: Parameters<typeof real.audit>[1]) => {
      if (failAuditFor.has(input.companyId)) throw new Error("audit write failed (test)");
      return real.audit(tx, input);
    },
  };
});

const DAY = 86400_000;
const months = (m: number) => {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - m);
  return d;
};
const OLD = () => new Date(buyerPiiCutoff().getTime() - DAY); // 18 months + 1 day
const YOUNG = () => months(17);

type OrderOpts = {
  channel?: "amazon" | "shopify" | "csv";
  connectionId: string;
  placedAt: Date;
  status: (typeof orders.$inferInsert)["status"];
  importRunId?: string;
};

/** An order holding every "drop" value of decision 0026, plus keep values to compare. */
async function seedOrder(companyId: string, o: OrderOpts) {
  const { order } = await createOrder(companyId, o.connectionId, {
    units: 2,
    channel: o.channel ?? "amazon",
    state: o.status === "cancelled" ? "cancelled" : "delivered",
  });
  await withSystem(async (tx) => {
    await tx
      .update(orders)
      .set({
        placedAt: o.placedAt,
        status: o.status,
        shippingMethod: "Std US D2D Dom",
        shippedAt: o.placedAt,
        importRunId: o.importRunId ?? null,
        shippingCents: 499,
        taxCents: 210,
        totalCents: 5709,
      })
      .where(eq(orders.id, order.id));
    await tx
      .update(orderItems)
      .set({ channelListingId: "B0TESTASIN", variantTitle: "Black / M" })
      .where(eq(orderItems.orderId, order.id));
    await tx.insert(shipments).values({
      companyId,
      orderId: order.id,
      status: "delivered",
      carrier: "usps",
      trackingCode: `9400${Math.floor(Math.random() * 1e15)}`,
      postageCents: 512,
      labelFeeCents: 5,
      trackingPushStatus: "failed",
      trackingPushError: "InvalidInput: carrier code not recognised",
    });
    await tx.insert(addressVerifications).values({
      companyId,
      orderId: order.id,
      addressHash: `hash-${order.id}`,
      status: "verified",
      verifiedAt: o.placedAt,
    });
  });
  return order.id;
}

async function snapshot(companyId: string, orderId: string) {
  return withTenant(companyId, async (tx) => ({
    order: (await tx.select().from(orders).where(eq(orders.id, orderId)))[0],
    items: await tx
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, orderId))
      .orderBy(orderItems.unitNo),
    shipments: await tx.select().from(shipments).where(eq(shipments.orderId, orderId)),
    checks: await tx
      .select()
      .from(addressVerifications)
      .where(eq(addressVerifications.orderId, orderId)),
  }));
}

const auditCount = async (companyId: string) =>
  (
    await withTenant(companyId, (tx) =>
      tx
        .select({ id: auditLog.id, data: auditLog.data, summary: auditLog.summary })
        .from(auditLog)
        .where(
          and(eq(auditLog.companyId, companyId), eq(auditLog.action, "privacy.amazon_retention")),
        ),
    )
  ).length;

async function shop() {
  const company = await createCompany();
  const amazon = await createConnection(company.id, "amazon");
  return { id: company.id, amazon: amazon.id };
}

describe("privacy: Amazon non-PII retention sweep (decision 0026)", () => {
  it("clears only drop values on old final Amazon orders; fences hold; second run is a no-op", async () => {
    const a = await shop();
    const shopify = await createConnection(a.id, "shopify");
    const csv = await createConnection(a.id, "csv");
    const [amazonCsvRun] = await withSystem((tx) =>
      tx
        .insert(importRuns)
        .values({
          companyId: a.id,
          connectionId: csv.id,
          format: "amazon",
          status: "completed",
          startedAt: new Date(),
        })
        .returning(),
    );
    const swept = {
      delivered: await seedOrder(a.id, {
        connectionId: a.amazon,
        placedAt: OLD(),
        status: "delivered",
      }),
      cancelled: await seedOrder(a.id, {
        connectionId: a.amazon,
        placedAt: OLD(),
        status: "cancelled",
      }),
      // An Amazon file uploaded to a generic CSV connection: orders.channel is "csv".
      viaCsv: await seedOrder(a.id, {
        channel: "csv",
        connectionId: csv.id,
        placedAt: OLD(),
        status: "shipped",
        importRunId: amazonCsvRun?.id,
      }),
    };
    const fenced = {
      young: await seedOrder(a.id, {
        connectionId: a.amazon,
        placedAt: YOUNG(),
        status: "delivered",
      }),
      openOld: await seedOrder(a.id, {
        connectionId: a.amazon,
        placedAt: months(30),
        status: "in_production",
      }),
      partialOld: await seedOrder(a.id, {
        connectionId: a.amazon,
        placedAt: OLD(),
        status: "partially_shipped",
      }),
      shopifyOld: await seedOrder(a.id, {
        channel: "shopify",
        connectionId: shopify.id,
        placedAt: OLD(),
        status: "delivered",
      }),
      csvOld: await seedOrder(a.id, {
        channel: "csv",
        connectionId: csv.id,
        placedAt: OLD(),
        status: "delivered",
      }),
    };
    const before = new Map<string, Awaited<ReturnType<typeof snapshot>>>();
    for (const id of [...Object.values(swept), ...Object.values(fenced)])
      before.set(id, await snapshot(a.id, id));

    // Profit for the old month, before.
    const period = {
      from: new Date(OLD().getTime() - 2 * DAY).toISOString(),
      to: new Date(OLD().getTime() + DAY).toISOString(),
    };
    const profit = () =>
      withTenant(a.id, async (tx) => {
        await recomputeProfit(tx, { companyId: a.id }, { orderIds: Object.values(swept) });
        return (await getProfit(tx, { companyId: a.id }, { dimension: "channel", period })).totals;
      });
    const profitBefore = await profit();
    expect(profitBefore.revenue).toBeGreaterThan(0);

    const res = await sweepStaleAmazonData();
    expect(res.failedCompanies).toBe(0);
    expect(res.orders).toBeGreaterThanOrEqual(3);

    for (const id of Object.values(swept)) {
      const was = before.get(id);
      const now = await snapshot(a.id, id);
      // Drop values gone.
      expect(now.order?.shippingMethod).toBeNull();
      expect(now.items.every((i) => i.channelListingId === null)).toBe(true);
      expect(now.shipments.every((s) => s.trackingPushError === null)).toBe(true);
      expect(now.checks).toEqual([]);
      // Every keep value identical, including updated_at.
      expect(now.order).toEqual({ ...was?.order, shippingMethod: null });
      expect(now.items).toEqual(was?.items.map((i) => ({ ...i, channelListingId: null })));
      expect(now.shipments).toEqual(was?.shipments.map((s) => ({ ...s, trackingPushError: null })));
    }
    // Fences: younger, open (any age), partially shipped, other channels: untouched.
    for (const id of Object.values(fenced))
      expect(await snapshot(a.id, id)).toEqual(before.get(id));

    // Profit for that month adds up to the same total, even after a recompute.
    expect(await profit()).toEqual(profitBefore);

    // Counts only in the audit row, never order numbers.
    expect(await auditCount(a.id)).toBe(1);
    const [row] = await withTenant(a.id, (tx) =>
      tx
        .select({ data: auditLog.data, summary: auditLog.summary })
        .from(auditLog)
        .where(eq(auditLog.action, "privacy.amazon_retention")),
    );
    expect(row?.data).toMatchObject({
      orders: 3,
      rows: { orders: 3, order_items: 6, shipments: 3 },
    });
    const orderNos = (await Promise.all(Object.values(swept).map((id) => before.get(id)))).map(
      (s) => s?.order?.orderNo as string,
    );
    for (const no of orderNos) expect(JSON.stringify(row)).not.toContain(no);

    // Idempotent: a second run selects nothing and writes no audit row.
    const again = await sweepStaleAmazonData();
    expect(again.orders).toBe(0);
    expect(Object.values(again.rowsCleared).every((v) => v === 0)).toBe(true);
    expect(await auditCount(a.id)).toBe(1);
  });

  it("a dry run reports the same counts and changes nothing", async () => {
    const a = await shop();
    const ids = [
      await seedOrder(a.id, { connectionId: a.amazon, placedAt: OLD(), status: "delivered" }),
      await seedOrder(a.id, { connectionId: a.amazon, placedAt: YOUNG(), status: "delivered" }),
    ];
    const before = await Promise.all(ids.map((id) => snapshot(a.id, id)));
    const dry = await sweepStaleAmazonData(new Date(), { dryRun: true });
    expect(dry.orders).toBeGreaterThanOrEqual(1);
    expect(await Promise.all(ids.map((id) => snapshot(a.id, id)))).toEqual(before);
    expect(await auditCount(a.id)).toBe(0);
    const dryAgain = await sweepStaleAmazonData(new Date(), { dryRun: true });
    expect(dryAgain).toEqual(dry);
    const real = await sweepStaleAmazonData();
    expect({ orders: real.orders, rowsCleared: real.rowsCleared }).toEqual({
      orders: dry.orders,
      rowsCleared: dry.rowsCleared,
    });
  });

  it("clears old Amazon import-run logs and listing payloads, deletes old Amazon price snapshots", async () => {
    const a = await shop();
    const shopify = await createConnection(a.id, "shopify");
    const old = OLD();
    const { runs, lst, snaps } = await withSystem(async (tx) => {
      const [design] = await tx
        .insert(designs)
        .values({ companyId: a.id, code: `D${Date.now() % 100000}`, name: "Cactus" })
        .returning();
      const run = (connectionId: string, startedAt: Date, format: "amazon" | "shopify") => ({
        companyId: a.id,
        connectionId,
        format,
        status: "completed" as const,
        fileKey: `${a.id}/csv/x.csv`,
        errors: [{ row: 3, message: "Unknown SKU" }],
        rowsTotal: 4,
        ordersImported: 3,
        startedAt,
      });
      const runs = await tx
        .insert(importRuns)
        .values([
          run(a.amazon, old, "amazon"),
          run(a.amazon, YOUNG(), "amazon"),
          run(shopify.id, old, "shopify"),
        ])
        .returning();
      const listing = (connectionId: string, channel: "amazon" | "shopify", syncedAt: Date) => ({
        companyId: a.id,
        connectionId,
        channel,
        channelListingId: `L-${Math.random()}`,
        title: "Cactus tee",
        raw: { asin: "B0TESTASIN", bullet: "Soft cotton" },
        lastSyncedAt: syncedAt,
      });
      const lst = await tx
        .insert(listings)
        .values([
          listing(a.amazon, "amazon", old),
          listing(a.amazon, "amazon", new Date()),
          listing(shopify.id, "shopify", old),
        ])
        .returning();
      const snap = (source: "amazon_pricing" | "own", asOf: Date, period: string) => ({
        companyId: a.id,
        designId: design?.id as string,
        channel: "amazon" as const,
        source,
        granularity: "month" as const,
        period,
        n: 5,
        medianCents: 2199,
        licence: "official_api" as const,
        mock: true,
        asOf,
        fetchedAt: asOf,
      });
      const snaps = await tx
        .insert(marketPriceSnapshots)
        .values([
          snap("amazon_pricing", old, "2020-01"),
          snap("amazon_pricing", new Date(), "2026-09"),
          snap("own", old, "2020-01"),
        ])
        .returning();
      return { runs, lst, snaps };
    });

    const res = await sweepStaleAmazonData();
    expect(res.failedCompanies).toBe(0);

    const after = await withTenant(a.id, async (tx) => ({
      runs: await tx
        .select()
        .from(importRuns)
        .where(
          inArray(
            importRuns.id,
            runs.map((r) => r.id),
          ),
        ),
      lst: await tx
        .select()
        .from(listings)
        .where(
          inArray(
            listings.id,
            lst.map((r) => r.id),
          ),
        ),
      snaps: await tx
        .select({ id: marketPriceSnapshots.id })
        .from(marketPriceSnapshots)
        .where(
          inArray(
            marketPriceSnapshots.id,
            snaps.map((r) => r.id),
          ),
        ),
    }));
    const byId = <T extends { id: string }>(rows: T[], id: string | undefined) =>
      rows.find((r) => r.id === id);
    const [oldRun, youngRun, shopifyRun] = runs;
    expect(byId(after.runs, oldRun?.id)).toEqual({ ...oldRun, errors: [], fileKey: "" });
    expect(byId(after.runs, youngRun?.id)).toEqual(youngRun);
    expect(byId(after.runs, shopifyRun?.id)).toEqual(shopifyRun);
    const [oldL, newL, shopifyL] = lst;
    expect(byId(after.lst, oldL?.id)).toEqual({ ...oldL, raw: {} });
    expect(byId(after.lst, newL?.id)).toEqual(newL);
    expect(byId(after.lst, shopifyL?.id)).toEqual(shopifyL);
    expect(after.snaps.map((s) => s.id).sort()).toEqual([snaps[1]?.id, snaps[2]?.id].sort());

    const again = await sweepStaleAmazonData();
    expect(again.rowsCleared.import_runs + again.rowsCleared.listings).toBe(0);
    expect(again.rowsCleared.market_price_snapshots).toBe(0);
  });

  it("batches at most 500 orders per transaction and loops until done", async () => {
    const a = await shop();
    const placedAt = OLD();
    await withSystem((tx) =>
      tx.insert(orders).values(
        Array.from({ length: 501 }, (_, i) => ({
          companyId: a.id,
          connectionId: a.amazon,
          channel: "amazon" as const,
          channelOrderId: `113-${a.id.slice(0, 8)}-${i}`,
          orderNo: `113-${i}`,
          status: "delivered" as const,
          placedAt,
          shipBy: placedAt,
          shippingMethod: "Expedited",
          totalCents: 2500,
        })),
      ),
    );
    await sweepStaleAmazonData();
    const left = await withTenant(a.id, (tx) =>
      tx
        .select({ id: orders.id })
        .from(orders)
        .where(and(eq(orders.companyId, a.id), eq(orders.shippingMethod, "Expedited"))),
    );
    expect(left).toEqual([]);
    // Two transactions (500 + 1), one audit row each.
    expect(await auditCount(a.id)).toBe(2);
  });

  it("a failing company is logged and skipped; the others are swept", async () => {
    const bad = await shop();
    const good = await shop();
    const badId = await seedOrder(bad.id, {
      connectionId: bad.amazon,
      placedAt: OLD(),
      status: "delivered",
    });
    const goodId = await seedOrder(good.id, {
      connectionId: good.amazon,
      placedAt: OLD(),
      status: "delivered",
    });
    const badBefore = await snapshot(bad.id, badId);
    failAuditFor.add(bad.id);
    try {
      const res = await sweepStaleAmazonData();
      expect(res.failedCompanies).toBeGreaterThanOrEqual(1);
    } finally {
      failAuditFor.delete(bad.id);
    }
    // The failed company's batch rolled back as a whole; the other company was swept.
    expect(await snapshot(bad.id, badId)).toEqual(badBefore);
    expect((await snapshot(good.id, goodId)).order?.shippingMethod).toBeNull();
    // Next run picks the failed company up.
    await sweepStaleAmazonData();
    expect((await snapshot(bad.id, badId)).order?.shippingMethod).toBeNull();
  });

  it("runs inside the daily privacy.retentionSweep job, after the PII redaction", async () => {
    const a = await shop();
    const id = await seedOrder(a.id, {
      connectionId: a.amazon,
      placedAt: OLD(),
      status: "delivered",
    });
    await withSystem((tx) => tx.update(orders).set({ buyerNote: "gift" }).where(eq(orders.id, id)));
    const first = (await runJobInline(privacyRetentionSweepJob, {})) as {
      amazon: { orders: number };
    };
    expect(first.amazon.orders).toBeGreaterThanOrEqual(1);
    const s = await snapshot(a.id, id);
    expect(s.order).toMatchObject({ shippingMethod: null, buyerNote: null });
    const second = (await runJobInline(privacyRetentionSweepJob, {})) as {
      amazon: { orders: number };
    };
    expect(second.amazon.orders).toBe(0);
  });
});
