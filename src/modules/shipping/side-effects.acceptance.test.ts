import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystem, withTenant } from "../../db/client";
import { buyerPii, jobs, labels, orderItems, shipments } from "../../db/schema";
import type { CarrierAdapter, PurchasedLabel } from "../../integrations/carriers";
import * as carriersModule from "../../integrations/carriers";
import type { ChannelAdapter } from "../../integrations/channels";
import * as channelsModule from "../../integrations/channels";
import { runJobInline } from "../../lib/queues";
import {
  createCompany,
  createConnection,
  createLocation,
  createOrder,
  createUser,
  tenantContext,
} from "../../test/fixtures";
import { batchBuyJob, startBatchBuy } from "./batch";
import * as svc from "./service";

/*
 * T-20-3 (B-71) AC2, shipping: the cases the existing suites don't cover. Two *concurrent*
 * requests for the same side effect (a double click, two workers) make one carrier or channel
 * call and one DB effect, and the loser gets a clear answer, never a second charge. The CSV
 * channel never reaches a channel adapter. The carrier and Shopify are fakes that count calls
 * and can hold a call open so both requests are really in flight at once.
 */

vi.mock("../../integrations/carriers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../integrations/carriers")>();
  return { ...actual, carrierAdapter: vi.fn(actual.carrierAdapter) };
});
vi.mock("../../integrations/channels", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../integrations/channels")>();
  return { ...actual, getChannelAdapter: vi.fn(actual.getChannelAdapter) };
});

import { shopifyAdapter } from "../../integrations/channels/shopify";

const realGetChannelAdapter = vi
  .mocked(channelsModule.getChannelAdapter)
  .getMockImplementation() as typeof channelsModule.getChannelAdapter;

/** Resolves once `n` callers are waiting, so two requests are provably in flight together. */
function gate(n: number) {
  let waiting = 0;
  let open: () => void = () => {};
  const opened = new Promise<void>((r) => {
    open = r;
  });
  return async () => {
    waiting += 1;
    if (waiting >= n) open();
    await opened;
  };
}

type FakeCarrier = CarrierAdapter & {
  sold: Map<string, PurchasedLabel & { refundStatus: string | null }>;
  calls: { rate: number; buy: number; lookup: number; void: number };
  onRate: (() => Promise<void>) | null;
  onBuy: (() => Promise<void>) | null;
  onVoid: (() => Promise<void>) | null;
};

function fakeCarrier(): FakeCarrier {
  const fake: FakeCarrier = {
    provider: "easypost",
    sold: new Map(),
    calls: { rate: 0, buy: 0, lookup: 0, void: 0 },
    onRate: null,
    onBuy: null,
    onVoid: null,
    async rate(req) {
      fake.calls.rate += 1;
      await fake.onRate?.();
      return {
        carrierShipmentId: `shp_t203_${req.shipmentId.replace(/-/g, "")}_${fake.calls.rate}`,
        rates: [
          {
            rateId: `rate_${req.shipmentId.slice(0, 8)}_ga`,
            carrier: "usps",
            service: "GroundAdvantage",
            serviceLabel: "USPS Ground Advantage",
            rateCents: 512,
            deliveryDays: 3,
            estimatedDeliveryAt: null,
          },
        ],
      };
    },
    async buy(req) {
      fake.calls.buy += 1;
      await fake.onBuy?.();
      if (fake.sold.has(req.carrierShipmentId))
        throw new carriersModule.CarrierError("fake", "upstream", "already bought", "not_done");
      const label = {
        trackingCode: `9400T203${req.carrierShipmentId.slice(-12)}`,
        trackingUrl: null,
        labelKey: carriersModule.labelObjectKey(req.companyId, req.carrierShipmentId),
        carrierLabelId: `pl_${fake.calls.buy}`,
        postageCents: req.rate.rateCents,
      };
      fake.sold.set(req.carrierShipmentId, { ...label, refundStatus: null });
      return label;
    },
    async lookup({ carrierShipmentId }) {
      fake.calls.lookup += 1;
      const r = fake.sold.get(carrierShipmentId);
      return { label: r ?? null, refundStatus: r?.refundStatus ?? null };
    },
    async void({ carrierShipmentId }) {
      fake.calls.void += 1;
      await fake.onVoid?.();
      const r = fake.sold.get(carrierShipmentId);
      if (r) r.refundStatus = "submitted";
      return { ok: true, pending: true };
    },
  };
  return fake;
}

