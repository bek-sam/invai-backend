import { ALERT_MESSAGE_PARAM_KEYS, TodaySummary } from "@invai/contracts";
import { call } from "@orpc/server";
import { and, eq, like, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { anonymousContext, permissionsFor } from "../../api/context";
import { router } from "../../api/router";
import { withSystem, withTenant } from "../../db/client";
import { alerts, orderItems, orders, shipments } from "../../db/schema";
import { queues, safeJobId } from "../../lib/queues";
import {
  createCompany,
  createConnection,
  createLocation,
  createOrder,
  createUser,
  tenantContext,
} from "../../test/fixtures";
import { pollTrackerJob } from "../shipping/jobs";
import { enqueueTrackerPolls, generateAlertsJob } from "./jobs";
import { DISPATCH_ALERT_CAP, DISPATCH_POLL_CAP, generateAlerts, summary } from "./service";

/*
 * T-41-2 (B-143), default path (no pickup cutoff): a label bought, the order's ship-by passed,
 * the carrier has not scanned. Time is relative to the real clock: ship-by 10 h ago, checks 1 h
 * ago (after ship-by) or 20 h ago (before it).
 */

const H = 3_600_000;
const ago = (h: number) => new Date(Date.now() - h * H);

async function shop() {
  const id = (await createCompany()).id;
  await createLocation(id);
  return id;
}

let companyId: string;
let ctx: ReturnType<typeof tenantContext>;
let etsy: string;

beforeAll(async () => {
  companyId = await shop();
  const office = await createUser(companyId, "office");
  ctx = tenantContext(companyId, office.id, "office");
  etsy = (await createConnection(companyId, "etsy")).id;
});

type Over = Partial<typeof shipments.$inferInsert>;

/** An order past its ship-by with one packed unit and one labeled shipment. */
async function labeledOrder(
  opts: { cid?: string; conn?: string; channel?: "etsy" | "shopify"; shipByAgoH?: number } = {},
  over: Over = {},
) {
  const cid = opts.cid ?? companyId;
  const { order, items } = await createOrder(cid, opts.conn ?? etsy, {
    units: 1,
    state: "packed",
    channel: opts.channel ?? "etsy",
  });
  const shipBy = ago(opts.shipByAgoH ?? 10);
  await withSystem(async (tx) => {
    await tx.update(orders).set({ shipBy }).where(eq(orders.id, order.id));
    await tx.update(orderItems).set({ shipBy }).where(eq(orderItems.orderId, order.id));
  });
  const [s] = await withSystem((tx) =>
    tx
      .insert(shipments)
      .values({
        companyId: cid,
        orderId: order.id,
        orderItemIds: items.map((i) => i.id),
        status: "labeled",
        carrier: "usps",
        trackingCode: `9400${Math.random().toString().slice(2, 18)}`,
        carrierShipmentId: `shp_${Math.random().toString(36).slice(2)}`,
        labeledAt: ago(30),
        ...over,
      })
      .returning(),
  );
  if (!s) throw new Error("shipment insert failed");
  return { order, items, shipment: s, shipBy };
}

const pass = (cid = companyId) =>
  withTenant(cid, (tx) => generateAlerts(tx, tenantContext(cid, null, "owner")));
const dispatchAlerts = (cid = companyId) =>
  withSystem((tx) =>
    tx
      .select()
      .from(alerts)
      .where(and(eq(alerts.companyId, cid), like(alerts.dedupeKey, "dispatch_scan_missing:%"))),
  );
const keyFor = (shipmentId: string) => `dispatch_scan_missing:${shipmentId}:overdue`;
const setShipment = (id: string, v: Over) =>
  withSystem((tx) => tx.update(shipments).set(v).where(eq(shipments.id, id)));
const alertOf = async (shipmentId: string) =>
  (await dispatchAlerts()).find((a) => a.dedupeKey === keyFor(shipmentId));
const dataOf = (a: { data: unknown } | undefined) =>
  (a?.data ?? {}) as { messageCode?: string; params?: Record<string, unknown> };

describe("dispatch guard: overdue rule", () => {
  it("a successful check after ship-by on a still-labeled shipment raises dispatch_overdue (critical)", async () => {
    const { shipment, order } = await labeledOrder({}, { trackerCheckedAt: ago(1) });
    const r = await pass();
    expect(r.toPoll.map((p) => p.shipmentId)).not.toContain(shipment.id);
    const a = await alertOf(shipment.id);
    expect(a).toMatchObject({
      kind: "order_overdue",
      severity: "critical",
      status: "open",
      entityType: "order",
      entityId: order.id,
    });
    expect(a?.title).toContain(order.orderNo);
    const d = dataOf(a);
    expect(d.messageCode).toBe("dispatch_overdue");
    expect(Object.keys(d.params ?? {}).sort()).toEqual(
      [...ALERT_MESSAGE_PARAM_KEYS.dispatch_overdue].sort(),
    );
    expect(d.params).toMatchObject({ orderNo: order.orderNo, channel: "etsy" });
    expect(JSON.stringify(a)).not.toContain(shipment.trackingCode as string);
    // coexistence: the "no label" overdue alert is never raised for an order that has a label
    const noLabel = await withSystem((tx) =>
      tx
        .select()
        .from(alerts)
        .where(eq(alerts.dedupeKey, `order_overdue:${order.id}`)),
    );
    expect(noLabel).toHaveLength(0);
  });

  it("a failed check after ship-by raises dispatch_overdue_unconfirmed; a later success reuses the same row", async () => {
    const { shipment } = await labeledOrder({}, { trackerCheckFailedAt: ago(2) });
    const first = await pass();
    expect(first.created).toBeGreaterThanOrEqual(1);
    const a1 = await alertOf(shipment.id);
    expect(dataOf(a1).messageCode).toBe("dispatch_overdue_unconfirmed");
    expect(a1?.severity).toBe("critical");

    await setShipment(shipment.id, { trackerCheckedAt: ago(1) });
    await pass();
    const rows = (await dispatchAlerts()).filter((a) => a.dedupeKey === keyFor(shipment.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(a1?.id);
    expect(dataOf(rows[0]).messageCode).toBe("dispatch_overdue");

    // and a newer failure flips it back, still one row
    await setShipment(shipment.id, { trackerCheckFailedAt: ago(0.5) });
    await pass();
    const again = (await dispatchAlerts()).filter((a) => a.dedupeKey === keyFor(shipment.id));
    expect(again).toHaveLength(1);
    expect(dataOf(again[0]).messageCode).toBe("dispatch_overdue_unconfirmed");
  });

  it("three passes leave one row and created is true only the first time", async () => {
    const { shipment } = await labeledOrder({}, { trackerCheckedAt: ago(1) });
    const p1 = await pass();
    const p2 = await pass();
    const p3 = await pass();
    expect(
      (await dispatchAlerts()).filter((a) => a.dedupeKey === keyFor(shipment.id)),
    ).toHaveLength(1);
    expect(p1.created).toBeGreaterThanOrEqual(1);
    expect(p2.created).toBe(0);
    expect(p3.created).toBe(0);
  });

  it("a check made before ship-by does not count: nothing raised, the shipment is handed back to poll", async () => {
    const { shipment } = await labeledOrder(
      {},
      { trackerCheckedAt: ago(20), trackerCheckFailedAt: ago(19) },
    );
    const r = await pass();
    expect(await alertOf(shipment.id)).toBeUndefined();
    expect(r.toPoll.find((p) => p.shipmentId === shipment.id)).toBeDefined();
  });

  it("before ship-by nothing is raised or polled, even for a label with no scan", async () => {
    const { shipment } = await labeledOrder({ shipByAgoH: -30 });
    const r = await pass();
    expect(await alertOf(shipment.id)).toBeUndefined();
    expect(r.toPoll.map((p) => p.shipmentId)).not.toContain(shipment.id);
  });

  it("never raises a pickup warning (default path has no cutoff)", async () => {
    await labeledOrder({}, { trackerCheckedAt: ago(1) });
    await pass();
    const warn = (await dispatchAlerts()).filter((a) => a.dedupeKey.endsWith(":warn"));
    expect(warn).toHaveLength(0);
    expect(
      (await dispatchAlerts()).some((a) => dataOf(a).messageCode === "dispatch_pickup_missed"),
    ).toBe(false);
  });
});

describe("dispatch guard: resolution and exclusions", () => {
  async function open() {
    const x = await labeledOrder({}, { trackerCheckedAt: ago(1) });
    await pass();
    expect((await alertOf(x.shipment.id))?.status).toBe("open");
    return x;
  }

  it("a carrier scan (in_transit) resolves the alert", async () => {
    const { shipment } = await open();
    await setShipment(shipment.id, { status: "in_transit" });
    await pass();
    expect((await alertOf(shipment.id))?.status).toBe("resolved");
  });

  it("a voided label resolves it, and a re-bought label tracks only the new shipment", async () => {
    const { shipment, order, items } = await open();
    await setShipment(shipment.id, { status: "voided" });
    const [fresh] = await withSystem((tx) =>
      tx
        .insert(shipments)
        .values({
          companyId,
          orderId: order.id,
          orderItemIds: items.map((i) => i.id),
          status: "labeled",
          carrier: "usps",
          trackingCode: `9400${Math.random().toString().slice(2, 18)}`,
          carrierShipmentId: `shp_${Math.random().toString(36).slice(2)}`,
          labeledAt: ago(1),
          trackerCheckedAt: ago(0.5),
        })
        .returning(),
    );
    await pass();
    expect((await alertOf(shipment.id))?.status).toBe("resolved");
    expect((await alertOf(fresh?.id as string))?.status).toBe("open");
  });

  it("a cancelled order resolves it and raises nothing", async () => {
    const { order, shipment } = await open();
    await withSystem((tx) =>
      tx.update(orders).set({ status: "cancelled" }).where(eq(orders.id, order.id)),
    );
    await pass();
    expect((await alertOf(shipment.id))?.status).toBe("resolved");
    const other = await labeledOrder({}, { trackerCheckedAt: ago(1) });
    await withSystem((tx) =>
      tx.update(orders).set({ status: "cancelled" }).where(eq(orders.id, other.order.id)),
    );
    await pass();
    expect(await alertOf(other.shipment.id)).toBeUndefined();
  });

  it("a unit on hold resolves it; releasing the hold brings it back", async () => {
    const { items, shipment } = await open();
    const itemId = items[0]?.id as string;
    await withSystem((tx) =>
      tx.update(orderItems).set({ state: "on_hold" }).where(eq(orderItems.id, itemId)),
    );
    await pass();
    expect((await alertOf(shipment.id))?.status).toBe("resolved");
    await withSystem((tx) =>
      tx.update(orderItems).set({ state: "packed" }).where(eq(orderItems.id, itemId)),
    );
    await pass();
    expect((await alertOf(shipment.id))?.status).toBe("open");
  });

  it("multi-shipment order: only the unscanned shipment alerts", async () => {
    const a = await labeledOrder({}, { trackerCheckedAt: ago(1) });
    const [second] = await withSystem((tx) =>
      tx
        .insert(shipments)
        .values({
          companyId,
          orderId: a.order.id,
          orderItemIds: [],
          status: "in_transit",
          carrier: "usps",
          trackingCode: `9400${Math.random().toString().slice(2, 18)}`,
          trackerCheckedAt: ago(1),
        })
        .returning(),
    );
    await pass();
    expect((await alertOf(a.shipment.id))?.status).toBe("open");
    expect(await alertOf(second?.id as string)).toBeUndefined();
  });
});

describe("dispatch guard: tracker polls handed back", () => {
  it("caps toPoll at 50 per pass, oldest ship-by first, and stops listing a shipment once a check exists", async () => {
    const cid = await shop();
    const conn = (await createConnection(cid, "etsy")).id;
    const made: string[] = [];
    for (let i = 0; i < DISPATCH_POLL_CAP + 5; i++) {
      const x = await labeledOrder({ cid, conn, shipByAgoH: 100 - i * 0.5 });
      made.push(x.shipment.id);
    }
    const r1 = await pass(cid);
    expect(r1.toPoll).toHaveLength(DISPATCH_POLL_CAP);
    expect(r1.toPoll.map((p) => p.shipmentId)).toEqual(made.slice(0, DISPATCH_POLL_CAP));
    expect(await dispatchAlerts(cid)).toHaveLength(0);
    // the first 50 get a check: the rest follow on the next pass
    await withSystem((tx) =>
      tx
        .update(shipments)
        .set({ trackerCheckedAt: ago(0.1) })
        .where(
          sql`id in (${sql.join(
            made.slice(0, DISPATCH_POLL_CAP).map((id) => sql`${id}::uuid`),
            sql`, `,
          )})`,
        ),
    );
    const r2 = await pass(cid);
    expect(r2.toPoll.map((p) => p.shipmentId)).toEqual(made.slice(DISPATCH_POLL_CAP));
    expect((await dispatchAlerts(cid)).length).toBe(DISPATCH_POLL_CAP);
  });

  it("enqueueTrackerPolls adds one low-priority job per shipment with the agreed jobId, once", async () => {
    const calls: { input: unknown; opts: { jobId?: string; priority?: number } | undefined }[] = [];
    const spy = vi.spyOn(pollTrackerJob, "enqueue").mockImplementation(async (input, opts) => {
      calls.push({ input, opts });
      return {} as never;
    });
    const sid = crypto.randomUUID();
    const shipBy = new Date().toISOString();
    expect(await enqueueTrackerPolls(companyId, [{ shipmentId: sid, shipBy }])).toBe(1);
    expect(calls[0]).toEqual({
      input: { companyId, shipmentId: sid },
      opts: { jobId: `poll-tracker-${sid}-${shipBy}`, priority: 10 },
    });
    spy.mockRestore();
    // the real id passes through safeJobId (no colons), so BullMQ accepts the ISO time
    expect(safeJobId(`poll-tracker-${sid}-${shipBy}`)).not.toContain(":");
  });

  it("the sweep job hands the pass's list to the poll job after the transaction", async () => {
    const cid = await shop();
    const conn = (await createConnection(cid, "etsy")).id;
    const x = await labeledOrder({ cid, conn });
    const spy = vi.spyOn(pollTrackerJob, "enqueue").mockResolvedValue({} as never);
    const out = (await generateAlertsJob.handler({ companyId: cid, bucket: 1 }, {} as never)) as {
      polled: number;
    };
    expect(out.polled).toBe(1);
    expect(spy.mock.calls[0]?.[0]).toEqual({ companyId: cid, shipmentId: x.shipment.id });
    // run twice: still only DB-state-driven, nothing raised without a check
    await generateAlertsJob.handler({ companyId: cid, bucket: 2 }, {} as never);
    expect(await dispatchAlerts(cid)).toHaveLength(0);
    spy.mockRestore();
    await queues.ship.drain().catch(() => undefined);
  });
});

describe("today.summary dispatch counts", () => {
  it("per-channel dispatchAtRisk (rows > 0 only) and dispatchUnconfirmed equals the open unconfirmed alerts", async () => {
    const cid = await shop();
    const e = (await createConnection(cid, "etsy")).id;
    const s = (await createConnection(cid, "shopify")).id;
    for (let i = 0; i < 3; i++) await labeledOrder({ cid, conn: e }, { trackerCheckedAt: ago(1) });
    for (let i = 0; i < 2; i++)
      await labeledOrder({ cid, conn: e }, { trackerCheckFailedAt: ago(1) });
    await labeledOrder({ cid, conn: s, channel: "shopify" }, { trackerCheckFailedAt: ago(1) });
    // not counted: scanned, voided, future ship-by
    await labeledOrder({ cid, conn: e }, { status: "in_transit" });
    await labeledOrder({ cid, conn: e }, { status: "voided" });
    await labeledOrder({ cid, conn: e, shipByAgoH: -20 });
    await pass(cid);
    const out = await withTenant(cid, (tx) => summary(tx, tenantContext(cid, null, "office"), {}));
    expect(TodaySummary.parse(out)).toBeTruthy();
    expect(out.orders.dispatchAtRisk).toEqual([
      { channel: "etsy", count: 5 },
      { channel: "shopify", count: 1 },
    ]);
    expect(out.orders.dispatchUnconfirmed).toBe(3);
    // a scan lands: both drop
    const [one] = await withSystem((tx) =>
      tx
        .select()
        .from(shipments)
        .where(and(eq(shipments.companyId, cid), eq(shipments.status, "labeled")))
        .limit(1),
    );
    await setShipment(one?.id as string, { status: "in_transit" });
    await pass(cid);
    const after = await withTenant(cid, (tx) =>
      summary(tx, tenantContext(cid, null, "office"), {}),
    );
    expect(after.orders.dispatchAtRisk?.reduce((n, r) => n + r.count, 0)).toBe(5);
  });

  it("a second company's shipments never appear", async () => {
    const other = await shop();
    const oc = (await createConnection(other, "etsy")).id;
    await labeledOrder({ cid: other, conn: oc }, { trackerCheckedAt: ago(1) });
    const cid = await shop();
    const out = await withTenant(cid, (tx) => summary(tx, tenantContext(cid, null, "office"), {}));
    expect(out.orders.dispatchAtRisk).toEqual([]);
    expect(out.orders.dispatchUnconfirmed).toBe(0);
    await pass(other);
    expect(await dispatchAlerts(cid)).toHaveLength(0);
  });

  it("through the router: office gets the counts, vendor is FORBIDDEN", async () => {
    const mk = (role: "office" | "vendor", id: string) => ({
      ...anonymousContext(new Headers(), null),
      sessionKind: "user" as const,
      user: { id, name: role, email: `${role}@t.local` },
      companyId,
      orgType: "shop" as const,
      role,
      permissions: permissionsFor(role),
    });
    const o = await call(router.today.summary, {}, { context: mk("office", ctx.userId as string) });
    expect(Array.isArray(o.orders.dispatchAtRisk)).toBe(true);
    expect(typeof o.orders.dispatchUnconfirmed).toBe("number");
    await expect(
      call(router.today.summary, {}, { context: mk("vendor", crypto.randomUUID()) }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("a 1,000-label day (spec 15)", () => {
  it("counts exactly 300, raises at most 200 alerts, second pass creates 0", async () => {
    const cid = await shop();
    const conn = (await createConnection(cid, "etsy")).id;
    const total = 1000;
    const late = 300;
    const rows = Array.from({ length: total }, (_, i) => ({
      companyId: cid,
      connectionId: conn,
      channel: "etsy" as const,
      channelOrderId: `perf-${i}`,
      orderNo: `P-${i}`,
      placedAt: new Date(),
      // 300 past ship-by (oldest first by index), 700 still ahead
      shipBy: i < late ? ago(500 - i) : new Date(Date.now() + 2 * 86400_000),
      itemCount: 1,
      subtotalCents: 2500,
      totalCents: 2500,
    }));
    const ords = await withSystem(async (tx) => {
      const out: { id: string }[] = [];
      for (let i = 0; i < rows.length; i += 250)
        out.push(
          ...(await tx
            .insert(orders)
            .values(rows.slice(i, i + 250))
            .returning({ id: orders.id })),
        );
      return out;
    });
    // Baseline: the same 1,000 orders with no shipments yet (the pass as it ran before this card).
    const b0 = performance.now();
    await pass(cid);
    const baseMs = performance.now() - b0;
    await withSystem(async (tx) => {
      for (let i = 0; i < ords.length; i += 250)
        await tx.insert(shipments).values(
          ords.slice(i, i + 250).map((o, j) => ({
            companyId: cid,
            orderId: o.id,
            status: "labeled" as const,
            labeledAt: ago(30),
            // the 300 late ones have a successful check after ship-by
            trackerCheckedAt: i + j < late ? ago(0.1) : null,
          })),
        );
    });
    const t0 = performance.now();
    const p1 = await pass(cid);
    const ms = performance.now() - t0;
    const out = await withTenant(cid, (tx) => summary(tx, tenantContext(cid, null, "office"), {}));
    expect(out.orders.dispatchAtRisk).toEqual([{ channel: "etsy", count: late }]);
    // 1,000 orders also trips the plan-limit alert; the dispatch alerts are exactly the cap
    expect(p1.created).toBeLessThanOrEqual(DISPATCH_ALERT_CAP + 1);
    expect((await dispatchAlerts(cid)).length).toBe(DISPATCH_ALERT_CAP);
    const p2 = await pass(cid);
    expect(p2.created).toBe(0);
    console.info(
      `[T-41-2] pass over 1,000 orders: baseline ${Math.round(baseMs)} ms, with 1,000 labeled shipments (300 late) ${Math.round(ms)} ms`,
    );
    expect(ms).toBeLessThan(Math.max(baseMs * 5, 2000));
  }, 60_000);
});
