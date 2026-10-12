import { and, eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystem, withTenant } from "../../db/client";
import { alerts, orderItems, orders, shipments } from "../../db/schema";
import type { TrackerUpdate, TrackingAdapter } from "../../integrations/carriers";
import * as carriersModule from "../../integrations/carriers";
import * as ratelimit from "../../integrations/suppliers/ratelimit";
import { runJobInline } from "../../lib/queues";
import {
  createCompany,
  createConnection,
  createLocation,
  createOrder,
  tenantContext,
} from "../../test/fixtures";
import { generateAlerts } from "../today/service";
import { pollTrackerJob, processCarrierEvent } from "./jobs";

/*
 * T-41-2 (B-143) A3: what counts as a tracker check on a labeled shipment. A successful reading
 * (poll, routed carrier event) sets trackerCheckedAt; a poll that could not run or got nothing
 * back sets trackerCheckFailedAt; our own throttle timing out writes nothing on earlier attempts.
 */

vi.mock("../../integrations/carriers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../integrations/carriers")>();
  return { ...actual, carrierTracking: vi.fn(actual.carrierTracking) };
});
vi.mock("../../integrations/suppliers/ratelimit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../integrations/suppliers/ratelimit")>();
  return { ...actual, takeToken: vi.fn(actual.takeToken) };
});

let companyId: string;
let conn: string;

beforeAll(async () => {
  companyId = (await createCompany()).id;
  await createLocation(companyId);
  conn = (await createConnection(companyId, "etsy")).id;
});

type Behaviour = "ok" | "pre_transit" | "null" | "throw" | "other_code";
let tracks = 0;
function useTracking(b: Behaviour, provider: "mock" | "easypost" = "mock") {
  tracks = 0;
  const adapter: TrackingAdapter = {
    provider,
    async track(input) {
      tracks += 1;
      if (b === "throw") throw new Error("carrier down");
      if (b === "null") return null;
      const update: TrackerUpdate = {
        trackerId: "trk",
        trackingCode: b === "other_code" ? "OTHER" : input.trackingCode,
        carrierShipmentId: input.carrierShipmentId,
        status: b === "ok" ? "in_transit" : "pre_transit",
        statusDetail: null,
        occurredAt: new Date(),
        deliveredAt: null,
      };
      return update;
    },
  };
  vi.mocked(carriersModule.carrierTracking).mockImplementation(async () => adapter);
}

beforeEach(() => {
  vi.mocked(ratelimit.takeToken).mockReset();
  vi.mocked(ratelimit.takeToken).mockResolvedValue(undefined);
});

async function labeled(over: Partial<typeof shipments.$inferInsert> = {}) {
  const { order, items } = await createOrder(companyId, conn, { units: 1, state: "packed" });
  const [s] = await withSystem((tx) =>
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
        labeledAt: new Date(),
        ...over,
      })
      .returning(),
  );
  if (!s) throw new Error("insert failed");
  return s;
}
const row = async (id: string) =>
  (await withSystem((tx) => tx.select().from(shipments).where(eq(shipments.id, id))))[0];
const poll = (shipmentId: string) => runJobInline(pollTrackerJob, { companyId, shipmentId });
const pollAttempt = (shipmentId: string, attempt: number) =>
  runJobInline(pollTrackerJob, { companyId, shipmentId }, { attempt, attempts: 3 });