type FakeChannel = ChannelAdapter & { calls: number; onPush: (() => Promise<void>) | null };

function fakeShopify(): FakeChannel {
  const fake: FakeChannel = {
    ...shopifyAdapter("mock"),
    calls: 0,
    onPush: null,
    async pushTracking() {
      fake.calls += 1;
      await fake.onPush?.();
      return { status: "pushed", externalId: `ful_${fake.calls}`, message: null };
    },
  };
  return fake;
}

const from = {
  name: "Desert Bloom",
  company: null,
  street1: "100 Main St",
  street2: null,
  city: "Phoenix",
  state: "AZ",
  zip: "85004",
  country: "US",
  phone: null,
  email: null,
};

const code = (r: PromiseSettledResult<unknown>) =>
  r.status === "rejected" ? ((r.reason as { code?: string }).code ?? "ERROR") : "ok";

describe("T-20-3 shipping side effects: concurrent doubles and the CSV channel", () => {
  let companyId: string;
  let ctx: ReturnType<typeof tenantContext>;
  let csvConn: string;
  let shopifyConn: string;
  let carrier: FakeCarrier;
  let shopify: FakeChannel;
  let channelCalls: number;

  beforeAll(async () => {
    companyId = (await createCompany()).id;
    const owner = await createUser(companyId, "owner");
    ctx = tenantContext(companyId, owner.id, "owner");
    await createLocation(companyId);
    csvConn = (await createConnection(companyId, "csv")).id;
    shopifyConn = (await createConnection(companyId, "shopify")).id;
    await withTenant(companyId, (tx) => svc.updateSettings(tx, ctx, { fromAddress: from }));
  });

  beforeEach(() => {
    carrier = fakeCarrier();
    shopify = fakeShopify();
    channelCalls = 0;
    vi.mocked(carriersModule.carrierAdapter).mockImplementation(async () => carrier);
    vi.mocked(channelsModule.getChannelAdapter).mockImplementation(
      async (kind, provider, scope) => {
        channelCalls += 1;
        return kind === "shopify" ? shopify : realGetChannelAdapter(kind, provider, scope);
      },
    );
  });

  async function packedOrder(channel: "csv" | "shopify" = "csv", units = 1) {
    const { order, items } = await createOrder(
      companyId,
      channel === "shopify" ? shopifyConn : csvConn,
      { units, state: "packed", channel },
    );
    await withSystem((tx) =>
      tx.insert(buyerPii).values({
        companyId,
        orderId: order.id,
        name: "Test Buyer",
        street1: "1 Buyer Way",
        city: "Brooklyn",
        state: "NY",
        zip: "11201",
      }),
    );
    return { order, items };
  }

  const row = async (id: string) => {
    const [r] = await withSystem((tx) => tx.select().from(shipments).where(eq(shipments.id, id)));
    if (!r) throw new Error("shipment missing");
    return r;
  };
  const shipmentsOf = (orderId: string) =>
    withSystem((tx) => tx.select().from(shipments).where(eq(shipments.orderId, orderId)));
  const purchasedLabels = async (shipmentId: string) =>
    (
      await withSystem((tx) => tx.select().from(labels).where(eq(labels.shipmentId, shipmentId)))
    ).filter((l) => l.status === "purchased");
  const states = async (orderId: string) =>
    (
      await withSystem((tx) =>
        tx
          .select({ state: orderItems.state })
          .from(orderItems)
          .where(eq(orderItems.orderId, orderId)),
      )
    ).map((r) => r.state);

  async function rated(channel: "csv" | "shopify" = "csv") {
    const { order, items } = await packedOrder(channel);
    const quote = await svc.rateOrder(ctx, { orderId: order.id });
    return { order, items, shipmentId: quote.shipmentId, rateId: quote.rates[0]?.rateId as string };
  }

  async function labeled(channel: "csv" | "shopify" = "csv") {
    const r = await rated(channel);
    const shipment = await svc.buyLabel(ctx, { shipmentId: r.shipmentId, rateId: r.rateId });
    return { ...r, shipment };
  }

  it("rateOrder: two concurrent rate requests share one shipment row (no duplicate open shipments)", async () => {
    const { order } = await packedOrder();
    const results = await Promise.allSettled([
      svc.rateOrder(ctx, { orderId: order.id }),
      svc.rateOrder(ctx, { orderId: order.id }),
    ]);
    // Rating charges nothing, so both may succeed; what must not happen is a second open shipment.
    expect(results.map(code).every((c) => c === "ok" || c === "CONFLICT")).toBe(true);
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    const rows = await shipmentsOf(order.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("rated");
    expect(rows[0]?.rateQuotes).toHaveLength(1);
  });

  it("buyLabel: a concurrent double buy charges once, records one label, and answers the loser clearly", async () => {
    const { shipmentId, rateId } = await rated();
    const results = await Promise.allSettled([
      svc.buyLabel(ctx, { shipmentId, rateId }),
      svc.buyLabel(ctx, { shipmentId, rateId }),
    ]);
    expect(carrier.calls.buy).toBe(1);
    const codes = results.map(code).sort();
    // The winner is labeled; the other either sees the stored label or is told it's in flight.
    expect(codes.every((c) => c === "ok" || c === "CONFLICT")).toBe(true);
    for (const r of results)
      if (r.status === "fulfilled") expect((r.value as { status: string }).status).toBe("labeled");
    expect(await purchasedLabels(shipmentId)).toHaveLength(1);
    expect(await row(shipmentId)).toMatchObject({ status: "labeled", buyAttemptedAt: null });
    // A third call after both settled is the stored result, not a purchase.
    const again = await svc.buyLabel(ctx, { shipmentId, rateId });
    expect(again.status).toBe("labeled");
    expect(carrier.calls.buy).toBe(1);
  });

  it("buyLabel: while the carrier call is open, the second request is refused before any carrier call", async () => {
    const { shipmentId, rateId } = await rated();
    const both = gate(2);
    let secondCode = "";
    carrier.onBuy = async () => {
      // A (wrong) second carrier call returns at once, so a missing guard fails on the count.
      if (carrier.calls.buy !== 1) return;
      // The carrier is holding the first buy; the second buy arrives now.
      secondCode = code((await Promise.allSettled([svc.buyLabel(ctx, { shipmentId, rateId })]))[0]);
      await both();
    };
    const first = svc.buyLabel(ctx, { shipmentId, rateId });
    await both();
    const [outcome] = await Promise.allSettled([first]);
    expect(carrier.calls.buy).toBe(1);
    expect(carrier.calls.lookup).toBe(0);
    expect(secondCode).toBe("CONFLICT");
    expect(outcome?.status).toBe("fulfilled");
    expect(await row(shipmentId)).toMatchObject({ status: "labeled" });
    expect(await purchasedLabels(shipmentId)).toHaveLength(1);
  });

  it("voidShipment: a concurrent double void refunds once and ends voided", async () => {
    const { shipment } = await labeled();
    const results = await Promise.allSettled([
      svc.voidShipment(ctx, { id: shipment.id, reason: "wrong box" }),
      svc.voidShipment(ctx, { id: shipment.id, reason: "wrong box" }),
    ]);
    expect(carrier.calls.void).toBe(1);
    expect(results.map(code).every((c) => c === "ok" || c === "CONFLICT")).toBe(true);
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    expect(await row(shipment.id)).toMatchObject({ status: "voided", voidAttemptedAt: null });
    const [label] = await withSystem((tx) =>
      tx.select().from(labels).where(eq(labels.shipmentId, shipment.id)),
    );
    expect(label?.status).toBe("refund_pending");
    // Voiding again is the stored result.
    expect((await svc.voidShipment(ctx, { id: shipment.id })).status).toBe("voided");
    expect(carrier.calls.void).toBe(1);
  });

  it("voidShipment: while the carrier call is open, the second void is refused before any carrier call", async () => {
    const { shipment } = await labeled();
    const both = gate(2);
    let secondCode = "";
    carrier.onVoid = async () => {
      if (carrier.calls.void !== 1) return;
      secondCode = code(
        (
          await Promise.allSettled([
            svc.voidShipment(ctx, { id: shipment.id, reason: "wrong box" }),
          ])
        )[0],
      );
      await both();
    };
    const first = svc.voidShipment(ctx, { id: shipment.id, reason: "wrong box" });
    await both();
    const [outcome] = await Promise.allSettled([first]);
    expect(carrier.calls.void).toBe(1);
    expect(secondCode).toBe("CONFLICT");
    expect(outcome?.status).toBe("fulfilled");
    expect(await row(shipment.id)).toMatchObject({ status: "voided", voidAttemptedAt: null });
  });

  it("batchBuy: two batches over the same orders running at once buy one label per order", async () => {
    const a = (await packedOrder()).order.id;
    const b = (await packedOrder()).order.id;
    const [batch1, batch2] = await Promise.all([
      startBatchBuy(ctx, { orderIds: [a, b], strategy: "cheapest" }),
      startBatchBuy(ctx, { orderIds: [b, a], strategy: "cheapest" }),
    ]);
    await Promise.all([
      runJobInline(batchBuyJob, { companyId, jobId: batch1.jobId }),
      runJobInline(batchBuyJob, { companyId, jobId: batch2.jobId }),
    ]);
    expect(carrier.calls.buy).toBe(2);
    for (const orderId of [a, b]) {
      const rows = await shipmentsOf(orderId);
      const live = rows.filter((r) => r.status === "labeled");
      expect(live).toHaveLength(1);
      expect(await purchasedLabels(live[0]?.id as string)).toHaveLength(1);
    }
    const jobRows = await withSystem((tx) =>
      tx
        .select({ id: jobs.id, status: jobs.status, resultIds: jobs.resultIds })
        .from(jobs)
        .where(eq(jobs.companyId, companyId)),
    );
    const mine = jobRows.filter((j) => [batch1.jobId, batch2.jobId].includes(j.id));
    expect(mine.map((j) => j.status)).toEqual(["done", "done"]);
    // Each label is credited to exactly one batch, so postage is never counted twice.
    const credited = mine.flatMap((j) => j.resultIds);
    expect(new Set(credited).size).toBe(credited.length);
    expect(credited).toHaveLength(2);
  });

  it("pushTracking: a concurrent double push notifies the channel once and ships the units once", async () => {
    const { order, shipment } = await labeled("shopify");
    const both = gate(2);
    shopify.onPush = async () => both();
    const push = () => svc.pushTracking(companyId, ctx, shipment.id);
    const [a, b] = await Promise.all([
      push(),
      (async () => {
        await both();
        return push();
      })(),
    ]);
    expect(shopify.calls).toBe(1);
    expect([a, b].sort()).toEqual(["busy", "pushed"]);
    expect(await row(shipment.id)).toMatchObject({
      trackingPushStatus: "pushed",
      pushAttemptedAt: null,
      trackingPushAttempts: 1,
    });
    expect(await states(order.id)).toEqual(["shipped"]);
    expect(await push()).toBe("skipped");
    expect(shopify.calls).toBe(1);
  });

  it("pushTracking on the CSV channel: the label is recorded not_required and no channel adapter is ever asked", async () => {
    const { order, shipment } = await labeled("csv");
    expect(shipment.trackingPush.status).toBe("not_required");
    expect(await svc.pushTracking(companyId, ctx, shipment.id)).toBe("skipped");
    expect(await svc.pushTracking(companyId, ctx, shipment.id)).toBe("skipped");
    expect(channelCalls).toBe(0);
    expect(await row(shipment.id)).toMatchObject({
      trackingPushStatus: "not_required",
      trackingPushAttempts: 0,
    });
    // CSV units ship on the carrier scan, never on a push.
    expect(await states(order.id)).toEqual(["packed"]);
  });
});
