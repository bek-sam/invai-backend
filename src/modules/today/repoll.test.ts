import { and, eq, like } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystem, withTenant } from "../../db/client";
import { alerts, orders, shipments } from "../../db/schema";
import type { TrackerUpdate, TrackingAdapter } from "../../integrations/carriers";
import * as carriersModule from "../../integrations/carriers";
import * as ratelimit from "../../integrations/suppliers/ratelimit";
import { runJobInline } from "../../lib/queues";
import {
  createCompany,
  createConnection,
  createLocation,
  tenantContext,
} from "../../test/fixtures";
import { pollTrackerJob, TRACKER_POLL_AFTER_MS } from "../shipping/jobs";
import { alertsSweepJob, enqueueTrackerPolls, generateAlertsJob } from "./jobs";
import {
  DISPATCH_POLL_CAP,
  DISPATCH_REPOLL_AFTER_MS,
  DISPATCH_REPOLL_CAP,
  DISPATCH_REPOLL_MAX_AGE_MS,
  generateAlerts,
} from "./service";

/*
 * T-47-1 (B-389): the dispatch guard polls an alerted label again once its latest tracker check
 * is old, bounded per pass (50 total, first checks first, at most 10 re-polls), oldest ship-by
 * first. Time is relative to the real clock (the SQL uses now()).
 */

vi.mock("../../integrations/carriers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../integrations/carriers")>();
  return { ...actual, carrierTracking: vi.fn(actual.carrierTracking) };
});
vi.mock("../../integrations/suppliers/ratelimit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../integrations/suppliers/ratelimit")>();
  return { ...actual, takeToken: vi.fn(actual.takeToken) };
});

const H = 3_600_000;
const ago = (h: number) => new Date(Date.now() - h * H);

async function shop() {
  const id = (await createCompany()).id;
  await createLocation(id);
  return id;
}

type Spec = {
  /** hours ago the order's ship-by passed */
  shipByAgoH: number;
  /** hours ago of the latest check; null = never checked */
  checkAgoH: number | null;
  failed?: boolean;
  status?: "labeled" | "in_transit" | "voided";
  noCarrierId?: boolean;
  noTracking?: boolean;
  /** pin the shipment id (tie order) */
  id?: string;
};

/** Orders + labeled shipments in bulk; returns shipment ids in input order. */
async function bulk(cid: string, conn: string, specs: Spec[]) {
  const tag = crypto.randomUUID().slice(0, 8);
  const ids: string[] = [];
  await withSystem(async (tx) => {
    for (let i = 0; i < specs.length; i += 250) {
      const chunk = specs.slice(i, i + 250);
      const ords = await tx
        .insert(orders)
        .values(
          chunk.map((c, j) => ({
            companyId: cid,
            connectionId: conn,
            channel: "etsy" as const,
            channelOrderId: `rp-${tag}-${i + j}`,
            orderNo: `RP-${tag}-${i + j}`,
            placedAt: new Date(),
            shipBy: ago(c.shipByAgoH),
            itemCount: 1,
            subtotalCents: 2500,
            totalCents: 2500,
          })),
        )
        .returning({ id: orders.id });
      const rows = await tx
        .insert(shipments)
        .values(
          chunk.map((c, j) => ({
            ...(c.id ? { id: c.id } : {}),
            companyId: cid,
            orderId: ords[j]?.id as string,
            status: c.status ?? ("labeled" as const),
            carrier: "usps" as const,
            trackingCode: c.noTracking ? null : `9400${Math.random().toString().slice(2, 18)}`,
            carrierShipmentId: c.noCarrierId ? null : `shp_${Math.random().toString(36).slice(2)}`,
            labeledAt: ago(1), // keeps these out of the daily 3-day fallback sweep (500 oldest, all shops)
            trackerCheckedAt: c.checkAgoH !== null && !c.failed ? ago(c.checkAgoH) : null,
            trackerCheckFailedAt: c.checkAgoH !== null && c.failed ? ago(c.checkAgoH) : null,
          })),
        )
        .returning({ id: shipments.id });
      ids.push(...rows.map((r) => r.id));
    }
  });
  return ids;
}

const pass = (cid: string) =>
  withTenant(cid, (tx) => generateAlerts(tx, tenantContext(cid, null, "owner")));
const dispatchAlerts = (cid: string) =>
  withSystem((tx) =>
    tx
      .select()
      .from(alerts)
      .where(and(eq(alerts.companyId, cid), like(alerts.dedupeKey, "dispatch_scan_missing:%"))),
  );
