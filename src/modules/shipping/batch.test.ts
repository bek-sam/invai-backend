import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystem, withTenant } from "../../db/client";
import { buyerPii, jobs, labels, outboxEvents, shipments, subscriptions } from "../../db/schema";
import type { CarrierAdapter, PurchasedLabel } from "../../integrations/carriers";
import * as carriersModule from "../../integrations/carriers";
import { CarrierError } from "../../integrations/carriers/types";
import { runJobInline } from "../../lib/queues";
import {
  createCompany,
  createConnection,
  createOrder,
  createUser,
  tenantContext,
} from "../../test/fixtures";
import * as jobRows from "../production/job-rows";
import { batchBuyJob, startBatchBuy } from "./batch";
import * as svc from "./service";

/*
 * T-3-4 (B-61): batchBuy always runs as a job, one crash-safe buyLabel per order. The carrier
 * is a fake that counts buys and remembers what it sold, like EasyPost's shipment records.
 */

vi.mock("../../integrations/carriers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../integrations/carriers")>();
  return { ...actual, carrierAdapter: vi.fn(actual.carrierAdapter) };
});

vi.mock("../production/job-rows", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../production/job-rows")>();
  return { ...actual, updateJobRow: vi.fn(actual.updateJobRow) };
});

type Fake = CarrierAdapter & {
  sold: Map<string, PurchasedLabel>;
  calls: { rate: number; buy: number; lookup: number };
};