describe("pollTrackerJob writes the check", () => {
  it("a pre-transit reading is a success: trackerCheckedAt set, still labeled; run twice, still one state", async () => {
    const s = await labeled();
    useTracking("pre_transit");
    await poll(s.id);
    const r1 = await row(s.id);
    expect(r1?.status).toBe("labeled");
    expect(r1?.trackerCheckedAt).toBeInstanceOf(Date);
    expect(r1?.trackerCheckFailedAt).toBeNull();
    await poll(s.id);
    const r2 = await row(s.id);
    expect(r2?.status).toBe("labeled");
    expect(r2?.trackerCheckedAt?.getTime()).toBeGreaterThanOrEqual(
      r1?.trackerCheckedAt?.getTime() ?? 0,
    );
  });

  it("a scan reading moves it in_transit and also records the check", async () => {
    const s = await labeled();
    useTracking("ok");
    await poll(s.id);
    const r = await row(s.id);
    expect(r?.status).toBe("in_transit");
    expect(r?.trackerCheckedAt).toBeInstanceOf(Date);
  });

  it.each([
    ["no carrier shipment id", { carrierShipmentId: null }, "ok" as const],
    ["no tracking code", { trackingCode: null }, "ok" as const],
    ["the adapter returns nothing", {}, "null" as const],
    ["the tracking code differs", {}, "other_code" as const],
  ])("a skipped poll (%s) records a failed check", async (_n, over, b) => {
    const s = await labeled(over);
    useTracking(b);
    const out = await poll(s.id);
    expect(out).toEqual({ skipped: true });
    const r = await row(s.id);
    expect(r?.trackerCheckFailedAt).toBeInstanceOf(Date);
    expect(r?.trackerCheckedAt).toBeNull();
    expect(r?.status).toBe("labeled");
  });

  it("an adapter throw records a failed check and rethrows", async () => {
    const s = await labeled();
    useTracking("throw");
    await expect(poll(s.id)).rejects.toThrow("carrier down");
    const r = await row(s.id);
    expect(r?.trackerCheckFailedAt).toBeInstanceOf(Date);
    expect(r?.trackerCheckedAt).toBeNull();
  });

  it("our own throttle timing out on a non-final attempt writes nothing", async () => {
    const s = await labeled();
    useTracking("ok", "easypost");
    vi.mocked(ratelimit.takeToken).mockRejectedValue(new Error("rate limit wait exceeded"));
    await expect(pollAttempt(s.id, 1)).rejects.toThrow("rate limit wait");
    await expect(pollAttempt(s.id, 2)).rejects.toThrow("rate limit wait");
    expect(tracks).toBe(0);
    const r = await row(s.id);
    expect(r?.trackerCheckFailedAt).toBeNull();
    expect(r?.trackerCheckedAt).toBeNull();
  });

  it("the final attempt timing out on our throttle records a failed check; the next pass alerts", async () => {
    const s = await labeled();
    const shipBy = new Date(Date.now() - 10 * 3_600_000);
    await withSystem(async (tx) => {
      await tx.update(orders).set({ shipBy }).where(eq(orders.id, s.orderId));
      await tx.update(orderItems).set({ shipBy }).where(eq(orderItems.orderId, s.orderId));
    });
    useTracking("ok", "easypost");
    vi.mocked(ratelimit.takeToken).mockRejectedValue(new Error("rate limit wait exceeded"));
    await expect(pollAttempt(s.id, 3)).rejects.toThrow("rate limit wait");
    const r = await row(s.id);
    expect(r?.trackerCheckFailedAt).toBeInstanceOf(Date);
    expect(r?.status).toBe("labeled");
    const ctx = tenantContext(companyId, null, "owner");
    await withTenant(companyId, (tx) => generateAlerts(tx, ctx));
    const rows = await withSystem((tx) =>
      tx
        .select()
        .from(alerts)
        .where(
          and(
            eq(alerts.companyId, companyId),
            eq(alerts.dedupeKey, `dispatch_scan_missing:${s.id}:overdue`),
          ),
        ),
    );
    expect(rows).toHaveLength(1);
    const data = (rows[0]?.data ?? {}) as { messageCode?: string };
    expect(data.messageCode).toBe("dispatch_overdue_unconfirmed");
    expect(rows[0]?.severity).toBe("critical");
  });

  it("a shipment that is no longer labeled is skipped without a write", async () => {
    const s = await labeled({ status: "voided" });
    useTracking("ok");
    expect(await poll(s.id)).toEqual({ skipped: true });
    const r = await row(s.id);
    expect(r?.trackerCheckFailedAt).toBeNull();
    expect(r?.trackerCheckedAt).toBeNull();
    expect(tracks).toBe(0);
  });
});

describe("a routed carrier event counts as a successful check", () => {
  it("processCarrierEvent sets trackerCheckedAt even for a pre-transit reading", async () => {
    const s = await labeled();
    const out = await processCarrierEvent({
      eventId: `evt_${Math.random().toString(36).slice(2)}`,
      description: "tracker.updated",
      tracker: {
        trackerId: "trk_evt",
        trackingCode: s.trackingCode as string,
        carrierShipmentId: s.carrierShipmentId,
        status: "pre_transit",
        statusDetail: null,
        occurredAt: new Date().toISOString(),
        deliveredAt: null,
      },
    });
    expect(out.status).toBe("processed");
    const r = await row(s.id);
    expect(r?.status).toBe("labeled");
    expect(r?.trackerCheckedAt).toBeInstanceOf(Date);
  });
});