const setShipment = (id: string, v: Partial<typeof shipments.$inferInsert>) =>
  withSystem((tx) => tx.update(shipments).set(v).where(eq(shipments.id, id)));
const checkIso = async (id: string) => {
  const [r] = await withSystem((tx) => tx.select().from(shipments).where(eq(shipments.id, id)));
  const t = [r?.trackerCheckedAt, r?.trackerCheckFailedAt].filter(Boolean) as Date[];
  return new Date(Math.max(...t.map((d) => d.getTime()))).toISOString();
};

let enqueued: {
  input: { companyId: string; shipmentId: string };
  jobId?: string;
  priority?: number;
}[];
beforeEach(() => {
  enqueued = [];
  vi.spyOn(pollTrackerJob, "enqueue").mockImplementation(async (input, opts) => {
    enqueued.push({ input, jobId: opts?.jobId, priority: opts?.priority });
    return {} as never;
  });
  vi.mocked(ratelimit.takeToken).mockReset();
  vi.mocked(ratelimit.takeToken).mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("re-poll constants", () => {
  it("the age limit equals the fallback sweep's, the interval is 6 h, caps are 50 / 10", () => {
    expect(DISPATCH_REPOLL_MAX_AGE_MS).toBe(TRACKER_POLL_AFTER_MS);
    expect(DISPATCH_REPOLL_AFTER_MS).toBe(6 * H);
    expect([DISPATCH_POLL_CAP, DISPATCH_REPOLL_CAP]).toEqual([50, 10]);
  });
});

describe("re-poll selection (AC1)", () => {
  it("a stale ok check and a stale failed check are handed back; a fresh one, an old order, a missing carrier id or tracking code are not", async () => {
    const c = await shop();
    const k = (await createConnection(c, "etsy")).id;
    const [stale, staleFailed, fresh, tooOld, noCarrier, noCode, scanned, voided] = await bulk(
      c,
      k,
      [
        { shipByAgoH: 30, checkAgoH: 7 },
        { shipByAgoH: 31, checkAgoH: 7, failed: true },
        { shipByAgoH: 32, checkAgoH: 5 },
        { shipByAgoH: 24 * 3 + 5, checkAgoH: 7 },
        { shipByAgoH: 33, checkAgoH: 7, noCarrierId: true },
        { shipByAgoH: 34, checkAgoH: 7, noTracking: true },
        { shipByAgoH: 35, checkAgoH: 7, status: "in_transit" },
        { shipByAgoH: 36, checkAgoH: 7, status: "voided" },
      ],
    );
    const r = await pass(c);
    const got = r.toPoll.map((p) => p.shipmentId);
    expect(got).toEqual([staleFailed, stale]);
    expect(got).not.toContain(fresh);
    expect(got).not.toContain(tooOld);
    expect(got).not.toContain(noCarrier);
    expect(got).not.toContain(noCode);
    expect(got).not.toContain(scanned);
    expect(got).not.toContain(voided);
    // both are alerted (the check is after ship-by) and still re-polled
    expect((await dispatchAlerts(c)).length).toBeGreaterThanOrEqual(2);
  });

  it("a shipment leaves the re-poll set once it is scanned or its order is cancelled", async () => {
    const c = await shop();
    const k = (await createConnection(c, "etsy")).id;
    const [a, b] = await bulk(c, k, [
      { shipByAgoH: 30, checkAgoH: 7 },
      { shipByAgoH: 31, checkAgoH: 7 },
    ]);
    expect((await pass(c)).toPoll.map((p) => p.shipmentId)).toEqual([b, a]);
    await setShipment(a as string, { status: "in_transit" });
    const [sb] = await withSystem((tx) =>
      tx
        .select({ o: shipments.orderId })
        .from(shipments)
        .where(eq(shipments.id, b as string)),
    );
    await withSystem((tx) =>
      tx
        .update(orders)
        .set({ status: "cancelled" })
        .where(eq(orders.id, sb?.o as string)),
    );
    expect((await pass(c)).toPoll).toEqual([]);
  });
});

describe("re-poll job ids (AC1)", () => {
  it("a re-poll's id carries its check time, a first check's id is unchanged; each new check gives a new id", async () => {
    const c = await shop();
    const k = (await createConnection(c, "etsy")).id;
    const [re, first] = await bulk(c, k, [
      { shipByAgoH: 30, checkAgoH: 7 },
      { shipByAgoH: 20, checkAgoH: null },
    ]);
    const r = await pass(c);
    await enqueueTrackerPolls(c, r.toPoll);
    const iso = await checkIso(re as string);
    const shipBy = r.toPoll.find((p) => p.shipmentId === first)?.shipBy;
    expect(enqueued.map((e) => e.jobId)).toEqual([
      `poll-tracker-${first}-${shipBy}`,
      `poll-tracker-${re}-recheck-${iso}`,
    ]);
    expect(enqueued.every((e) => e.priority === 10)).toBe(true);
    // 7 h later a new failed check: due again, with a different id
    await setShipment(re as string, { trackerCheckFailedAt: ago(6.5), trackerCheckedAt: ago(8) });
    const r2 = await pass(c);
    enqueued = [];
    await enqueueTrackerPolls(
      c,
      r2.toPoll.filter((p) => p.shipmentId === re),
    );
    const iso2 = await checkIso(re as string);
    expect(iso2).not.toBe(iso);
    expect(enqueued.map((e) => e.jobId)).toEqual([`poll-tracker-${re}-recheck-${iso2}`]);
  });

  it("the interval is enforced: a check 5 h old is not re-polled, 7 h old is, on every pass until a new check", async () => {
    const c = await shop();
    const k = (await createConnection(c, "etsy")).id;
    const [x] = await bulk(c, k, [{ shipByAgoH: 30, checkAgoH: 5 }]);
    expect((await pass(c)).toPoll).toEqual([]);
    await setShipment(x as string, { trackerCheckedAt: ago(7) });
    expect((await pass(c)).toPoll).toHaveLength(1);
    await setShipment(x as string, { trackerCheckedAt: ago(0.1) });
    expect((await pass(c)).toPoll).toEqual([]);
  });
});

describe("caps and order (AC2, AC4)", () => {
  it("only re-polls due: exactly 10, oldest ship-by first, ties by shipment id", async () => {
    const c = await shop();
    const k = (await createConnection(c, "etsy")).id;
    const specs: Spec[] = [];
    for (let i = 0; i < 15; i++) specs.push({ shipByAgoH: 70 - i * 0.5, checkAgoH: 7 });
    const ids = await bulk(c, k, specs);
    const r = await pass(c);
    expect(r.toPoll.map((p) => p.shipmentId)).toEqual(ids.slice(0, DISPATCH_REPOLL_CAP));
  });

  it("ties on ship-by break by shipment id (ascending)", async () => {
    const c = await shop();
    const k = (await createConnection(c, "etsy")).id;
    const uuids = [
      "30000000-0000-4000-8000-000000000003",
      "10000000-0000-4000-8000-000000000001",
      "20000000-0000-4000-8000-000000000002",
    ];
    await bulk(
      c,
      k,
      uuids.map((id) => ({ id, shipByAgoH: 40, checkAgoH: 7 })),
    );
    const fixed = new Date(Date.now() - 40 * H);
    await withSystem((tx) =>
      tx.update(orders).set({ shipBy: fixed }).where(eq(orders.companyId, c)),
    );
    expect((await pass(c)).toPoll.map((p) => p.shipmentId)).toEqual([...uuids].sort());
  });

  it("60 first checks + 60 re-polls: 50 first checks, 0 re-polls; 45 + 60: 45 + 5; oldest ship-by first in each group", async () => {
    for (const [firsts, want] of [
      [60, { first: 50, re: 0 }],
      [45, { first: 45, re: 5 }],
    ] as const) {
      const c = await shop();
      const k = (await createConnection(c, "etsy")).id;
      const specs: Spec[] = [];
      for (let i = 0; i < firsts; i++) specs.push({ shipByAgoH: 200 - i * 0.5, checkAgoH: null });
      for (let i = 0; i < 60; i++) specs.push({ shipByAgoH: 70 - i * 0.5, checkAgoH: 7 });
      const ids = await bulk(c, k, specs);
      const r = await pass(c);
      const firstIds = ids.slice(0, firsts);
      const reIds = ids.slice(firsts);
      expect(r.toPoll).toHaveLength(want.first + want.re);
      expect(r.toPoll.slice(0, want.first).map((p) => p.shipmentId)).toEqual(
        firstIds.slice(0, want.first),
      );
      expect(r.toPoll.slice(want.first).map((p) => p.shipmentId)).toEqual(reIds.slice(0, want.re));
      expect(r.toPoll.slice(0, want.first).every((p) => p.checkedAt === null)).toBe(true);
      expect(r.toPoll.slice(want.first).every((p) => p.checkedAt !== null)).toBe(true);
    }
  });

  it("alerts: more than 200 candidates raise the 200 with the oldest ship-by", async () => {
    const c = await shop();
    const k = (await createConnection(c, "etsy")).id;
    const n = 205;
    const specs: Spec[] = [];
    // listed newest first so a reversed ORDER BY cannot pass by luck of insertion order
    for (let i = 0; i < n; i++) specs.push({ shipByAgoH: 100 + i * 0.1, checkAgoH: 1 });
    const ids = await bulk(c, k, specs);
    await pass(c);
    const raised = new Set((await dispatchAlerts(c)).map((a) => a.dedupeKey));
    expect(raised.size).toBe(200);
    // the 200 oldest ship-by are the last 200 inserted
    for (const id of ids.slice(5))
      expect(raised.has(`dispatch_scan_missing:${id}:overdue`)).toBe(true);
    for (const id of ids.slice(0, 5))
      expect(raised.has(`dispatch_scan_missing:${id}:overdue`)).toBe(false);
  }, 60_000);
});

describe("many shops in one sweep (AC5)", () => {
  it("three busy shops are each capped, the quiet shop's one re-poll is still enqueued", async () => {
    const busy: string[] = [];
    for (let s = 0; s < 3; s++) {
      const c = await shop();
      const k = (await createConnection(c, "etsy")).id;
      const specs: Spec[] = [];
      for (let i = 0; i < 60; i++) specs.push({ shipByAgoH: 70 - i * 0.5, checkAgoH: 7 });
      await bulk(c, k, specs);
      busy.push(c);
    }
    const quiet = await shop();
    const qk = (await createConnection(quiet, "etsy")).id;
    const [qid] = await bulk(quiet, qk, [{ shipByAgoH: 30, checkAgoH: 7 }]);
    const mine = new Set([...busy, quiet]);
    const fanned: { companyId: string; bucket: number }[] = [];
    vi.spyOn(generateAlertsJob, "enqueue").mockImplementation(async (input) => {
      if (mine.has(input.companyId)) fanned.push(input);
      return {} as never;
    });
    await alertsSweepJob.handler({}, {} as never);
    expect(fanned.map((f) => f.companyId).sort()).toEqual([...mine].sort());
    for (const f of fanned) await generateAlertsJob.handler(f, {} as never);
    for (const c of busy) {
      const got = enqueued.filter((e) => e.input.companyId === c);
      expect(got).toHaveLength(DISPATCH_REPOLL_CAP);
      expect(got.every((e) => e.jobId?.includes("-recheck-") && e.priority === 10)).toBe(true);
    }
    const q = enqueued.filter((e) => e.input.companyId === quiet);
    expect(q.map((e) => e.input.shipmentId)).toEqual([qid]);
    expect(q[0]?.jobId).toContain(`poll-tracker-${qid}-recheck-`);
  }, 60_000);
});

describe("a re-poll clears the alert end to end (AC3)", () => {
  it("alert open -> re-poll finds the scan -> next pass resolves the alert", async () => {
    const c = await shop();
    const k = (await createConnection(c, "etsy")).id;
    const [sid] = await bulk(c, k, [{ shipByAgoH: 20, checkAgoH: 7 }]);
    const [row] = await withSystem((tx) =>
      tx
        .select()
        .from(shipments)
        .where(eq(shipments.id, sid as string)),
    );
    const adapter: TrackingAdapter = {
      provider: "mock",
      async track(input) {
        return {
          trackerId: "trk",
          trackingCode: input.trackingCode,
          carrierShipmentId: input.carrierShipmentId,
          status: "in_transit",
          statusDetail: null,
          occurredAt: new Date(),
          deliveredAt: null,
        } satisfies TrackerUpdate;
      },
    };
    vi.mocked(carriersModule.carrierTracking).mockImplementation(async () => adapter);

    await runJobInline(generateAlertsJob, { companyId: c, bucket: 1 });
    const alert = (await dispatchAlerts(c))[0];
    expect(alert?.status).toBe("open");
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.jobId).toContain("-recheck-");
    expect(enqueued[0]?.input).toEqual({ companyId: c, shipmentId: sid });

    await runJobInline(pollTrackerJob, enqueued[0]?.input as never);
    const [after] = await withSystem((tx) =>
      tx
        .select()
        .from(shipments)
        .where(eq(shipments.id, sid as string)),
    );
    expect(after?.status).toBe("in_transit");
    expect(row?.status).toBe("labeled");

    enqueued = [];
    await runJobInline(generateAlertsJob, { companyId: c, bucket: 2 });
    expect(enqueued).toEqual([]);
    const [resolved] = await withSystem((tx) =>
      tx
        .select()
        .from(alerts)
        .where(eq(alerts.id, alert?.id as string)),
    );
    expect(resolved?.status).toBe("resolved");
  });
});