function fakeCarrier(): Fake {
  const fake: Fake = {
    provider: "easypost",
    sold: new Map(),
    calls: { rate: 0, buy: 0, lookup: 0 },
    async rate(req) {
      fake.calls.rate += 1;
      return {
        carrierShipmentId: `shp_fake_${req.shipmentId}`,
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
      if (fake.sold.has(req.carrierShipmentId))
        throw new carriersModule.CarrierError("fake", "upstream", "already bought", "not_done");
      const label = soldLabel(req.companyId, req.shipmentId, req.carrierShipmentId);
      fake.sold.set(req.carrierShipmentId, label);
      return label;
    },
    async lookup({ carrierShipmentId }) {
      fake.calls.lookup += 1;
      return { label: fake.sold.get(carrierShipmentId) ?? null, refundStatus: null };
    },
    async void() {
      return { ok: true, pending: false };
    },
  };
  return fake;
}

function soldLabel(companyId: string, shipmentId: string, carrierShipmentId: string) {
  return {
    trackingCode: `9400FAKE${shipmentId.replace(/-/g, "").slice(0, 12)}`,
    trackingUrl: null,
    labelKey: carriersModule.labelObjectKey(companyId, carrierShipmentId),
    carrierLabelId: `pl_${carrierShipmentId}`,
    postageCents: 512,
  } satisfies PurchasedLabel;
}

const address = {
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

describe("batch label buy job", () => {
  let companyId: string;
  let ctx: ReturnType<typeof tenantContext>;
  let connectionId: string;
  let fake: Fake;

  beforeAll(async () => {
    companyId = (await createCompany()).id;
    const owner = await createUser(companyId, "owner");
    ctx = tenantContext(companyId, owner.id, "owner");
    connectionId = (await createConnection(companyId, "csv")).id;
    await withTenant(companyId, (tx) => svc.updateSettings(tx, ctx, { fromAddress: address }));
  });

  beforeEach(() => {
    fake = fakeCarrier();
    vi.mocked(carriersModule.carrierAdapter).mockImplementation(async () => fake);
  });

  async function packedOrders(n: number, cid = companyId, conn = connectionId) {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const { order } = await createOrder(cid, conn, { units: 1, state: "packed" });
      await withSystem((tx) =>
        tx.insert(buyerPii).values({
          companyId: cid,
          orderId: order.id,
          name: "Test Buyer",
          street1: "1 Buyer Way",
          city: "Brooklyn",
          state: "NY",
          zip: "11201",
        }),
      );
      ids.push(order.id);
    }
    return ids;
  }

  const labelCount = async (orderIds: string[]) => {
    const rows = await withSystem((tx) =>
      tx
        .select({ orderId: shipments.orderId })
        .from(labels)
        .innerJoin(shipments, eq(shipments.id, labels.shipmentId))
        .where(eq(labels.status, "purchased")),
    );
    return rows.filter((r) => orderIds.includes(r.orderId)).length;
  };

  const jobRow = async (id: string) => {
    const [row] = await withTenant(companyId, (tx) =>
      tx.select().from(jobs).where(eq(jobs.id, id)),
    );
    if (!row) throw new Error("job row missing");
    return row;
  };

  it("answers queued at once, then the job buys one label per order", async () => {
    const orderIds = await packedOrders(4);
    const res = await startBatchBuy(ctx, { orderIds, strategy: "cheapest" });
    expect(res).toMatchObject({
      status: "queued",
      results: [],
      labeled: 0,
      failed: 0,
      totalPostage: 0,
    });
    expect(fake.calls.buy).toBe(0);
    expect(await jobRow(res.jobId)).toMatchObject({ kind: "batch_labels", status: "queued" });
    const events = await withSystem((tx) =>
      tx.select().from(outboxEvents).where(eq(outboxEvents.name, "shipping.batch_requested")),
    );
    expect(events.some((e) => e.payload.jobId === res.jobId)).toBe(true);

    await runJobInline(batchBuyJob, { companyId, jobId: res.jobId });
    expect(fake.calls.buy).toBe(4);
    expect(await labelCount(orderIds)).toBe(4);
    const job = await jobRow(res.jobId);
    expect(job).toMatchObject({ status: "done", progress: 1 });
    expect(job.resultIds).toHaveLength(4);
    expect(job.message).toMatch(/^4 labeled, 0 failed; postage \$20\.48$/);

    // Running the job again (duplicate delivery) buys nothing.
    await runJobInline(batchBuyJob, { companyId, jobId: res.jobId });
    expect(fake.calls.buy).toBe(4);
  });

  it("skips orders that already have a label and reports per-order failures", async () => {
    const [labeledOrder, fresh] = await packedOrders(2);
    const q = await svc.rateOrder(ctx, { orderId: labeledOrder as string });
    await svc.buyLabel(ctx, { shipmentId: q.shipmentId, rateId: q.rates[0]?.rateId as string });
    const unpacked = (await createOrder(companyId, connectionId, { units: 1, state: "ready" }))
      .order.id;
    const res = await startBatchBuy(ctx, {
      orderIds: [labeledOrder as string, fresh as string, unpacked],
    });
    await runJobInline(batchBuyJob, { companyId, jobId: res.jobId });
    const job = await jobRow(res.jobId);
    const results = (job.input as { results: Record<string, { status: string }> }).results;
    expect(results[labeledOrder as string]?.status).toBe("skipped");
    expect(results[fresh as string]?.status).toBe("labeled");
    expect(results[unpacked]?.status).toBe("failed");
    expect(job.resultIds).toHaveLength(1);
    expect(job.message).toMatch(/^1 labeled, 1 failed, 1 skipped/);
    // Partial success is still a finished job, not a failed one (B-482).
    expect(job).toMatchObject({ status: "done", error: null });
  });

  // B-482: a batch that bought nothing must not look like a success.
  async function shopWithoutShipFrom() {
    const cid = (await createCompany()).id;
    const owner = await createUser(cid, "owner");
    const c = tenantContext(cid, owner.id, "owner");
    const conn = (await createConnection(cid, "csv")).id;
    return { cid, c, conn };
  }
  const jobCount = async (cid: string) =>
    (await withTenant(cid, (tx) => tx.select().from(jobs))).length;
  const SHIP_FROM = "Set a ship-from address in shipping settings first";

  it("refuses at once without a ship-from address, with the single buy's exact message (B-482)", async () => {
    const { cid, c, conn } = await shopWithoutShipFrom();
    const orderIds = await packedOrders(3, cid, conn);
    const single = await svc.rateOrder(c, { orderId: orderIds[0] as string }).then(
      () => null,
      (e: unknown) => e as { code: string; message: string },
    );
    const batch = await startBatchBuy(c, { orderIds }).then(
      () => null,
      (e: unknown) => e as { code: string; message: string },
    );
    expect(single).toMatchObject({ code: "BAD_REQUEST", message: SHIP_FROM });
    expect(batch?.code).toBe(single?.code);
    expect(Buffer.from(batch?.message ?? "")).toEqual(Buffer.from(single?.message ?? "x"));
    expect(await jobCount(cid)).toBe(0);
    const events = await withSystem((tx) =>
      tx.select().from(outboxEvents).where(eq(outboxEvents.companyId, cid)),
    );
    expect(events.filter((e) => e.name === "shipping.batch_requested")).toHaveLength(0);
    const ships = await withTenant(cid, (tx) => tx.select().from(shipments));
    expect(ships).toHaveLength(0);
    expect(fake.calls.buy).toBe(0);
  });

  it("a batch where every order fails ends failed with the reason, once (B-482)", async () => {
    const { cid, c, conn } = await shopWithoutShipFrom();
    await withTenant(cid, (tx) => svc.updateSettings(tx, c, { fromAddress: address }));
    const orderIds = await packedOrders(3, cid, conn);
    const res = await startBatchBuy(c, { orderIds });
    // The preflight passed; the address disappears before the worker runs.
    await withTenant(cid, (tx) => svc.updateSettings(tx, c, { fromAddress: null }));
    await runJobInline(batchBuyJob, { companyId: cid, jobId: res.jobId });
    const read = async () => {
      const [row] = await withTenant(cid, (tx) => tx.select().from(jobs));
      if (!row) throw new Error("job row missing");
      return row;
    };
    const job = await read();
    expect(job).toMatchObject({
      status: "failed",
      progress: 1,
      error: SHIP_FROM,
      message: "0 labeled, 3 failed; postage $0.00",
      resultIds: [],
    });
    expect(fake.calls.buy).toBe(0);
    // A duplicate delivery skips a finished job and changes nothing.
    await expect(runJobInline(batchBuyJob, { companyId: cid, jobId: res.jobId })).resolves.toEqual({
      skipped: true,
    });
    expect(await read()).toMatchObject({ status: "failed", error: SHIP_FROM });
  });

  it("the job's reason is the most frequent failure, a tie goes to the first order (B-482)", async () => {
    // A packed order with no buyer_pii row fails the address check; ready orders are not packed.
    const packedNoAddr = (await createOrder(companyId, connectionId, { units: 1, state: "packed" }))
      .order.id;
    const ready1 = (await createOrder(companyId, connectionId, { units: 1, state: "ready" })).order
      .id;
    const ready2 = (await createOrder(companyId, connectionId, { units: 1, state: "ready" })).order
      .id;
    const run = async (orderIds: string[]) => {
      const res = await startBatchBuy(ctx, { orderIds });
      await runJobInline(batchBuyJob, { companyId, jobId: res.jobId });
      const job = await jobRow(res.jobId);
      const results = (job.input as { results: Record<string, { error: string }> }).results;
      return { job, results };
    };
    const a = await run([ready1, packedNoAddr, ready2]);
    expect(a.job.status).toBe("failed");
    expect(a.job.error).toBe(a.results[ready1]?.error);
    expect(a.results[ready1]?.error).toBe(a.results[ready2]?.error);
    expect(a.results[packedNoAddr]?.error).not.toBe(a.results[ready1]?.error);
    const b = await run([packedNoAddr, ready1]);
    expect(b.job.error).toBe(b.results[packedNoAddr]?.error);
    expect(b.results[ready1]?.error).not.toBe(b.job.error);
  });

  it("skipped plus failed with nothing labeled ends failed; all skipped ends done (B-482)", async () => {
    const [o1, o2] = await packedOrders(2);
    for (const o of [o1, o2]) {
      const q = await svc.rateOrder(ctx, { orderId: o as string });
      await svc.buyLabel(ctx, { shipmentId: q.shipmentId, rateId: q.rates[0]?.rateId as string });
    }
    const allSkipped = await startBatchBuy(ctx, { orderIds: [o1 as string, o2 as string] });
    await runJobInline(batchBuyJob, { companyId, jobId: allSkipped.jobId });
    expect(await jobRow(allSkipped.jobId)).toMatchObject({
      status: "done",
      error: null,
      message: "0 labeled, 0 failed, 2 skipped; postage $0.00",
    });

    const unpacked = (await createOrder(companyId, connectionId, { units: 1, state: "ready" }))
      .order.id;
    const mixed = await startBatchBuy(ctx, { orderIds: [o1 as string, unpacked] });
    await runJobInline(batchBuyJob, { companyId, jobId: mixed.jobId });
    const job = await jobRow(mixed.jobId);
    expect(job).toMatchObject({ status: "failed", resultIds: [] });
    expect(job.error).toBeTruthy();
    expect(job.message).toMatch(/^0 labeled, 1 failed, 1 skipped/);
  });

  it("after a crash mid-buy, the restarted run reads the carrier back and never buys twice", async () => {
    const orderIds = await packedOrders(3);
    const res = await startBatchBuy(ctx, { orderIds, strategy: "cheapest" });

    // What a worker killed during order 2's carrier call leaves behind: order 1 recorded,
    // order 2 claimed by this batch and `buying` (the carrier did sell it), order 3 untouched.
    const [first, second] = orderIds as [string, string, string];
    const q1 = await svc.rateOrder(ctx, { orderId: first });
    const s1 = await svc.buyLabel(ctx, {
      shipmentId: q1.shipmentId,
      rateId: q1.rates[0]?.rateId as string,
    });
    const q2 = await svc.rateOrder(ctx, { orderId: second });
    const rate2 = q2.rates[0]?.rateId as string;
    const carrierShipmentId = `shp_fake_${q2.shipmentId}`;
    fake.sold.set(carrierShipmentId, soldLabel(companyId, q2.shipmentId, carrierShipmentId));
    await withSystem((tx) =>
      tx
        .update(shipments)
        .set({
          status: "buying",
          selectedRateId: rate2,
          // Just inside the in-flight window: the job must wait it out, then read back.
          buyAttemptedAt: new Date(Date.now() - svc.BUY_IN_FLIGHT_MS + 1_500),
        })
        .where(eq(shipments.id, q2.shipmentId)),
    );
    const row = await jobRow(res.jobId);
    await withTenant(companyId, (tx) =>
      tx
        .update(jobs)
        .set({
          status: "running",
          input: {
            ...(row.input as object),
            results: {
              [first]: { shipmentId: s1.id, status: "labeled", error: null, postage: 512 },
              [second]: { shipmentId: q2.shipmentId, status: "buying", error: null, postage: 0 },
            },
          },
        })
        .where(eq(jobs.id, res.jobId)),
    );
    const buysBefore = fake.calls.buy; // 1: order 1, bought above

    await runJobInline(batchBuyJob, { companyId, jobId: res.jobId });
    expect(fake.calls.buy - buysBefore).toBe(1); // only order 3
    expect(fake.calls.lookup).toBeGreaterThanOrEqual(1); // order 2 was read back
    expect(await labelCount(orderIds)).toBe(3);
    const job = await jobRow(res.jobId);
    expect(job.status).toBe("done");
    expect(job.resultIds.sort()).toHaveLength(3);
    const [s2] = await withSystem((tx) =>
      tx.select().from(shipments).where(eq(shipments.id, q2.shipmentId)),
    );
    expect(s2?.status).toBe("labeled");
  }, 20_000);

  it("refuses to start when paid actions are blocked, before any job exists", async () => {
    const orderIds = await packedOrders(1);
    const other = (await createCompany()).id;
    const otherOwner = await createUser(other, "owner");
    const otherCtx = tenantContext(other, otherOwner.id, "owner");
    await withSystem((tx) =>
      tx.insert(subscriptions).values({
        companyId: other,
        planKey: "trial",
        status: "trialing",
        trialEndsAt: new Date(Date.now() - 60_000),
      }),
    );
    await expect(startBatchBuy(otherCtx, { orderIds })).rejects.toMatchObject({
      code: "PAYMENT_REQUIRED",
    });
    const rows = await withTenant(other, (tx) => tx.select().from(jobs));
    expect(rows).toHaveLength(0);
  });

  it("a failed run stores the error head, not the parameter values (B-343)", async () => {
    const [orderId] = await packedOrders(1);
    const res = await startBatchBuy(ctx, { orderIds: [orderId as string] });
    const value = "Maria Perez 4410 Mesquite Lane";
    vi.mocked(jobRows.updateJobRow).mockImplementationOnce(async () => {
      throw new Error(`Failed query: select 1\nparams: ${value}`);
    });
    await expect(
      runJobInline(batchBuyJob, { companyId, jobId: res.jobId }, { attempt: 3, attempts: 3 }),
    ).rejects.toThrow();
    const job = await jobRow(res.jobId);
    expect(job.status).toBe("failed");
    expect(job.error).toMatch(/^Failed query/);
    expect(job.error).not.toContain(value);
  });

  it("a per-order failure stores the error head in the job results (B-343)", async () => {
    const [orderId] = await packedOrders(1);
    const res = await startBatchBuy(ctx, { orderIds: [orderId as string] });
    const value = "Maria Perez 4410 Mesquite Lane";
    vi.mocked(carriersModule.carrierAdapter).mockImplementation(async () => {
      throw new Error(`Failed query: select 1\nparams: ${value}`);
    });
    await runJobInline(batchBuyJob, { companyId, jobId: res.jobId });
    const job = await jobRow(res.jobId);
    const results = (job.input as { results: Record<string, { status: string; error?: string }> })
      .results;
    expect(results[orderId as string]?.status).toBe("failed");
    expect(results[orderId as string]?.error).toMatch(/^Failed query/);
    expect(JSON.stringify(job.input)).not.toContain(value);
  });

  it("a carrier's own error text is never stored in the job results (B-353, B-354)", async () => {
    const [orderId] = await packedOrders(1);
    const res = await startBatchBuy(ctx, { orderIds: [orderId as string] });
    vi.mocked(carriersModule.carrierAdapter).mockImplementation(async () => {
      throw new CarrierError(
        "easypost",
        "upstream",
        "422: cannot deliver to Maria Perez, maria.perez@example.com, 4410 Mesquite Lane",
      );
    });
    await runJobInline(batchBuyJob, { companyId, jobId: res.jobId });
    const job = await jobRow(res.jobId);
    const results = (job.input as { results: Record<string, { status: string; error?: string }> })
      .results;
    expect(results[orderId as string]?.error).toBe(
      "An outside service could not complete the request (UPSTREAM_FAILED)",
    );
    expect(JSON.stringify(job.input)).not.toContain("Mesquite");
  });
});
